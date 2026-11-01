from __future__ import annotations

import re
import time
from typing import Iterator, Literal, Tuple
from openai import OpenAI
from app.config.config_files import OpenAIConfig

client = OpenAI(api_key=OpenAIConfig.api_key, base_url=OpenAIConfig.base_url)

# Model ids on the server that aren't chat/text models
NON_CHAT_PATTERNS = re.compile(
    r"embed|image|ocr|tts|whisper|parakeet|pocket|-vl|omni", re.IGNORECASE
)

# A streamed event: ("think", reasoning text) or ("text", answer text)
Event = Tuple[Literal["think", "text"], str]

# Thinking levels (UI). "off" uses the non-thinking (-instruct) variant.
# Prompting/reasoning_effort alone doesn't reliably shorten reasoning, so lower
# levels also get a reasoning budget: past it, the thinking stream is stopped
# and the non-thinking variant writes the answer from the notes so far.
ThinkingLevel = Literal["off", "low", "medium", "high"]
THINKING_BUDGET_CHARS = {"low": 2400, "medium": 6000, "high": None}  # ~4 chars/token
# passed to chat templates that support it (e.g. spark: "low" | "high")
REASONING_EFFORT = {"low": "low", "medium": "high", "high": "high"}


def effective_level(thinking: bool, level: str | None) -> str:
    """Request -> level. `thinkingLevel` wins; legacy `thinking: true` = high."""
    if level in ("off", "low", "medium", "high"):
        return level
    return "high" if thinking else "off"


def non_thinking_variant(model_id: str) -> str | None:
    """The -instruct twin of a thinking model, if the server has one."""
    try:
        fam = model_families().get(family_of(model_id))
    except Exception:
        return None
    return fam.get("instruct") if fam else None


INSTRUCT_SUFFIX = "-instruct"
_families: dict[str, dict] = {}
_families_at = 0.0


def family_of(model_id: str) -> str:
    return model_id[: -len(INSTRUCT_SUFFIX)] if model_id.endswith(INSTRUCT_SUFFIX) else model_id


def model_families() -> dict[str, dict]:
    """Group the server's chat models into families. When both `X` (thinking)
    and `X-instruct` (non-thinking) exist, family `X` has both variants and the
    Thinking toggle picks between them; otherwise the family is a single model.
    Cached for 60s."""
    global _families, _families_at
    if _families and time.time() - _families_at < 60:
        return _families
    ids = set(list_chat_models())
    families: dict[str, dict] = {}
    for mid in sorted(ids):
        fam = family_of(mid)
        if fam in families:
            continue
        if fam in ids and fam + INSTRUCT_SUFFIX in ids:
            families[fam] = {"thinking": fam, "instruct": fam + INSTRUCT_SUFFIX}
        else:
            families[mid] = {"single": mid}
    _families, _families_at = families, time.time()
    return families


def resolve_model(model_name: str | None, thinking: bool = False) -> tuple[str, bool]:
    """Map a family name (or raw model id) + Thinking toggle to the model id to
    call. Returns (model_id, uses_thinking_variant)."""
    name = model_name if model_name and model_name != "none" else OpenAIConfig.model
    try:
        families = model_families()
    except Exception:
        families = {}
    fam = families.get(name) or families.get(family_of(name))
    if fam is None:
        return name, thinking
    if "single" in fam:
        return fam["single"], thinking
    return (fam["thinking"], True) if thinking else (fam["instruct"], False)


def list_chat_models() -> list[str]:
    models = [m.id for m in client.models.list().data]
    return [m for m in models if not NON_CHAT_PATTERNS.search(m)]


def estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars/token). Avoids tiktoken, which downloads
    its encodings from the internet and doesn't match local models anyway."""
    return (len(text) + 3) // 4


class AnswerCutOff(Exception):
    """The server stopped generating before the answer was complete."""


def stream_chat(
    model: str,
    messages: list[dict],
    temperature: float,
    thinking: bool | str = False,
    schema: dict | None = None,
) -> Iterator[Event]:
    """Stream a chat completion as ("think", ...) / ("text", ...) events.

    `thinking` is a level ("off"/"low"/"medium"/"high"; True means "high") and
    should only be on when a thinking model was picked. Reasoning is never
    discarded: it's emitted on the "think" channel so the UI can show progress.
    Outputs are never capped (no max_tokens); if the server still stops early
    (e.g. its context is full), AnswerCutOff is raised instead of passing off a
    partial answer as complete. "low"/"medium" have a reasoning budget: once it's
    exceeded before the answer starts, thinking stops and the non-thinking
    variant writes the answer, given the reasoning so far as notes.

    With `schema`, the answer is constrained to that JSON schema (json_schema
    response_format; llama.cpp enforces it with a grammar). "text" events then
    carry raw JSON fragments: parse them with json_stream.JsonStream.
    """
    level = "high" if thinking is True else ("off" if thinking is False else thinking)
    budget = THINKING_BUDGET_CHARS.get(level) if level != "off" else None
    response_format = {"response_format": {
        "type": "json_schema",
        "json_schema": {"name": "answer", "strict": True, "schema": schema},
    }} if schema else {}

    extra = {}
    if level != "off":
        extra["extra_body"] = {"chat_template_kwargs": {"reasoning_effort": REASONING_EFFORT[level]}}
    stream = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=temperature,
        stream=True,
        **response_format,
        **extra,
    )
    splitter = ThinkTagSplitter()
    reasoning, answered = "", False
    try:
        for chunk in stream:
            if not chunk.choices:
                continue
            _check_finish(chunk)
            delta = chunk.choices[0].delta
            # servers that parse reasoning out (llama.cpp --reasoning-format, vLLM)
            r = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
            events = [("think", r)] if r else []
            if delta.content:
                events += list(splitter.feed(delta.content))
            for kind, text in events:
                if kind == "think":
                    reasoning += text
                else:
                    answered = True
                yield (kind, text)
            if budget and not answered and len(reasoning) > budget:
                break  # over budget: hand off below
        else:
            yield from splitter.flush()
            return
    finally:
        stream.close()

    # Budget reached: answer with the non-thinking variant, using the notes.
    yield ("think", "\n\n[thinking budget reached — writing the answer from these notes]")
    fallback = non_thinking_variant(model)
    notes = {
        "role": "user",
        "content": "Notes from thinking about this (may be unfinished):\n" + reasoning.strip()
        + "\n\nNow give the final answer.",
    }
    stream = client.chat.completions.create(
        model=fallback or model,
        messages=messages + [notes],
        temperature=temperature,
        stream=True,
        **response_format,
        # no -instruct twin: ask the same model to skip thinking
        **({} if fallback else {"extra_body": {"chat_template_kwargs": {"enable_thinking": False}}}),
    )
    splitter = ThinkTagSplitter()
    try:
        for chunk in stream:
            if not chunk.choices:
                continue
            _check_finish(chunk)
            if chunk.choices[0].delta.content:
                yield from splitter.feed(chunk.choices[0].delta.content)
        yield from splitter.flush()
    finally:
        stream.close()


def _check_finish(chunk) -> None:
    if getattr(chunk.choices[0], "finish_reason", None) == "length":
        raise AnswerCutOff(
            "The AI server stopped before the answer was finished (its context "
            "window is full). Try a shorter selection or a model with a longer context."
        )


class ThinkTagSplitter:
    """Routes inline <think>...</think> content (servers that don't parse
    reasoning) to the "think" channel instead of the answer."""

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self):
        self.buf = ""
        self.in_think = False

    def feed(self, text: str) -> Iterator[Event]:
        self.buf += text
        while self.buf:
            tag = self.CLOSE if self.in_think else self.OPEN
            idx = self.buf.find(tag)
            if idx != -1:
                if idx:
                    yield ("think" if self.in_think else "text", self.buf[:idx])
                self.buf = self.buf[idx + len(tag):]
                self.in_think = not self.in_think
                continue
            # keep a possible partial tag at the end for the next chunk
            keep = next((k for k in range(len(tag) - 1, 0, -1) if self.buf.endswith(tag[:k])), 0)
            out, self.buf = self.buf[: len(self.buf) - keep], self.buf[len(self.buf) - keep:]
            if out:
                yield ("think" if self.in_think else "text", out)
            return

    def flush(self) -> Iterator[Event]:
        if self.buf:
            yield ("think" if self.in_think else "text", self.buf)
            self.buf = ""


def collect_text(events: Iterator[Event]) -> str:
    return "".join(v for k, v in events if k == "text")


def transcribe(audio: bytes, filename: str, model: str) -> str:
    res = client.audio.transcriptions.create(model=model, file=(filename, audio))
    return res.text.strip()


def obj_schema(**props: dict) -> dict:
    """JSON schema for an object with exactly these (required, ordered) properties."""
    return {
        "type": "object",
        "properties": props,
        "required": list(props),
        "additionalProperties": False,
    }
