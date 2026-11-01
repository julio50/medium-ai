from __future__ import annotations

import logging
import re
from typing import Iterator
from app.services.json_stream import JsonStream
from app.services.llm import Event, obj_schema, resolve_model, stream_chat

CHARS_PER_TOKEN = 4

# Don't suggest until the document says enough to know what it's about
# (e.g. "hi there" gets nothing). A manual request (Ctrl+Space) skips this.
MIN_CONTEXT_WORDS = 12

SYSTEM_PROMPT = (
    "You are a writing autocomplete engine. Continue the user's text naturally, "
    "matching its style, tone and topic. Answer in JSON. Put ONLY the "
    "continuation in `text`: never repeat the text you were given, no quotes, "
    "no explanations. If the text is too short or vague to tell what the writer "
    "is going to say, don't guess: set `skip` to true and leave `text` empty."
)

# skip comes first so a "no idea" answer is known before any text streams
SCHEMA = obj_schema(skip={"type": "boolean"}, text={"type": "string"})
# room left in the context window for the answer when clipping the input
# (this only limits how much of the document is sent, not the output)
ANSWER_RESERVE_TOKENS = 512


ECHO_WORDS = 8  # longest repeat of the prompt's ending we look for


def _norm(word: str) -> str:
    return word.lower().strip(".,;:!?\"'")


def strip_echo(prompt: str, answer: str) -> str:
    """Drop words at the start of `answer` that repeat the end of `prompt`
    ("...is to" + "to focus" -> "focus"; "hi there" + "hi there, how" -> "how")."""
    p_words, a_words = prompt.split(), answer.split()
    for k in range(min(ECHO_WORDS, len(p_words), len(a_words)), 0, -1):
        if [_norm(w) for w in p_words[-k:]] == [_norm(w) for w in a_words[:k]]:
            # cut through the k-th word (and trailing punctuation/space)
            m = re.match(r"\s*" + r"\s+".join(r"\S+" for _ in range(k)) + r"\s*", answer)
            rest = answer[m.end():] if m else answer
            return rest.lstrip(",;: ")
    return answer


def has_enough_context(*texts: str) -> bool:
    return sum(len(t.split()) for t in texts) >= MIN_CONTEXT_WORDS


def clip_context(
    previous_context: str,
    current_context: str,
    next_context: str,
    max_tokens: int = 128,
    max_length: int = 8192,
) -> dict:
    """Fit previous/current/next context into the model's window (in tokens,
    estimated from characters). The text nearest the cursor is kept first."""
    budget = (max_length - max_tokens) * CHARS_PER_TOKEN

    if len(current_context) >= budget:
        return {"prompt": current_context[-budget:], "suffix": ""}
    budget -= len(current_context)

    if len(previous_context) >= budget:
        return {"prompt": previous_context[-budget:] + current_context, "suffix": ""}
    budget -= len(previous_context)

    return {
        "prompt": previous_context + current_context,
        "suffix": next_context[:budget],
    }


def stream_autocomplete(
    previous_context: str,
    current_context: str,
    next_context: str,
    model_name: str | None = None,
    thinking: str = "off",  # thinking level
    force: bool = False,
) -> Iterator[Event]:
    """Yields think/text events; the text is one line that continues the prompt.
    Yields nothing when there isn't enough context (unless `force`) or the model
    declines with [SKIP]."""
    if not force and not has_enough_context(previous_context, current_context, next_context):
        return
    model, uses_thinking = resolve_model(model_name, thinking != "off")
    level = thinking if uses_thinking else "off"
    context = clip_context(previous_context, current_context, next_context, max_tokens=ANSWER_RESERVE_TOKENS)
    prompt = context["prompt"]
    is_space_at_end = prompt.endswith(" ")
    prompt = prompt.rstrip()
    suffix = context["suffix"].strip()
    logging.debug(f"autocomplete model={model} prompt_chars={len(prompt)}")

    user_msg = f"Text so far:\n{prompt}"
    if suffix:
        user_msg += f"\n\n(The document continues later with:\n{suffix}\n)"
    user_msg += "\n\nWrite the next few words/sentence that come right after 'Text so far'."

    def answer() -> Iterator[Event]:
        """think events, then the `text` field as it streams (nothing if skip)."""
        js = JsonStream()
        for kind, piece in stream_chat(
            model,
            [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user_msg}],
            temperature=0.7,
            thinking=level,
            schema=SCHEMA,
        ):
            if kind == "think":
                yield (kind, piece)
                continue
            for ev in js.feed(piece):
                if ev[0] == "value" and ev[1] == ("skip",) and ev[2] is True:
                    return  # the model has no idea yet: suggest nothing
                if ev[1] == ("text",):
                    if ev[0] == "str_end":
                        return
                    yield ("text", ev[2])

    def opening(lead: str) -> str | None:
        """Clean up the held start of the answer. None = suggest nothing."""
        probe = strip_echo(prompt, lead.lstrip().lstrip('"'))
        if not probe:
            return None
        if not is_space_at_end and probe[0] not in ".,;:!?)'":
            probe = " " + probe
        return probe

    lead: str | None = ""  # start of the answer, held until we can check it for an echo
    for kind, piece in answer():
        if kind == "think":
            yield (kind, piece)
            continue
        piece = piece.replace("\t", "")
        if lead is not None:
            lead += piece
            # hold until enough words arrive to compare with the prompt's ending
            if len(lead.split()) <= min(ECHO_WORDS, len(prompt.split())) and len(lead) < 80 and "\n" not in lead:
                continue
            piece, lead = opening(lead), None
            if piece is None:
                return
        if "\n" in piece:
            head = piece.split("\n")[0].rstrip('"')
            if head.strip():
                yield ("text", head)
            return
        if piece:
            yield ("text", piece)
    if lead:  # short answer that never filled the echo check
        piece = opening(lead)
        if piece:
            yield ("text", piece.split("\n")[0].rstrip('"'))
