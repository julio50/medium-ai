import json
import os
import time
from contextlib import asynccontextmanager
from typing import Iterator

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from loguru import logger

from app.config.config_files import OpenAIConfig, SpeechConfig, StorageConfig
from app.models.ai_autocomplete_model import AIAutoSuggest
from app.models.ai_edit_model import AIEdit, Tidy
from app.models.critique_model import Critique
from app.models.documents_model import DocumentIn, SearchRequest
from app.services.ai_autocomplete import stream_autocomplete
from app.services.ai_edit import stream_edit_text
from app.services.critique import stream_critique
from app.services.llm import Event, effective_level, family_of, model_families, transcribe
from app.services.voice import stream_tidy
from app.store import Library
from app.store.documents import LEGACY_KEY, InvalidKey, StaleWrite, check_key
from app.store.search import make_snippet

# set up logging
logger.add("logs/ai_api.log", rotation="100 MB", level="DEBUG")

_library: Library | None = None


def library() -> Library:
    global _library
    if _library is None:
        _library = Library(StorageConfig.data_dir)
    return _library


def set_library(lib: Library | None) -> None:
    """Use another library (tests)."""
    global _library
    _library = lib


@asynccontextmanager
async def lifespan(app: FastAPI):
    lib = library()  # opens the database; imports the old editor_state.json once
    logger.info(f"Documents and search index: {lib.db.path}")
    lib.start()
    yield
    lib.close()


app = FastAPI(title="AI API", version="1.0", description="API for AI model", lifespan=lifespan)


class BodySizeLimit:
    """413 for request bodies over MAX_REQUEST_MB (checked as they arrive, so
    a chunked upload without Content-Length can't exhaust memory either)."""

    def __init__(self, app, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        length = dict(scope.get("headers") or []).get(b"content-length")
        if length is not None and length.isdigit() and int(length) > self.max_bytes:
            body = json.dumps({"detail": self.message}).encode()
            await send({"type": "http.response.start", "status": 413,
                        "headers": [(b"content-type", b"application/json"),
                                    (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        seen = 0

        async def limited():
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.max_bytes:
                    # FastAPI turns this into the 413 response
                    raise HTTPException(status_code=413, detail=self.message)
            return message

        await self.app(scope, limited, send)

    @property
    def message(self) -> str:
        return f"Request too large (max {self.max_bytes // (1024 * 1024)} MB; set MAX_REQUEST_MB)."


# added before CORS, so CORS wraps it and a 413 still carries CORS headers
app.add_middleware(BodySizeLimit, max_bytes=StorageConfig.max_request_mb * 1024 * 1024)

# Only the editor's own pages may call the API from a browser (otherwise any
# website you visit could read or overwrite your documents). Comma-separated.
CORS_ORIGINS = os.getenv(
    "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in CORS_ORIGINS if o.strip()],
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)


def ndjson_stream(events: Iterator[Event | tuple[str, dict]], what: str) -> StreamingResponse:
    """Stream events as newline-delimited JSON:
    {"type": "think"|"text", "text": "..."} ... then {"type": "done"},
    or {"type": "error", "text": "..."} if the model call fails mid-stream.
    Events with a structured payload, e.g. ("item", {...}), are sent as
    {"type": "item", "data": {...}}."""

    def body():
        try:
            for kind, payload in events:
                key = "text" if isinstance(payload, str) else "data"
                yield json.dumps({"type": kind, key: payload}) + "\n"
            yield json.dumps({"type": "done"}) + "\n"
        except Exception as e:
            logger.error(f"{what} stream failed: {e}")
            yield json.dumps({"type": "error", "text": str(e)}) + "\n"

    # X-Accel-Buffering stops nginx-style proxies from buffering the stream
    return StreamingResponse(
        body(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/models")
def get_models():
    """Model families on the server. `canThink` families have a thinking
    variant (`X`) and a non-thinking one (`X-instruct`); the UI's Thinking
    toggle chooses between them."""
    default = family_of(OpenAIConfig.model)
    try:
        families = model_families()
    except Exception as e:
        logger.error(f"Could not list models from {OpenAIConfig.base_url}: {e}")
        return {"default": default, "models": [{"name": default, "canThink": False}]}
    if default not in families:
        default = OpenAIConfig.model
    return {
        "default": default,
        "models": [{"name": name, "canThink": "single" not in v} for name, v in families.items()],
    }


@app.post("/autocomplete/stream")
def autocomplete_stream(context: AIAutoSuggest):
    return ndjson_stream(
        stream_autocomplete(
            previous_context=context.previousContext,
            current_context=context.currentContext,
            next_context=context.nextContext,
            model_name=context.modelName,
            thinking=effective_level(context.thinking, context.thinkingLevel),
            force=context.force,
        ),
        "autocomplete",
    )


@app.post("/ai_edit/stream")
def ai_edit_stream(ai_edit: AIEdit):
    if not ai_edit.selectedText.strip():
        raise HTTPException(status_code=400, detail="Input text is empty.")
    return ndjson_stream(
        stream_edit_text(
            instruction=ai_edit.instruction,
            selected_text=ai_edit.selectedText,
            temperature=ai_edit.temperature,
            model_name=ai_edit.modelName,
            thinking=effective_level(ai_edit.thinking, ai_edit.thinkingLevel),
        ),
        "ai_edit",
    )


@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """Voice brain-dump, step 1: speech-to-text."""
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=400, detail="Empty recording.")
    try:
        text = transcribe(audio, file.filename or "recording.webm", SpeechConfig.model)
    except Exception as e:
        logger.error(f"Transcription failed: {e}")
        raise HTTPException(status_code=502, detail=f"Transcription failed: {e}")
    return {"text": text}


@app.post("/tidy/stream")
def tidy_stream(req: Tidy):
    """Voice brain-dump, step 2 (optional): transcript -> bullet points."""
    if not req.transcript.strip():
        raise HTTPException(status_code=400, detail="Empty transcript.")
    return ndjson_stream(stream_tidy(req.transcript, req.modelName, effective_level(req.thinking, req.thinkingLevel)), "tidy")


@app.post("/critique/stream")
def critique_stream(req: Critique):
    """Margin comments: review the paragraphs through one lens. Streams
    {"type": "item", "data": {paragraph, quote, comment, suggestion}} per
    comment (`paragraph` indexes `paragraphs`; `quote` is an exact substring of
    it, or "" for the whole paragraph), plus "think" events."""
    if not any(p.strip() for p in req.paragraphs):
        raise HTTPException(status_code=400, detail="The document is empty.")
    if not req.lens.instruction.strip():
        raise HTTPException(status_code=400, detail="The lens needs an instruction.")
    return ndjson_stream(
        stream_critique(
            paragraphs=req.paragraphs,
            lens_name=req.lens.name,
            lens_instruction=req.lens.instruction,
            targets=req.targets,
            model_name=req.modelName,
            thinking=effective_level(req.thinking, req.thinkingLevel),
        ),
        "critique",
    )


# ---------- documents

def _key(key: str) -> str:
    try:
        return check_key(key)
    except InvalidKey as e:
        raise HTTPException(status_code=400, detail=str(e))


def _save(key: str, doc: DocumentIn, force: bool = False) -> dict:
    try:
        res = library().documents.save(key, doc.state, doc.timestamp, doc.version, doc.title, force=force)
    except StaleWrite as e:
        raise HTTPException(status_code=409, detail={"message": str(e), "current": e.current})
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        **res.meta,
        "changes": {"inserted": res.inserted, "edited": res.edited, "moved": res.moved,
                    "deleted": res.deleted, "unchanged": res.unchanged},
    }


def _load(key: str) -> Response:
    found = library().documents.load_raw(key)
    if found is None:
        raise HTTPException(status_code=404, detail="Document not found")
    meta, state_json = found
    # the stored format the editor reads ({version, timestamp, state}) plus metadata;
    # the state is spliced in as-is instead of being parsed and re-serialized
    head = json.dumps({**meta, "timestamp": meta["updatedAt"]})
    return Response(content=head[:-1] + ',"state":' + state_json + "}", media_type="application/json")


@app.get("/documents")
def list_documents(project_id: int | None = None):
    """All documents (metadata only), most recently edited first."""
    return {"documents": library().documents.list(project_id)}


@app.get("/documents/{key}")
def load_document(key: str):
    return _load(_key(key))


@app.put("/documents/{key}")
def save_document(key: str, doc: DocumentIn, force: bool = False):
    """Save a document. 409 if the stored copy is newer than `timestamp`
    (unless `force`); the response's `detail.current` describes it."""
    return _save(_key(key), doc, force)


@app.delete("/documents/{key}")
def delete_document(key: str):
    if not library().documents.delete(_key(key)):
        raise HTTPException(status_code=404, detail="Document not found")
    return {"deleted": key}


# ---------- search

@app.post("/search")
def search(req: SearchRequest):
    """Hybrid (keyword + semantic) search within ONE document. Results never
    come from other documents."""
    started = time.perf_counter()
    hits, semantic = library().searcher.search(_key(req.document_key), req.query, k=req.k, semantic=req.semantic)
    prefix = req.query[-1:].isalnum()
    out = []
    for h in hits:
        snippet, highlights = make_snippet(h.text, h.terms, prefix_last=prefix)
        out.append({
            "blockId": h.block_id, "headingPath": h.heading_path, "kind": h.kind,
            "position": h.position, "path": h.path, "text": h.text[:2000],
            "snippet": snippet, "highlights": highlights, "score": h.score,
            "keywordRank": h.keyword_rank, "similarity": h.similarity,
        })
    return {"documentKey": req.document_key, "query": req.query, "hits": out, "semantic": semantic,
            "tookMs": round((time.perf_counter() - started) * 1000, 1)}


@app.get("/index/status")
def index_status(key: str | None = Query(default=None)):
    """Embedding progress of one document (?key=) or of all of them:
    pendingBlocks > 0 while the index catches up."""
    return library().status(_key(key) if key else None)


# ---------- legacy single-document endpoints (old editor tabs; ?key= picks the document)

@app.post("/save_state")
def save_state(editor_state: dict, key: str | None = Query(default=None)):
    logger.info("Received request to save state")
    try:
        doc = DocumentIn(**editor_state) if "state" in editor_state else DocumentIn(state=editor_state)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Not an editor state: {e}")
    # last writer wins, as before
    return _save(_key(key) if key else LEGACY_KEY, doc, force=True)


@app.get("/load_state")
def load_state(key: str | None = Query(default=None)):
    logger.info("Received request to load state")
    return _load(_key(key) if key else LEGACY_KEY)
