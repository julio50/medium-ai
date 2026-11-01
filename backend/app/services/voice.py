from __future__ import annotations

from typing import Iterator
from app.services.json_stream import JsonStream
from app.services.llm import Event, obj_schema, resolve_model, stream_chat

TIDY_PROMPT = (
    "You turn a spoken brain-dump transcript into clean notes. Keep EVERY idea, "
    "remove filler words, false starts and repetition, and don't add new ideas. "
    "Answer in JSON: `bullets` is a list with one short item per idea."
)

SCHEMA = obj_schema(bullets={"type": "array", "items": {"type": "string"}})


def stream_tidy(transcript: str, model_name: str | None = None, thinking: str = "off") -> Iterator[Event]:
    """Yields think events, then the bullets as markdown lines ("- idea\\n")
    streamed as they're written."""
    model, uses_thinking = resolve_model(model_name, thinking != "off")
    level = thinking if uses_thinking else "off"
    js = JsonStream()
    started: set = set()
    for kind, piece in stream_chat(
        model,
        [{"role": "system", "content": TIDY_PROMPT}, {"role": "user", "content": transcript}],
        temperature=0.2,
        thinking=level,
        schema=SCHEMA,
    ):
        if kind == "think":
            yield (kind, piece)
            continue
        for ev in js.feed(piece):
            path = ev[1]
            if len(path) != 2 or path[0] != "bullets":
                continue
            if ev[0] == "str":
                text = ev[2].replace("\n", " ")
                if path not in started:
                    started.add(path)
                    text = "- " + text.lstrip()
                yield ("text", text)
            elif ev[0] == "str_end" and path in started:
                yield ("text", "\n")
