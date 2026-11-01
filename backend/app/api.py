import json
import os
from typing import Iterator

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from loguru import logger

from app.config.config_files import OpenAIConfig, SpeechConfig
from app.models.ai_autocomplete_model import AIAutoSuggest
from app.models.ai_edit_model import AIEdit, Tidy
from app.services.ai_autocomplete import stream_autocomplete
from app.services.ai_edit import stream_edit_text
from app.services.llm import Event, effective_level, family_of, model_families, transcribe
from app.services.voice import stream_tidy

# set up logging
logger.add("logs/ai_api.log", rotation="100 MB", level="DEBUG")

app = FastAPI(title="AI API", version="1.0", description="API for AI model")

# Only the editor's own pages may call the API from a browser (otherwise any
# website you visit could read or overwrite your documents). Comma-separated.
CORS_ORIGINS = os.getenv(
    "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in CORS_ORIGINS if o.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def ndjson_stream(events: Iterator[Event], what: str) -> StreamingResponse:
    """Stream events as newline-delimited JSON:
    {"type": "think"|"text", "text": "..."} ... then {"type": "done"},
    or {"type": "error", "text": "..."} if the model call fails mid-stream."""

    def body():
        try:
            for kind, text in events:
                yield json.dumps({"type": kind, "text": text}) + "\n"
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


@app.post("/save_state")
def save_state(editor_state: dict):
    logger.info("Received request to save state")
    os.makedirs("app/data", exist_ok=True)
    try:
        with open("app/data/editor_state.json", "w") as f:
            json.dump(editor_state, f)
    except Exception as e:
        logger.error(f"Error saving state: {e}")
        return {"message": "Error saving state"}


@app.get("/load_state")
def load_state():
    logger.info("Received request to load state")
    if not os.path.exists("app/data/editor_state.json"):
        raise HTTPException(status_code=404, detail="State file does not exist")
    try:
        with open("app/data/editor_state.json", "r") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Error loading state: {e}")
        return {"message": "Error loading state"}
