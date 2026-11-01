"""Token-budgeted retrieval for the AI context packer.

    passages = retrieve(library, "doc-key", "how do referrals work",
                        exclude_block_ids=local_window_ids, token_budget=4000)

Retrieval is always within one document (each document is its own world).
Adjacent hits (or ones next to an already chosen passage) merge into one
passage, so the packer never receives the same text twice and gets readable
runs instead of fragments.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Iterable

from app.services.llm import estimate_tokens
from app.store.search import Hit

if TYPE_CHECKING:
    from app.store import Library

# a passage costs its text plus a header line (its heading path, "Chapter 3 › Referrals")
HEADER_OVERHEAD = 4
MIN_USEFUL_TOKENS = 24  # don't pad the budget with scraps
TRUNCATE_MARK = " […]"


@dataclass
class Passage:
    document_key: str
    heading_path: str  # of the first block
    start_position: int
    end_position: int  # inclusive
    block_ids: list[int]
    text: str  # blocks joined by blank lines
    tokens: int  # estimated, including the header
    score: float  # best fused score of its blocks
    truncated: bool = False
    _hits: list[Hit] = field(default_factory=list, repr=False)

    @property
    def header(self) -> str:
        return self.heading_path


def _passage(hits: list[Hit]) -> Passage:
    hits = sorted(hits, key=lambda h: h.position)
    text = "\n\n".join(h.text for h in hits)
    p = Passage(
        document_key=hits[0].document_key, heading_path=hits[0].heading_path, start_position=hits[0].position, end_position=hits[-1].position,
        block_ids=[h.block_id for h in hits], text=text, tokens=0,
        score=max(h.score for h in hits), _hits=hits,
    )
    p.tokens = estimate_tokens(p.text) + estimate_tokens(p.header) + HEADER_OVERHEAD
    return p


def merge_adjacent(hits: list[Hit], gap: int = 1) -> list[Passage]:
    """Group hits (of one document) whose positions are at most `gap` apart
    into passages, best score first."""
    if not hits:
        return []
    unique = sorted({h.block_id: h for h in hits}.values(), key=lambda h: h.position)
    passages = []
    run = [unique[0]]
    for h in unique[1:]:
        if h.position - run[-1].position <= gap:
            run.append(h)
        else:
            passages.append(_passage(run))
            run = [h]
    passages.append(_passage(run))
    passages.sort(key=lambda p: (-p.score, p.start_position))
    return passages


def _truncate(p: Passage, budget: int) -> Passage | None:
    room = budget - estimate_tokens(p.header) - HEADER_OVERHEAD
    if room < MIN_USEFUL_TOKENS:
        return None
    cut = p.text[: room * 4 - len(TRUNCATE_MARK)]
    sp = cut.rfind(" ")
    cut = (cut[:sp] if sp > len(cut) // 2 else cut).rstrip() + TRUNCATE_MARK
    t = Passage(**{**p.__dict__, "text": cut, "truncated": True})
    t.tokens = estimate_tokens(cut) + estimate_tokens(p.header) + HEADER_OVERHEAD
    return t


def retrieve(
    library: "Library",
    document_key: str,
    query_text: str,
    exclude_block_ids: Iterable[int] = (),
    token_budget: int = 4000,
    *,
    candidates: int = 40,
    semantic: bool = True,
) -> list[Passage]:
    """Passages of `document_key` relevant to `query_text` that fit in `token_budget` (estimated
    tokens, headers included), best first. Excluded blocks (e.g. the local
    window the packer already includes) never appear. A passage that doesn't
    fit is split into its blocks; only the single best block is ever
    truncated, and only when nothing else fits."""
    if token_budget <= 0 or not query_text.strip():
        return []
    hits, _ = library.searcher.search(document_key, query_text, k=candidates,
                                      exclude_block_ids=exclude_block_ids, semantic=semantic)
    if not hits:
        return []
    chosen: list[Passage] = []
    used = 0
    for p in merge_adjacent(hits):
        if token_budget - used < MIN_USEFUL_TOKENS:
            break
        if used + p.tokens <= token_budget:
            chosen.append(p)
            used += p.tokens
            continue
        # too big: keep its best blocks that fit
        for h in sorted(p._hits, key=lambda h: -h.score):
            single = _passage([h])
            if used + single.tokens <= token_budget:
                chosen.append(single)
                used += single.tokens
    if not chosen:  # even the best block alone is too long: truncate it
        t = _truncate(_passage([hits[0]]), token_budget)
        return [t] if t else []
    # blocks taken one by one from a split passage may be adjacent again
    return _remerge(chosen)


def _remerge(chosen: list[Passage]) -> list[Passage]:
    out: list[Passage] = []
    for p in chosen:
        for q in out:
            if (not q.truncated and not p.truncated
                    and (p.start_position - q.end_position == 1 or q.start_position - p.end_position == 1)):
                merged = _passage(q._hits + p._hits)
                merged.score = max(p.score, q.score)
                out[out.index(q)] = merged
                break
        else:
            out.append(p)
    return out
