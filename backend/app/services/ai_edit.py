from __future__ import annotations

from typing import Iterator
from app.services.json_stream import JsonStream
from app.services.llm import Event, obj_schema, resolve_model, stream_chat

SYSTEM_PROMPT = (
    "You are an editor helping a writer. Apply the instruction to the text. "
    "Answer in JSON: put ONLY the resulting text in `text`, with no preamble, "
    "no surrounding quotes and no explanations."
)

SCHEMA = obj_schema(text={"type": "string"})


def stream_edit_text(
    instruction: str,
    selected_text: str,
    temperature: float,
    model_name: str | None = None,
    thinking: str = "off",  # thinking level
) -> Iterator[Event]:
    model, uses_thinking = resolve_model(model_name, thinking != "off")
    level = thinking if uses_thinking else "off"
    def events() -> Iterator[Event]:
        js = JsonStream()
        for kind, piece in stream_chat(
            model,
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"Instruction: {instruction}\n\nText:\n{selected_text}"},
            ],
            temperature=temperature / 100,
            thinking=level,
            schema=SCHEMA,
        ):
            if kind == "think":
                yield (kind, piece)
                continue
            for ev in js.feed(piece):
                if ev[0] == "str" and ev[1] == ("text",):
                    yield ("text", ev[2])

    # Pass the `text` field through unchanged (trimming leading whitespace
    # and holding back trailing whitespace, which a replacement shouldn't end with)
    held, started = "", False
    for kind, piece in events():
        if kind == "think":
            yield (kind, piece)
            continue
        if not started:
            piece = piece.lstrip()
            if not piece:
                continue
            started = True
        text = held + piece
        stripped = text.rstrip()
        held = text[len(stripped):]
        if stripped:
            yield ("text", stripped)
