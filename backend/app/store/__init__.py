"""Document store + hybrid search index.

    library = Library(data_dir)            # opens/creates library.sqlite3, imports the old file
    library.start()                        # background embedding worker
    library.documents.save(key, state, timestamp)
    hits, semantic = library.searcher.search("doc-key", "query", k=20)
    passages = library.retrieve("doc-key", "query", exclude_block_ids=[...], token_budget=4000)

Search and retrieval are always scoped to one document: each document is its
own world (and may itself be several books long).

Single-process: the in-memory vector matrix is kept in sync by this
process's writers, so run the backend with one worker.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Iterable

from app.store.db import Database
from app.store.documents import DocumentStore
from app.store.embedder import MAX_ATTEMPTS, Embedder, EmbedFn
from app.store.retrieve import Passage, retrieve
from app.store.search import QueryEmbedder, Searcher
from app.store.vectors import VectorCache

DB_FILE = "library.sqlite3"

__all__ = ["Library", "Passage"]


def default_embed_fn(model: str, timeout: float = 60.0) -> EmbedFn:
    from app.services.llm import embed_texts

    return lambda texts: embed_texts(texts, model, timeout=timeout)


class Library:
    def __init__(
        self,
        data_dir: Path,
        embed: EmbedFn | None = None,
        embed_query: EmbedFn | None = None,
        model: str | None = None,
        import_legacy: bool = True,
    ):
        """`embed` embeds documents' blocks (worker, generous timeout);
        `embed_query` embeds search queries (short timeout). Both default to
        the configured embedding model on the AI server."""
        from app.config.config_files import EmbeddingConfig

        self.data_dir = Path(data_dir)
        self.model = model or EmbeddingConfig.model
        self.db = Database(self.data_dir / DB_FILE)
        self.vectors = VectorCache(self.db)
        self.embedder = Embedder(self.db, self.vectors, embed or default_embed_fn(self.model), self.model)
        self.documents = DocumentStore(self.db, self.vectors, on_change=self.embedder.wake)
        self.searcher = Searcher(
            self.db, self.vectors, QueryEmbedder(embed_query or embed or default_embed_fn(self.model, timeout=5.0)),
            self.documents,
        )
        self._status_cache: dict[str | None, tuple[tuple[int, int], tuple[int, int, int]]] = {}
        if import_legacy:
            self.documents.import_legacy_file(self.data_dir)

    def start(self) -> None:
        self.embedder.start()

    def close(self) -> None:
        self.embedder.stop()
        self.db.close()

    def retrieve(
        self,
        document_key: str,
        query_text: str,
        exclude_block_ids: Iterable[int] = (),
        token_budget: int = 4000,
        **kw,
    ) -> list[Passage]:
        return retrieve(self, document_key, query_text, exclude_block_ids, token_budget, **kw)

    def status(self, document_key: str | None = None) -> dict:
        """Index status for the UI ("indexing… N blocks left"): of one
        document, or of everything when no key is given. The counts are
        cached until the next write (they cost ~0.2 s at 100k blocks)."""
        now = time.time()
        e = self.embedder
        gen = (self.documents.generation, e.generation)
        cached = self._status_cache.get(document_key)
        if cached and cached[0] == gen:
            counts = cached[1]
        else:
            counts = self._status_cache[document_key] = (gen, self._counts(document_key))
            counts = counts[1]
        blocks, pending, failed = counts
        state = e.state
        if pending and state == "idle":
            state = "indexing"  # woken, about to start
        return {
            "documentKey": document_key,
            "blocks": blocks,
            "pendingBlocks": pending,
            "failedBlocks": failed,
            "state": state,  # idle | indexing | offline
            "lastError": e.last_error,
            "retryInSeconds": max(0, round(e.retry_at - now)) if e.retry_at else None,
            "model": self.model,
        }

    def _counts(self, document_key: str | None) -> tuple[int, int, int]:
        c = self.db.conn()
        doc_id = self.documents.doc_id(document_key) if document_key else None
        if document_key and doc_id is None:
            blocks = pending = failed = 0
        else:
            where, args = ("WHERE doc_id = ?", (doc_id,)) if doc_id else ("", ())
            blocks = c.execute(f"SELECT COUNT(*) FROM blocks {where}", args).fetchone()[0]
            pending = self.embedder.pending_count(doc_id)
            failed = c.execute(
                "SELECT COUNT(DISTINCT f.hash) FROM embed_failures f JOIN blocks b ON b.hash = f.hash"
                f" WHERE f.attempts >= ? {'AND b.doc_id = ?' if doc_id else ''}",
                (MAX_ATTEMPTS, *args),
            ).fetchone()[0]
        return blocks, pending, failed
