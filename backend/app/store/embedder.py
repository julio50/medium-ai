"""Background embedding worker.

Saves only write blocks; this thread embeds the ones whose content hash has
no embedding yet, in batches, newest blocks first (the document being edited
is searchable soonest). When the AI server is unreachable it backs off and
retries; blocks the server rejects are retried a few times and then skipped.
"""
from __future__ import annotations

import threading
import time
from typing import Callable

import numpy as np
import openai
from loguru import logger

from app.store.db import Database, chunks
from app.store.vectors import VectorCache, normalize, to_blob

EmbedFn = Callable[[list[str]], list[list[float]]]

BATCH_SIZE = 32
QUEUE_SIZE = 4096  # pending blocks fetched per (costly at 100k blocks) pending query
MAX_CHARS = 6000  # per block sent to the model (~1.5k tokens); FTS still has all of it
MAX_ATTEMPTS = 3  # per block the server rejects
BACKOFF_MAX = 120.0
GC_INTERVAL = 300.0

PENDING_SQL = """
    SELECT b.hash, MAX(b.id) AS newest, MIN(b.text) AS text
    FROM blocks b
    WHERE {doc} NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.hash = b.hash)
      AND NOT EXISTS (SELECT 1 FROM embed_failures f WHERE f.hash = b.hash AND f.attempts >= ?)
    GROUP BY b.hash
"""

# errors where waiting helps (server down, restarting, swapping models)
TRANSIENT = (
    openai.APIConnectionError,  # includes timeouts
    openai.InternalServerError,
    openai.RateLimitError,
    openai.NotFoundError,  # llama-swap: model not (yet) configured; keep retrying slowly
    ConnectionError,
    TimeoutError,
)


class Embedder:
    def __init__(self, db: Database, vectors: VectorCache, embed: EmbedFn, model: str):
        self.db = db
        self.vectors = vectors
        self.embed = embed
        self.model = model
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.state = "idle"  # idle | indexing | offline
        self.last_error: str | None = None
        self.retry_at: float | None = None
        self.generation = 0  # bumped whenever embeddings are written (status cache)
        self._queue: list[tuple[str, str]] = []  # (hash, text) known to be pending
        self._last_gc = 0.0
        self._check_model()

    def _check_model(self):
        """Embeddings from another model aren't comparable: drop them."""
        stored = self.db.get_meta("embedding_model")
        if stored is not None and stored != self.model:
            logger.info(f"Embedding model changed ({stored} -> {self.model}): re-indexing all blocks")
            with self.db.write() as c:
                c.execute("DELETE FROM embeddings")
                c.execute("DELETE FROM embed_failures")
                self.db.set_meta("embedding_model", self.model, c)
                self.vectors.reset()
        elif stored is None:
            self.db.set_meta("embedding_model", self.model)

    # ---------- thread control

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="embedder", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0):
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout)

    def wake(self):
        """Blocks were added or edited: their document is being worked on, so
        put them ahead of an older backlog."""
        self.requeue()
        self._wake.set()

    # ---------- work

    def pending_count(self, doc_id: int | None = None) -> int:
        """Distinct block contents still waiting for an embedding."""
        if doc_id is None:
            sql, args = PENDING_SQL.format(doc=""), (MAX_ATTEMPTS,)
        else:
            sql, args = PENDING_SQL.format(doc="b.doc_id = ? AND"), (doc_id, MAX_ATTEMPTS)
        return self.db.conn().execute(f"SELECT COUNT(*) FROM ({sql})", args).fetchone()[0]

    def run_once(self, batch_size: int = BATCH_SIZE) -> int:
        """Embed one batch of pending blocks. Returns how many hashes got an
        embedding (0 = nothing pending). Transient server errors propagate
        (the batch stays queued)."""
        if not self._queue:
            rows = self.db.conn().execute(
                PENDING_SQL.format(doc="") + " ORDER BY newest DESC LIMIT ?", (MAX_ATTEMPTS, QUEUE_SIZE)
            ).fetchall()
            self._queue = [(r["hash"], r["text"][:MAX_CHARS]) for r in rows]
            if not self._queue:
                return 0
        items = self._queue[:batch_size]
        # a queued block may have been edited away since; embedding it anyway is
        # harmless (GC drops unused embeddings) and cheaper than re-checking
        done = self._embed_items(items)
        del self._queue[: len(items)]
        self._store(done)
        return max(len(done), 1 if items else 0)

    def requeue(self):
        """Forget the queue (new blocks were saved: fetch the newest first)."""
        self._queue = []

    def _embed_items(self, items: list[tuple[str, str]]) -> dict[str, np.ndarray]:
        try:
            vecs = self.embed([t for _, t in items])
        except TRANSIENT:
            raise
        except Exception as e:
            if len(items) > 1:  # find the block the server rejects
                out: dict[str, np.ndarray] = {}
                for it in items:
                    out.update(self._embed_items([it]))
                return out
            self._record_failure(items[0][0], e)
            return {}
        if len(vecs) != len(items):
            raise RuntimeError(f"Embedding server returned {len(vecs)} vectors for {len(items)} inputs")
        return {h: normalize(v) for (h, _), v in zip(items, vecs)}

    def _record_failure(self, h: str, e: Exception):
        logger.warning(f"Embedding rejected for block {h[:8]}: {e}")
        with self.db.write() as c:
            c.execute(
                "INSERT INTO embed_failures(hash, attempts, error, at) VALUES (?, 1, ?, ?)"
                " ON CONFLICT(hash) DO UPDATE SET attempts = attempts + 1, error = excluded.error, at = excluded.at",
                (h, str(e)[:500], int(time.time() * 1000)),
            )
            self.generation += 1

    def _store(self, done: dict[str, np.ndarray]):
        if not done:
            return
        with self.db.write() as c:
            c.executemany(
                "INSERT OR REPLACE INTO embeddings(hash, vec) VALUES (?, ?)",
                [(h, to_blob(v)) for h, v in done.items()],
            )
            hashes = list(done)
            for part in chunks(hashes):
                c.execute(f"DELETE FROM embed_failures WHERE hash IN ({','.join('?' * len(part))})", part)
            # blocks that now have a vector (still under the writer lock)
            rows = []
            for part in chunks(hashes):
                rows += c.execute(
                    f"SELECT id, doc_id, hash FROM blocks WHERE hash IN ({','.join('?' * len(part))})", part
                ).fetchall()
            self.vectors.put((r["id"], r["doc_id"], done[r["hash"]]) for r in rows)
            self.generation += 1

    def gc(self) -> int:
        """Drop embeddings no block uses any more."""
        with self.db.write() as c:
            n = c.execute("DELETE FROM embeddings WHERE hash NOT IN (SELECT hash FROM blocks)").rowcount
            c.execute("DELETE FROM embed_failures WHERE hash NOT IN (SELECT hash FROM blocks)")
        self._last_gc = time.time()
        return n

    def _loop(self):
        backoff = 2.0
        while not self._stop.is_set():
            try:
                n = self.run_once()
            except Exception as e:
                self.state = "offline"
                self.last_error = f"{type(e).__name__}: {e}"[:300]
                self.retry_at = time.time() + backoff
                logger.warning(f"Embedding server unavailable ({self.last_error}); retrying in {backoff:.0f}s")
                self._wake.wait(backoff)
                self._wake.clear()
                backoff = min(backoff * 2, BACKOFF_MAX)
                continue
            backoff = 2.0
            self.retry_at = None
            if n:
                self.state = "indexing"
                self.last_error = None
                continue
            self.state = "idle"
            if time.time() - self._last_gc > GC_INTERVAL:
                try:
                    self.gc()
                except Exception as e:
                    logger.warning(f"Embedding GC failed: {e}")
            self._wake.wait(60)
            self._wake.clear()
