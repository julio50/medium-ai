import sys

sys.path.append(".")
from app.services.ai_autocomplete import clip_context
from app.services.llm import ThinkTagSplitter, collect_text


def test_no_clipping():
    r = clip_context("prev. ", "current", " next.")
    assert r == {"prompt": "prev. current", "suffix": " next."}


def test_clips_current_context_keeping_the_end():
    # budget = (max_length - max_tokens) * 4 = (12 - 2) * 4 = 40 chars
    current = "x" * 30 + "y" * 20
    r = clip_context("prev", current, "next", max_tokens=2, max_length=12)
    assert r == {"prompt": current[-40:], "suffix": ""}


def test_clips_previous_context():
    r = clip_context("a" * 50, "b" * 10, "next", max_tokens=2, max_length=12)
    assert r == {"prompt": "a" * 30 + "b" * 10, "suffix": ""}


def test_clips_next_context():
    r = clip_context("a" * 10, "b" * 10, "c" * 50, max_tokens=2, max_length=12)
    assert r == {"prompt": "a" * 10 + "b" * 10, "suffix": "c" * 20}


def _fake_stream(events):
    def fake(*args, **kwargs):
        yield from events
    return fake


def _no_server(monkeypatch, module):
    monkeypatch.setattr(module, "resolve_model", lambda name, thinking=False: ("m", thinking))


LONG = "the first and most overlooked way to fill a schedule is to "


# ---------- AI edit (schema: {"text": str})

def test_stream_edit_keeps_leading_quotes(monkeypatch):
    # dialogue must survive: no quote-stripping heuristic any more
    import app.services.ai_edit as m
    _no_server(monkeypatch, m)
    monkeypatch.setattr(m, "stream_chat", _fake_stream([("text", '{"text": "\\"Hello,\\" she'), ("text", ' said.  '), ("text", '"}')]))
    assert collect_text(m.stream_edit_text("x", "hello she said", 20)) == '"Hello," she said.'


def test_stream_edit_keeps_inner_quotes(monkeypatch):
    import app.services.ai_edit as m
    _no_server(monkeypatch, m)
    monkeypatch.setattr(m, "stream_chat", _fake_stream([("text", '{"text": "He said \\"hi'), ("text", '\\" to'), ("text", ' me."}')]))
    assert collect_text(m.stream_edit_text("x", "he said hi", 20)) == 'He said "hi" to me.'


def test_stream_edit_passes_thinking_through(monkeypatch):
    import app.services.ai_edit as m
    _no_server(monkeypatch, m)
    monkeypatch.setattr(m, "stream_chat", _fake_stream([("think", "hmm"), ("text", '{"text": "Done"}')]))
    assert list(m.stream_edit_text("x", "y", 20, thinking="high")) == [("think", "hmm"), ("text", "Done")]


# ---------- autocomplete (schema: {"skip": bool, "text": str})

def test_stream_autocomplete_stops_at_newline(monkeypatch):
    import app.services.ai_autocomplete as m
    _no_server(monkeypatch, m)
    monkeypatch.setattr(m, "stream_chat", _fake_stream(
        [("think", "plan"), ("text", '{"skip": false, "text": "go for'), ("text", ' a walk.\\nNext'), ("text", ' line"}')]))
    events = list(m.stream_autocomplete("", "Try to", "", force=True))
    assert events[0] == ("think", "plan")
    assert collect_text(iter(events)) == " go for a walk."


def test_autocomplete_needs_context(monkeypatch):
    import app.services.ai_autocomplete as m
    _no_server(monkeypatch, m)
    monkeypatch.setattr(m, "stream_chat", _fake_stream([("text", '{"skip": false, "text": "you!"}')]))
    assert list(m.stream_autocomplete("", "hi there", "")) == []
    assert collect_text(m.stream_autocomplete("", "hi there", "", force=True)) == " you!"


def test_autocomplete_model_can_decline(monkeypatch):
    import app.services.ai_autocomplete as m
    _no_server(monkeypatch, m)
    monkeypatch.setattr(m, "stream_chat", _fake_stream([("think", "unsure"), ("text", '{"skip": tr'), ("text", 'ue, "text": ""}')]))
    assert collect_text(m.stream_autocomplete("", LONG, "")) == ""
    monkeypatch.setattr(m, "stream_chat", _fake_stream([("text", '{"skip": false, "text": "[S'), ("text", 'ee below]"}')]))
    assert collect_text(m.stream_autocomplete("", LONG, "")) == "[See below]"


def test_autocomplete_drops_repeated_last_word(monkeypatch):
    import app.services.ai_autocomplete as m
    _no_server(monkeypatch, m)
    monkeypatch.setattr(m, "stream_chat", _fake_stream([("text", '{"skip":false,"text":"to'), ("text", " focus"), ("text", ' on referrals."}')]))
    assert collect_text(m.stream_autocomplete("", LONG, "")) == "focus on referrals."


def test_strip_echo():
    from app.services.ai_autocomplete import strip_echo
    assert strip_echo("the way is to", "to focus on it") == "focus on it"
    assert strip_echo("hi there", "hi there, how can I help") == "how can I help"
    assert strip_echo("hi there", "Hi There! welcome") == "welcome"
    assert strip_echo("we went to", "the store") == "the store"


# ---------- voice tidy (schema: {"bullets": [str]})

def test_tidy_streams_bullets(monkeypatch):
    import app.services.voice as m
    _no_server(monkeypatch, m)
    monkeypatch.setattr(m, "stream_chat", _fake_stream(
        [("think", "ok"), ("text", '{"bullets": ["Run a free'), ("text", ' event", "Film testimonials"]}')]))
    assert collect_text(m.stream_tidy("um so")) == "- Run a free event\n- Film testimonials\n"


# ---------- llm helpers

def test_think_tags_are_routed_not_dropped():
    sp = ThinkTagSplitter()
    events = []
    for t in ["<thi", "nk>plan", "ning</thi", "nk>Answer", " here"]:
        events += list(sp.feed(t))
    events += list(sp.flush())
    think = "".join(v for k, v in events if k == "think")
    text = "".join(v for k, v in events if k == "text")
    assert (think, text) == ("planning", "Answer here")


def test_resolve_model_picks_variant(monkeypatch):
    import app.services.llm as llm
    monkeypatch.setattr(llm, "list_chat_models", lambda: ["spark", "spark-instruct", "d1", "coder-instruct"])
    llm._families = {}
    assert llm.resolve_model("spark", thinking=True) == ("spark", True)
    assert llm.resolve_model("spark", thinking=False) == ("spark-instruct", False)
    assert llm.resolve_model("spark-instruct", thinking=True) == ("spark", True)
    assert llm.resolve_model("d1", thinking=False) == ("d1", False)
    assert llm.resolve_model("coder-instruct", thinking=True) == ("coder-instruct", True)
    llm._families = {}


def test_effective_level():
    from app.services.llm import effective_level
    assert effective_level(False, None) == "off"
    assert effective_level(True, None) == "high"
    assert effective_level(True, "low") == "low"
    assert effective_level(False, "medium") == "medium"


class _FakeStream:
    def __init__(self, deltas, finish=None):
        from types import SimpleNamespace as NS
        self.items = [NS(choices=[NS(delta=NS(content=c, reasoning_content=r), finish_reason=None)]) for r, c in deltas]
        if finish:
            self.items.append(NS(choices=[NS(delta=NS(content=None, reasoning_content=None), finish_reason=finish)]))
        self.closed = False
        self.consumed = 0

    def __iter__(self):
        for it in self.items:
            self.consumed += 1
            yield it

    def close(self):
        self.closed = True


def test_budget_hands_off_to_instruct_with_notes(monkeypatch):
    import app.services.llm as llm
    calls = []
    thinking_stream = _FakeStream([("x" * 1000, None)] * 10)  # 10k chars of reasoning
    answer_stream = _FakeStream([(None, '{"text": "ok"}')])

    def create(**kw):
        calls.append(kw)
        return thinking_stream if len(calls) == 1 else answer_stream

    monkeypatch.setattr(llm.client.chat.completions, "create", create)
    monkeypatch.setattr(llm, "non_thinking_variant", lambda m: "spark-instruct")
    events = list(llm.stream_chat("spark", [{"role": "user", "content": "q"}], 0.5, thinking="low"))

    think = "".join(t for k, t in events if k == "think")
    assert "".join(t for k, t in events if k == "text") == '{"text": "ok"}'
    assert "budget reached" in think
    assert thinking_stream.closed and thinking_stream.consumed == 3  # stopped just past 2400 chars
    assert calls[0]["extra_body"]["chat_template_kwargs"]["reasoning_effort"] == "low"
    assert "max_tokens" not in calls[0] and "max_tokens" not in calls[1]  # never capped
    assert calls[1]["model"] == "spark-instruct"
    assert "x" * 100 in calls[1]["messages"][-1]["content"]  # notes passed on


def test_high_has_no_budget(monkeypatch):
    import app.services.llm as llm
    s = _FakeStream([("x" * 1000, None)] * 20 + [(None, "done")])
    monkeypatch.setattr(llm.client.chat.completions, "create", lambda **kw: s)
    events = list(llm.stream_chat("spark", [], 0.5, thinking="high"))
    assert events[-1] == ("text", "done") and s.consumed == 21


def test_no_output_caps(monkeypatch):
    import app.services.llm as llm
    calls = []

    def create(**kw):
        calls.append(kw)
        return _FakeStream([(None, "hi")], finish="stop")

    monkeypatch.setattr(llm.client.chat.completions, "create", create)
    assert list(llm.stream_chat("spark-instruct", [], 0.5)) == [("text", "hi")]
    assert "max_tokens" not in calls[0]


def test_cut_off_answer_is_an_error(monkeypatch):
    import pytest
    import app.services.llm as llm
    monkeypatch.setattr(llm.client.chat.completions, "create",
                        lambda **kw: _FakeStream([(None, '{"text": "half')], finish="length"))
    with pytest.raises(llm.AnswerCutOff):
        list(llm.stream_chat("spark-instruct", [], 0.5))


def test_api_reports_cut_off_as_error_event(monkeypatch):
    import json
    from fastapi.testclient import TestClient
    import app.api as api
    import app.services.llm as llm

    def cut_off(*a, **k):
        yield ("text", "partial")
        raise llm.AnswerCutOff("context full")

    monkeypatch.setattr(api, "stream_edit_text", cut_off)
    r = TestClient(api.app).post("/ai_edit/stream", json={"instruction": "x", "selectedText": "y"})
    events = [json.loads(l) for l in r.text.splitlines()]
    assert events[-1] == {"type": "error", "text": "context full"}
    assert {"type": "done"} not in events


def test_cors_only_allows_the_editor():
    from fastapi.testclient import TestClient
    import app.api as api
    c = TestClient(api.app)
    ok = c.get("/models", headers={"Origin": "http://localhost:5173"})
    bad = c.get("/load_state", headers={"Origin": "https://evil.example"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert "access-control-allow-origin" not in bad.headers
