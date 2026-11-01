"""Margin comments through a "lens" (devil's advocate, skeptical customer, ...).

The service is lens-agnostic: the lens name and instruction arrive as data.
The model answers with {"comments": [...]} (JSON schema enforced); each comment
is yielded as an ("item", {...}) event as soon as its object is complete, so
cards can appear in the margin while the rest are still being written.
"""
from __future__ import annotations

import re
from typing import Iterator, Literal, Tuple, Union

from app.services.json_stream import JsonStream
from app.services.llm import obj_schema, resolve_model, stream_chat

# ("think", reasoning) or ("item", comment dict)
CritiqueEvent = Tuple[Literal["think", "item"], Union[str, dict]]

FIELDS = ("paragraph", "quote", "comment", "suggestion")

SCHEMA = obj_schema(
    comments={
        "type": "array",
        "items": obj_schema(
            paragraph={"type": "integer"},
            quote={"type": "string"},
            comment={"type": "string"},
            suggestion={"type": "string"},
        ),
    }
)

SYSTEM_PROMPT = """You review a writer's draft through ONE lens and leave margin comments, like a sharp human reviewer.

Lens: {name}
What this lens looks for: {instruction}

Rules:
- Comment only where this lens has something genuinely worth saying. Fewer, stronger comments beat many weak ones. If nothing is worth flagging, return an empty list.
- Stay strictly in this lens; ignore other kinds of issues.
- Each comment is about one specific spot. `paragraph` is the paragraph's number (the [n] before it). `quote` is a short excerpt copied EXACTLY, character for character, from that paragraph: the phrase or sentence the comment is about (not the whole paragraph, no "..." and no added quotation marks).
- `comment` makes your point to the writer in 1-3 plain sentences. `suggestion` says concretely how to address it (what to add, cut or change), or is "" when the lens doesn't call for a fix. Don't rewrite the whole paragraph.
- Order comments by paragraph. Write in the language of the draft."""


def build_messages(
    paragraphs: list[str], targets: list[int], lens_name: str, lens_instruction: str
) -> list[dict]:
    numbered = "\n\n".join(f"[{i + 1}] {p}" for i, p in enumerate(paragraphs))
    if len(targets) == len(paragraphs):
        scope = "Comment on any paragraph."
    else:
        scope = (
            "Comment ONLY on paragraphs "
            + ", ".join(str(i + 1) for i in targets)
            + ". The other paragraphs are context."
        )
    return [
        {
            "role": "system",
            "content": SYSTEM_PROMPT.format(
                name=lens_name.strip() or "Reviewer",
                instruction=lens_instruction.strip() or "Anything a careful reader would flag.",
            ),
        },
        {"role": "user", "content": f"Draft:\n\n{numbered}\n\n{scope}"},
    ]


# --- quote validation -------------------------------------------------------

_TRANSLATE = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"',
                            "–": "-", "—": "-", " ": " "})
_ELLIPSIS = re.compile(r"\s*(?:\.\.\.|…)\s*")
_WRAP = "\"'“”‘’«»` "


def _normalize(text: str) -> tuple[str, list[int]]:
    """Lowercase, unify quotes/dashes and collapse whitespace; also return the
    original index of every normalized character."""
    out, idx = [], []
    prev_space = False
    for i, ch in enumerate(text.translate(_TRANSLATE)):
        if ch.isspace():
            if prev_space:
                continue
            ch, prev_space = " ", True
        else:
            prev_space = False
        out.append(ch.lower())
        idx.append(i)
    return "".join(out), idx


def _fuzzy_find(paragraph: str, quote: str, start: int = 0) -> tuple[int, int] | None:
    """(start, end) in `paragraph` of `quote`, ignoring case, quote style and
    whitespace differences."""
    norm_p, idx = _normalize(paragraph)
    norm_q, _ = _normalize(quote.strip())
    if not norm_q:
        return None
    norm_start = next((k for k, i in enumerate(idx) if i >= start), len(idx))
    k = norm_p.find(norm_q, norm_start)
    if k == -1:
        return None
    return idx[k], idx[k + len(norm_q) - 1] + 1


def match_quote(paragraph: str, quote: str) -> str:
    """The exact substring of `paragraph` the model meant by `quote`, or ""
    (meaning: the comment is about the whole paragraph) if it can't be found."""
    if not quote.strip():
        return ""
    if quote in paragraph:
        return quote
    trimmed = quote.strip(_WRAP)
    if trimmed and trimmed in paragraph:
        return trimmed
    found = _fuzzy_find(paragraph, trimmed)
    if found:
        return paragraph[found[0]:found[1]]
    # "first part ... last part": span from the first piece to the last
    parts = [p for p in _ELLIPSIS.split(trimmed) if p.strip(_WRAP)]
    if len(parts) > 1:
        first = _fuzzy_find(paragraph, parts[0].strip(_WRAP))
        last = first and _fuzzy_find(paragraph, parts[-1].strip(_WRAP), first[1])
        if first and last:
            return paragraph[first[0]:last[1]]
    return ""


def clean_comment(raw: dict, paragraphs: list[str], targets: set[int]) -> dict | None:
    """Validate one model comment. `raw["paragraph"]` is 1-based (as numbered in
    the prompt); the result's is a 0-based index into `paragraphs`."""
    try:
        number = int(raw.get("paragraph"))
    except (TypeError, ValueError):
        return None
    index = number - 1
    if index not in targets or not (0 <= index < len(paragraphs)):
        return None
    comment = str(raw.get("comment") or "").strip()
    if not comment:
        return None
    return {
        "paragraph": index,
        "quote": match_quote(paragraphs[index], str(raw.get("quote") or "")),
        "comment": comment,
        "suggestion": str(raw.get("suggestion") or "").strip(),
    }


# --- streaming ----------------------------------------------------------------

def stream_critique(
    paragraphs: list[str],
    lens_name: str,
    lens_instruction: str,
    targets: list[int] | None = None,
    model_name: str | None = None,
    thinking: str = "off",  # thinking level
) -> Iterator[CritiqueEvent]:
    """Yields ("think", text) events (reasoning is never dropped) and one
    ("item", {paragraph, quote, comment, suggestion}) per valid comment, as soon
    as that comment is complete."""
    if targets is None:
        target_list = list(range(len(paragraphs)))
    else:
        target_list = sorted({t for t in targets if 0 <= t < len(paragraphs)})
    target_list = [t for t in target_list if paragraphs[t].strip()]
    if not target_list:
        return
    target_set = set(target_list)

    model, uses_thinking = resolve_model(model_name, thinking != "off")
    level = thinking if uses_thinking else "off"

    js = JsonStream()
    pending: dict[int, dict] = {}  # comment index -> fields received so far
    partial: dict[tuple, str] = {}  # string field path -> text so far
    seen: set[tuple] = set()

    def finish(i: int):
        fields = pending.pop(i, None)
        if fields is None:
            return None
        item = clean_comment(fields, paragraphs, target_set)
        if item is None:
            return None
        key = (item["paragraph"], item["quote"], item["comment"])
        if key in seen:
            return None
        seen.add(key)
        return item

    for kind, piece in stream_chat(
        model,
        build_messages(paragraphs, target_list, lens_name, lens_instruction),
        temperature=0.4,
        thinking=level,
        schema=SCHEMA,
    ):
        if kind == "think":
            yield ("think", piece)
            continue
        for ev in js.feed(piece):
            path = ev[1]
            if len(path) != 3 or path[0] != "comments" or path[2] not in FIELDS:
                continue
            i, field = path[1], path[2]
            fields = pending.setdefault(i, {})
            if ev[0] == "str":
                partial[path] = partial.get(path, "") + ev[2]
                continue
            if ev[0] == "str_end":
                fields[field] = partial.pop(path, "")
            elif ev[0] == "value":
                fields[field] = ev[2]
            if all(f in fields for f in FIELDS):
                item = finish(i)
                if item:
                    yield ("item", item)
