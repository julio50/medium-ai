"""Per-document in-memory matrices of block embeddings for exact
(brute-force) vector search.

Every document is its own world: a search only ever scores the blocks of
the one document it is about, so each document gets its own matrix.

Why not sqlite-vec: it installs fine, but its brute-force KNN measured ~180 ms
per query at 100k x 1024-dim blocks, versus ~30 ms for one numpy float32
matmul over the same rows. Vectors are stored as float16 in SQLite (half the
size on disk) and kept as float32 here (~4 KB per block: ~400 MB for a
100k-block document).

A document's matrix is loaded on its first search and then kept in sync by
the writers (document saves, the embedding worker), which call put/remove
while holding the database writer lock. Least recently searched documents
are dropped from memory past `max_bytes` (reloaded on demand). Rows of
removed blocks are tombstoned and compacted once they're a quarter of the
matrix.
"""
from __future__ import annotations

import threading
import time
from typing import Iterable

import numpy as np

from app.store.db import Database

GROWTH = 1.5


def to_blob(vec: np.ndarray) -> bytes:
    return np.asarray(vec, dtype=np.float16).tobytes()


def normalize(vec) -> np.ndarray:
    v = np.asarray(vec, dtype=np.float32).reshape(-1)
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


class DocMatrix:
    """The embedded blocks of one document."""

    def __init__(self, capacity: int = 0, dim: int = 0):
        self.dim = dim
        self.mat = np.zeros((capacity, dim), dtype=np.float32)
        self.ids = np.zeros(capacity, dtype=np.int64)
        self.alive = np.zeros(capacity, dtype=bool)
        self.n = 0  # rows in use (alive or tombstoned)
        self.dead = 0
        self.row_of: dict[int, int] = {}
        self.used_at = time.monotonic()

    @property
    def nbytes(self) -> int:
        return self.mat.nbytes + self.ids.nbytes + self.alive.nbytes

    def __len__(self) -> int:
        return len(self.row_of)

    def append(self, ids: np.ndarray, vecs: np.ndarray):
        m = len(ids)
        if m == 0:
            return
        if self.dim == 0:
            self.dim = vecs.shape[1]
            self.mat = np.zeros((len(self.ids), self.dim), dtype=np.float32)
        if self.n + m > len(self.ids):
            self._grow(max(int(len(self.ids) * GROWTH), self.n + m, 64))
        s = slice(self.n, self.n + m)
        self.mat[s] = vecs
        self.ids[s] = ids
        self.alive[s] = True
        for k, i in enumerate(ids.tolist()):
            self.row_of[i] = self.n + k
        self.n += m

    def _grow(self, capacity: int):
        mat = np.zeros((capacity, self.dim), dtype=np.float32)
        mat[: self.n] = self.mat[: self.n]
        self.mat = mat
        for name in ("ids", "alive"):
            old = getattr(self, name)
            new = np.zeros(capacity, dtype=old.dtype)
            new[: self.n] = old[: self.n]
            setattr(self, name, new)

    def put(self, items: list[tuple[int, np.ndarray]]):
        new_ids, new_vecs = [], []
        for block_id, v in items:
            if self.dim and v.shape[0] != self.dim:
                continue  # stale vector from another model: re-embedded later
            row = self.row_of.get(block_id)
            if row is not None:
                self.mat[row] = v
            else:
                new_ids.append(block_id)
                new_vecs.append(v)
        if new_ids:
            self.append(np.array(new_ids, dtype=np.int64), np.stack(new_vecs))

    def remove(self, block_ids: Iterable[int]):
        for i in block_ids:
            row = self.row_of.pop(i, None)
            if row is not None:
                self.alive[row] = False
                self.dead += 1
        if self.dead >= 1024 and self.dead * 4 >= self.n:
            keep = np.flatnonzero(self.alive[: self.n])
            ids, mat = self.ids[keep], self.mat[keep]
            self.__init__(int(len(keep) * 1.1) + 64, self.dim)
            self.append(ids, mat)

    def search(self, q: np.ndarray, k: int, exclude_ids: Iterable[int]) -> list[tuple[int, float]]:
        self.used_at = time.monotonic()
        if not self.row_of or k <= 0 or q.shape[0] != self.dim:
            return []
        n = self.n
        scores = self.mat[:n] @ q
        dead = ~self.alive[:n]
        for i in exclude_ids:
            row = self.row_of.get(i)
            if row is not None:
                dead[row] = True
        scores[dead] = -np.inf
        k = min(k, len(self.row_of))
        top = np.argpartition(-scores, k - 1)[:k]
        top = top[np.argsort(-scores[top])]
        return [(int(self.ids[t]), float(scores[t])) for t in top if np.isfinite(scores[t])]


class VectorCache:
    def __init__(self, db: Database, max_bytes: int = 2 * 1024**3):
        self.db = db
        self.max_bytes = max_bytes
        self._lock = threading.RLock()
        self._docs: dict[int, DocMatrix] = {}

    def _load(self, doc_id: int) -> DocMatrix:
        """Called with the db writer lock held, so no write lands mid-snapshot."""
        conn = self.db.conn()
        total = conn.execute(
            "SELECT COUNT(*) FROM blocks b JOIN embeddings e ON e.hash = b.hash WHERE b.doc_id = ?", (doc_id,)
        ).fetchone()[0]
        m = DocMatrix(int(total * 1.1) + 64)
        cur = conn.execute(
            "SELECT b.id, e.vec FROM blocks b JOIN embeddings e ON e.hash = b.hash WHERE b.doc_id = ?", (doc_id,)
        )
        while rows := cur.fetchmany(4096):
            vecs = np.frombuffer(b"".join(r[1] for r in rows), dtype=np.float16)
            dim = len(rows[0][1]) // 2
            ok = len(vecs) == dim * len(rows)  # mixed dims can't happen after a model reset; be safe
            if ok:
                ids = np.fromiter((r[0] for r in rows), dtype=np.int64, count=len(rows))
                m.append(ids, vecs.reshape(len(rows), dim).astype(np.float32))
            else:
                m.put([(r[0], np.frombuffer(r[1], dtype=np.float16).astype(np.float32)) for r in rows])
        return m

    def get(self, doc_id: int) -> DocMatrix:
        with self._lock:
            m = self._docs.get(doc_id)
            if m is not None:
                return m
        with self.db.lock, self._lock:
            m = self._docs.get(doc_id)
            if m is None:
                m = self._docs[doc_id] = self._load(doc_id)
                self._evict(keep=doc_id)
            return m

    def _evict(self, keep: int):
        total = sum(m.nbytes for m in self._docs.values())
        for doc_id, m in sorted(self._docs.items(), key=lambda x: x[1].used_at):
            if total <= self.max_bytes:
                break
            if doc_id != keep:
                total -= m.nbytes
                del self._docs[doc_id]

    def loaded(self, doc_id: int) -> bool:
        return doc_id in self._docs

    def reset(self) -> None:
        """Forget everything (e.g. the embedding model changed)."""
        with self._lock:
            self._docs.clear()

    # ---------- mutation (callers hold the db writer lock). Unloaded
    # documents are skipped: their next load reads the database.

    def put(self, items: Iterable[tuple[int, int, bytes | np.ndarray]]) -> None:
        """Add or replace (block_id, doc_id, vector) rows."""
        with self._lock:
            by_doc: dict[int, list] = {}
            for block_id, doc_id, vec in items:
                if doc_id in self._docs:
                    v = np.frombuffer(vec, dtype=np.float16) if isinstance(vec, bytes) else vec
                    by_doc.setdefault(doc_id, []).append((block_id, np.asarray(v, dtype=np.float32)))
            for doc_id, rows in by_doc.items():
                self._docs[doc_id].put(rows)

    def remove(self, doc_id: int, block_ids: Iterable[int]) -> None:
        with self._lock:
            m = self._docs.get(doc_id)
            if m is not None:
                m.remove(block_ids)

    def drop_doc(self, doc_id: int) -> None:
        with self._lock:
            self._docs.pop(doc_id, None)

    # ---------- search

    def count(self, doc_id: int) -> int:
        return len(self.get(doc_id))

    def search(self, doc_id: int, query: np.ndarray, k: int, exclude_ids: Iterable[int] = ()) -> list[tuple[int, float]]:
        """Top-k (block_id, cosine similarity) among this document's blocks, best first."""
        m = self.get(doc_id)
        with self._lock:
            return m.search(normalize(query), k, exclude_ids)
