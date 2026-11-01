"""Hybrid search over blocks: SQLite FTS5 (BM25) + vector similarity, fused
with reciprocal rank fusion. Plus snippet/highlight helpers for the UI."""
from __future__ import annotations

import re
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Callable, Iterable

import numpy as np
from loguru import logger

from typing import TYPE_CHECKING

from app.store.db import Database, chunks
from app.store.vectors import VectorCache

if TYPE_CHECKING:
    from app.store.documents import DocumentStore

RRF_K = 60  # standard constant: dampens the weight of top ranks
CANDIDATES = 60  # per list, before fusion
MIN_SIMILARITY = 0.30  # vector hits below this are noise (qwen3-embedding: unrelated ~0.2-0.26, related 0.33+)
MAX_QUERY_TERMS = 32
WORD_RE = re.compile(r"\w+", re.UNICODE)

STOPWORDS = frozenset(
    """a about above after again against all am an and any are as at be because been before being
    below between both but by can could did do does doing down during each few for from further had
    has have having he her here hers him his how i if in into is it its itself just me more most my
    no nor not now of off on once only or other our ours out over own same she should so some such
    than that the their theirs them then there these they this those through to too under until up
    very was we were what when where which while who whom why will with would you your yours""".split()
)


@dataclass
class Hit:
    block_id: int
    document_key: str
    position: int
    path: list[int]
    kind: str
    heading_path: str
    text: str
    tokens: int
    score: float  # fused, 0..1 (1 = top of both lists)
    keyword_rank: int | None = None  # 1-based rank in the keyword list
    similarity: float | None = None  # cosine similarity, if found by vector search
    terms: list[str] = field(default_factory=list)


def query_terms(query: str) -> list[str]:
    """Distinct lowercase words; stopwords dropped unless that leaves nothing.
    Long queries (e.g. a passage used as the query) keep the longest terms."""
    words = list(OrderedDict.fromkeys(w.lower() for w in WORD_RE.findall(query)))
    terms = [w for w in words if w not in STOPWORDS] or words
    if len(terms) > MAX_QUERY_TERMS:
        keep = set(sorted(terms, key=len, reverse=True)[:MAX_QUERY_TERMS])
        terms = [t for t in terms if t in keep]
    return terms


def fts_query(query: str) -> str | None:
    """FTS5 MATCH expression: any of the terms (BM25 ranks blocks that have
    more of them higher); the last word is a prefix while it's being typed."""
    terms = query_terms(query)
    if not terms:
        return None
    parts = [f'"{t}"' for t in terms]
    last = WORD_RE.findall(query.lower())
    if last and query[-1:].isalnum() and terms[-1] == last[-1] and len(terms[-1]) >= 2:
        parts[-1] += "*"
    return " OR ".join(parts)


_SUFFIXES = ("ational", "ations", "ation", "ings", "ing", "edly", "ies", "ers", "er", "ed", "ly", "es", "s")


def _stem(w: str) -> str:
    w = w.lower()
    for s in _SUFFIXES:
        if len(w) - len(s) >= 3 and w.endswith(s):
            return w[: -len(s)]
    return w


def highlight_spans(text: str, terms: list[str], prefix_last: bool = False) -> list[tuple[int, int]]:
    """Character spans of words in `text` that match the query terms (rough
    stemming, so 'referrals' highlights for 'referral')."""
    if not terms:
        return []
    stems = {_stem(t) for t in terms}
    last = terms[-1].lower() if prefix_last else None
    spans = []
    for m in WORD_RE.finditer(text):
        w = m.group(0).lower()
        if _stem(w) in stems or (last and w.startswith(last)):
            spans.append((m.start(), m.end()))
    return spans


def make_snippet(text: str, terms: list[str], width: int = 240, prefix_last: bool = False) -> tuple[str, list[list[int]]]:
    """A window of `text` around the first cluster of matches, and the
    highlight spans within it (offsets into the returned snippet)."""
    flat = " ".join(text.split())
    spans = highlight_spans(flat, terms, prefix_last)
    if len(flat) <= width:
        return flat, [list(s) for s in spans]
    start = 0
    if spans:
        # start where the most matches fit in the window
        best, best_n = spans[0][0], 0
        for i, (s, _) in enumerate(spans):
            n = sum(1 for t, _ in spans[i:] if t < s + width - 40)
            if n > best_n:
                best, best_n = s, n
        start = max(0, best - 60)
        if start:
            sp = flat.rfind(" ", 0, start + 1)
            start = sp + 1 if sp != -1 and start - sp < 30 else start
    end = min(len(flat), start + width)
    if end < len(flat):
        sp = flat.rfind(" ", start, end)
        end = sp if sp > start + width // 2 else end
    pre = "… " if start > 0 else ""
    post = " …" if end < len(flat) else ""
    snippet = pre + flat[start:end] + post
    off = len(pre) - start
    out = [[s + off, e + off] for s, e in spans if s >= start and e <= end]
    return snippet, out


class QueryEmbedder:
    """Query -> vector, with a small LRU cache (search-as-you-type repeats)."""

    # qwen3-embedding is instruction-aware on the query side only
    INSTRUCTION = "Instruct: Given a search query, retrieve passages of the user's documents that are relevant to it\nQuery: "

    def __init__(self, embed: Callable[[list[str]], list[list[float]]], size: int = 256):
        self.embed = embed
        self.size = size
        self._cache: OrderedDict[str, np.ndarray] = OrderedDict()
        self.failed_until = 0.0  # don't wait on a down server for every keystroke

    def __call__(self, query: str) -> np.ndarray | None:
        q = " ".join(query.split())[-4000:]
        if not q:
            return None
        if q in self._cache:
            self._cache.move_to_end(q)
            return self._cache[q]
        if time.time() < self.failed_until:
            return None
        try:
            vec = np.asarray(self.embed([self.INSTRUCTION + q])[0], dtype=np.float32)
        except Exception as e:
            logger.warning(f"Query embedding failed, keyword search only: {e}")
            self.failed_until = time.time() + 15
            return None
        self._cache[q] = vec
        if len(self._cache) > self.size:
            self._cache.popitem(last=False)
        return vec


class UnknownDocument(KeyError):
    pass


class Searcher:
    """Searches ONE document at a time: every document is its own world, and
    no query ever returns (or scores) blocks of another document."""

    def __init__(self, db: Database, vectors: VectorCache, embed_query: Callable[[str], np.ndarray | None],
                 documents: "DocumentStore"):
        self.db = db
        self.vectors = vectors
        self.embed_query = embed_query
        self.documents = documents  # block order (layout)

    def doc_id(self, document_key: str) -> int:
        row = self.db.conn().execute("SELECT id FROM documents WHERE key = ?", (document_key,)).fetchone()
        if row is None:
            raise UnknownDocument(document_key)
        return row[0]

    def keyword(self, query: str, doc_id: int, k: int, exclude: set[int]) -> list[int]:
        """Block ids of this document, best BM25 first."""
        match = fts_query(query)
        if not match:
            return []
        # heading matches count, but less than the block's own text
        sql = (
            "SELECT f.rowid FROM blocks_fts f JOIN blocks b ON b.id = f.rowid"
            " WHERE blocks_fts MATCH ? AND b.doc_id = ? ORDER BY bm25(blocks_fts, 1.0, 0.4) LIMIT ?"
        )
        try:
            ids = [r[0] for r in self.db.conn().execute(sql, (match, doc_id, k + len(exclude)))]
        except Exception as e:  # malformed MATCH can't happen with quoted terms; be safe anyway
            logger.warning(f"Keyword search failed for {match!r}: {e}")
            return []
        return [i for i in ids if i not in exclude][:k]

    def search(
        self,
        document_key: str,
        query: str,
        k: int = 20,
        exclude_block_ids: Iterable[int] = (),
        semantic: bool = True,
    ) -> tuple[list[Hit], bool]:
        """Ranked hits within one document, and whether vector search took
        part. A document that doesn't exist (yet) has no hits."""
        try:
            doc_id = self.doc_id(document_key)
        except UnknownDocument:
            return [], False
        exclude = set(exclude_block_ids)
        n = max(CANDIDATES, k * 2)

        kw = self.keyword(query, doc_id, n, exclude)
        vec_hits: list[tuple[int, float]] = []
        used_vectors = False
        if semantic and query.strip():
            qv = self.embed_query(query)
            if qv is not None:
                used_vectors = True
                vec_hits = [(i, s) for i, s in self.vectors.search(doc_id, qv, n, exclude) if s >= MIN_SIMILARITY]

        fused: dict[int, float] = {}
        kw_rank: dict[int, int] = {}
        sim: dict[int, float] = {}
        for r, i in enumerate(kw):
            fused[i] = fused.get(i, 0.0) + 1.0 / (RRF_K + r + 1)
            kw_rank[i] = r + 1
        for r, (i, s) in enumerate(vec_hits):
            fused[i] = fused.get(i, 0.0) + 1.0 / (RRF_K + r + 1)
            sim[i] = s
        best = (2 if used_vectors else 1) / (RRF_K + 1)
        top = sorted(fused.items(), key=lambda x: (-x[1], x[0]))[:k]
        rows = self._rows(doc_id, [i for i, _ in top])
        layout = self.documents.layout(doc_id)
        terms = query_terms(query)
        hits = []
        for i, f in top:
            r = rows.get(i)
            pos = layout.position_of.get(i)
            if r is None or pos is None:
                continue  # deleted since the search started
            hits.append(Hit(
                block_id=i, document_key=document_key, position=pos, path=layout.paths[pos],
                kind=r["kind"], heading_path=r["heading"], text=r["text"], tokens=r["tokens"],
                score=round(f / best, 4), keyword_rank=kw_rank.get(i),
                similarity=round(sim[i], 4) if i in sim else None, terms=terms,
            ))
        return hits, used_vectors

    def _rows(self, doc_id: int, ids: list[int]) -> dict[int, dict]:
        out = {}
        for part in chunks(ids):
            for r in self.db.conn().execute(
                "SELECT id, kind, heading, text, tokens FROM blocks"
                f" WHERE doc_id = ? AND id IN ({','.join('?' * len(part))})",
                [doc_id, *part],
            ):
                out[r["id"]] = r
        return out

    def blocks_in_range(self, document_key: str, start: int, end: int) -> list[int]:
        """Ids of a document's blocks with start <= position <= end (e.g. the
        local window around the cursor, to exclude it from retrieval)."""
        try:
            doc_id = self.doc_id(document_key)
        except UnknownDocument:
            return []
        return self.documents.layout(doc_id).ids[max(0, start) : end + 1].tolist()
