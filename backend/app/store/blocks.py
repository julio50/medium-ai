"""Lexical JSON -> searchable blocks, and block identity across edits.

A block is one unit of text the index and the AI context packer work with:
a paragraph, heading, list item, quote or code block. Lists are flattened
into their items (nested lists too). Blocks carry their order in the
document, their `path` (child indices from the root, so the editor can find
the node again) and their heading path ("Chapter 3 › Referrals").

Identity: `match_blocks` maps the new blocks of a save onto the stored ones
so unchanged blocks keep their id (and their embedding) no matter what was
edited elsewhere. See its docstring.
"""
from __future__ import annotations

import difflib
import hashlib
from dataclasses import dataclass, field
from typing import Any

from app.services.llm import estimate_tokens

HEADING_SEPARATOR = " › "
# the kinds of node that become blocks
BLOCK_TYPES = {"paragraph", "heading", "quote", "code", "listitem"}
# inline nodes that are never document text
SKIP_INLINE = {"autocomplete", "image"}


@dataclass
class Block:
    position: int  # order in the document (0..n-1, empty blocks are skipped)
    path: list[int]  # child indices from the root to the node
    kind: str  # paragraph | heading | listitem | quote | code
    level: int | None  # heading level (1-6)
    heading_path: list[str]  # enclosing headings, outermost first
    text: str
    hash: str = field(init=False)
    tokens: int = field(init=False)

    def __post_init__(self):
        self.hash = content_hash(self.kind, self.text)
        self.tokens = estimate_tokens(self.text)

    @property
    def heading(self) -> str:
        return HEADING_SEPARATOR.join(self.heading_path)


def content_hash(kind: str, text: str) -> str:
    return hashlib.blake2b(f"{kind}\x00{text}".encode(), digest_size=16).hexdigest()


def inline_text(node: dict[str, Any]) -> str:
    """Plain text of a block's inline content (nested lists excluded)."""
    parts: list[str] = []

    def walk(n: dict[str, Any]):
        t = n.get("type")
        if t in SKIP_INLINE:
            return
        if t in ("text", "code-highlight"):
            parts.append(str(n.get("text", "")))
        elif t == "linebreak":
            parts.append("\n")
        elif t == "tab":
            parts.append("\t")
        elif t == "equation":
            parts.append(f"${n.get('equation', '')}$")
        elif t == "list":
            return  # a nested list's items are blocks of their own
        for c in n.get("children") or ():
            if isinstance(c, dict):
                walk(c)

    for c in node.get("children") or ():
        if isinstance(c, dict):
            walk(c)
    return "".join(parts).strip()


def _heading_level(node: dict[str, Any]) -> int:
    tag = str(node.get("tag") or "h1")
    return int(tag[1]) if len(tag) == 2 and tag[1].isdigit() else 1


def extract_blocks(state: dict[str, Any]) -> list[Block]:
    """Blocks of a serialized Lexical editor state, in document order.
    Empty blocks are skipped (they carry nothing to search or retrieve)."""
    root = state.get("root") if isinstance(state, dict) else None
    if not isinstance(root, dict):
        return []
    blocks: list[Block] = []
    headings: list[tuple[int, str]] = []  # (level, text) of the open headings

    def visit(node: dict[str, Any], path: list[int]):
        t = node.get("type")
        if t == "list":
            for i, item in enumerate(node.get("children") or ()):
                if isinstance(item, dict):
                    visit(item, path + [i])
            return
        if t == "listitem":
            text = inline_text(node)
            if text:
                add(path, "listitem", None, text)
            for i, c in enumerate(node.get("children") or ()):
                if isinstance(c, dict) and c.get("type") == "list":
                    visit(c, path + [i])
            return
        if t not in BLOCK_TYPES:
            return  # images, dividers, equations on their own line, unknown nodes
        text = inline_text(node)
        if not text:
            return
        if t == "heading":
            level = _heading_level(node)
            while headings and headings[-1][0] >= level:
                headings.pop()
            add(path, "heading", level, text)
            headings.append((level, " ".join(text.split())))
        else:
            add(path, t, None, text)

    def add(path: list[int], kind: str, level: int | None, text: str):
        blocks.append(Block(len(blocks), path, kind, level, [h for _, h in headings], text))

    for i, child in enumerate(root.get("children") or ()):
        if isinstance(child, dict):
            visit(child, [i])
    return blocks


def derive_title(blocks: list[Block], max_len: int = 80) -> str:
    """First heading, else the first line of text."""
    source = next((b for b in blocks if b.kind == "heading"), blocks[0] if blocks else None)
    if source is None:
        return "Untitled"
    line = " ".join(source.text.split("\n", 1)[0].split())
    return line if len(line) <= max_len else line[: max_len - 1].rstrip() + "…"


@dataclass
class OldBlock:
    id: int
    hash: str


def match_blocks(old: list[OldBlock], new: list[Block]) -> list[int | None]:
    """For each new block, the id of the stored block it continues (None = new).

    1. Unchanged runs (same content hash, in order) keep their ids. A common
       prefix/suffix is matched first, so a local edit in a book costs only a
       diff of the edited region.
    2. In a replaced region, blocks pair up in order: an edited paragraph keeps
       its id (its text, hash and embedding change).
    3. Blocks moved elsewhere (same hash, unmatched) keep their id.
    Each old id is used at most once; unmatched old blocks are deleted.
    """
    result: list[int | None] = [None] * len(new)
    used: set[int] = set()
    a = [o.hash for o in old]
    b = [n.hash for n in new]

    lo = 0
    while lo < len(a) and lo < len(b) and a[lo] == b[lo]:
        lo += 1
    hi_a, hi_b = len(a), len(b)
    while hi_a > lo and hi_b > lo and a[hi_a - 1] == b[hi_b - 1]:
        hi_a, hi_b = hi_a - 1, hi_b - 1

    def take(i_old: int, i_new: int):
        result[i_new] = old[i_old].id
        used.add(old[i_old].id)

    for i in range(lo):
        take(i, i)
    for k in range(len(a) - hi_a):
        take(hi_a + k, hi_b + k)

    pending: list[tuple[int, int, int, int]] = []  # replaced regions
    sm = difflib.SequenceMatcher(None, a[lo:hi_a], b[lo:hi_b], autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        i1, i2, j1, j2 = i1 + lo, i2 + lo, j1 + lo, j2 + lo
        if tag == "equal":
            for k in range(i2 - i1):
                take(i1 + k, j1 + k)
        elif tag == "replace":
            pending.append((i1, i2, j1, j2))
        elif tag == "insert":
            pending.append((i1, i1, j1, j2))
        else:  # delete
            pending.append((i1, i2, j1, j1))

    # moved blocks: identical content anywhere among the unmatched old ones
    free_by_hash: dict[str, list[int]] = {}
    for i_old, o in enumerate(old):
        if o.id not in used:
            free_by_hash.setdefault(o.hash, []).append(i_old)
    for _, _, j1, j2 in pending:
        for j in range(j1, j2):
            cands = free_by_hash.get(b[j])
            while cands and old[cands[0]].id in used:
                cands.pop(0)
            if cands:
                take(cands.pop(0), j)

    # edited in place: pair what's left of each region in order
    for i1, i2, j1, j2 in pending:
        olds = [i for i in range(i1, i2) if old[i].id not in used]
        news = [j for j in range(j1, j2) if result[j] is None]
        for i_old, j in zip(olds, news):
            take(i_old, j)
    return result
