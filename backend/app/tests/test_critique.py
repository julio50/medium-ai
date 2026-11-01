import json
import sys

sys.path.append(".")
from app.services.critique import build_messages, match_quote


def _fake_stream(events, calls=None):
    def fake(*args, **kwargs):
        if calls is not None:
            calls.append((args, kwargs))
        yield from events
    return fake


def _no_server(monkeypatch, module):
    monkeypatch.setattr(module, "resolve_model", lambda name, thinking=False: ("m", thinking))


PARAS = [
    "Our adjustments fix back pain for good.",
    "",
    "Book a free consult today and feel the difference.",
]


def _items(events):
    return [v for k, v in events if k == "item"]


# ---------- quote matching

def test_match_quote_exact_and_fallbacks():
    p = "We guarantee “results” in   two weeks, or your money back."
    assert match_quote(p, "two weeks") == "two weeks"
    assert match_quote(p, '"two weeks"') == "two weeks"  # added quotation marks
    assert match_quote(p, "We GUARANTEE \"results\" in two weeks") == "We guarantee “results” in   two weeks"
    assert match_quote(p, "We guarantee ... money back") == p[:-1]  # elided middle
    assert match_quote(p, "something else entirely") == ""
    assert match_quote(p, "  ") == ""


# ---------- streaming

def test_streams_each_comment_when_complete(monkeypatch):
    import app.services.critique as m
    _no_server(monkeypatch, m)
    first = '{"comments": [{"paragraph": 1, "quote": "fix back pain for good", "comment": "Too absolute.", "suggestion": "Say \\"help\\"."}'
    second = ', {"paragraph": 3, "quote": "free consult", "comment": "Free of what?", "suggestion": ""}]}'
    seen = []

    def stream(*a, **k):
        yield ("think", "hmm")
        yield ("text", first[:30])
        yield ("text", first[30:])
        seen.append("first sent")
        yield ("text", second)

    monkeypatch.setattr(m, "stream_chat", stream)
    events = []
    for ev in m.stream_critique(PARAS, "Compliance", "Risky claims"):
        events.append(ev)
        if ev[0] == "item" and len(_items(events)) == 1:
            # the first comment arrives before the model writes the second one
            assert seen == []
    assert events[0] == ("think", "hmm")
    assert _items(events) == [
        {"paragraph": 0, "quote": "fix back pain for good", "comment": "Too absolute.", "suggestion": 'Say "help".'},
        {"paragraph": 2, "quote": "free consult", "comment": "Free of what?", "suggestion": ""},
    ]


def test_first_item_is_yielded_before_the_array_closes(monkeypatch):
    import app.services.critique as m
    _no_server(monkeypatch, m)
    monkeypatch.setattr(m, "stream_chat", _fake_stream([
        ("text", '{"comments": [{"paragraph": 1, "quote": "", "comment": "A", "suggestion": "B"}'),
        ("text", ', {"paragraph": 1, "quote": "", "comm'),
    ]))
    # the stream stops mid-way through the second comment: the first was already sent
    assert _items(m.stream_critique(PARAS, "x", "y")) == [
        {"paragraph": 0, "quote": "", "comment": "A", "suggestion": "B"}
    ]


def test_validates_model_output(monkeypatch):
    import app.services.critique as m
    _no_server(monkeypatch, m)
    comments = [
        {"paragraph": 9, "quote": "x", "comment": "out of range", "suggestion": ""},
        {"paragraph": 0, "quote": "x", "comment": "zero is out of range (1-based)", "suggestion": ""},
        {"paragraph": 2, "quote": "", "comment": "empty paragraph", "suggestion": ""},
        {"paragraph": 1, "quote": "not in the text", "comment": "kept, whole paragraph", "suggestion": ""},
        {"paragraph": 1, "quote": "not in the text", "comment": "kept, whole paragraph", "suggestion": ""},
        {"paragraph": 3, "quote": "Free Consult", "comment": "  ", "suggestion": "no comment: dropped"},
        {"paragraph": 3, "quote": "Free Consult", "comment": "case fixed", "suggestion": " s "},
    ]
    monkeypatch.setattr(m, "stream_chat", _fake_stream([("text", json.dumps({"comments": comments}))]))
    assert _items(m.stream_critique(PARAS, "x", "y")) == [
        {"paragraph": 0, "quote": "", "comment": "kept, whole paragraph", "suggestion": ""},
        {"paragraph": 2, "quote": "free consult", "comment": "case fixed", "suggestion": "s"},
    ]


def test_targets_limit_where_comments_go(monkeypatch):
    import app.services.critique as m
    _no_server(monkeypatch, m)
    calls = []
    comments = [
        {"paragraph": 1, "quote": "", "comment": "not a target", "suggestion": ""},
        {"paragraph": 3, "quote": "", "comment": "target", "suggestion": ""},
    ]
    monkeypatch.setattr(m, "stream_chat", _fake_stream([("text", json.dumps({"comments": comments}))], calls))
    assert [c["comment"] for c in _items(m.stream_critique(PARAS, "x", "y", targets=[2, 7]))] == ["target"]
    user = calls[0][0][1][1]["content"]
    assert "Comment ONLY on paragraphs 3." in user
    assert "[1] Our adjustments" in user  # context is still sent


def test_empty_list_and_nothing_to_review(monkeypatch):
    import app.services.critique as m
    _no_server(monkeypatch, m)
    monkeypatch.setattr(m, "stream_chat", _fake_stream([("think", "fine"), ("text", '{"comments": []}')]))
    assert list(m.stream_critique(PARAS, "x", "y")) == [("think", "fine")]
    # only empty target paragraphs: no model call at all
    monkeypatch.setattr(m, "stream_chat", lambda *a, **k: (_ for _ in ()).throw(AssertionError("called")))
    assert list(m.stream_critique(PARAS, "x", "y", targets=[1])) == []


def test_lens_is_data_and_thinking_level_passes_through(monkeypatch):
    import app.services.critique as m
    calls = []
    monkeypatch.setattr(m, "resolve_model", lambda name, thinking=False: (f"{name}-resolved", thinking))
    monkeypatch.setattr(m, "stream_chat", _fake_stream([("text", '{"comments": []}')], calls))
    list(m.stream_critique(PARAS, "Grandma", "Would my grandma get it?", model_name="spark", thinking="low"))
    (model, messages), kwargs = calls[0]
    assert model == "spark-resolved"
    assert kwargs["thinking"] == "low"
    assert kwargs["schema"] == m.SCHEMA
    assert "Lens: Grandma" in messages[0]["content"]
    assert "Would my grandma get it?" in messages[0]["content"]


def test_build_messages_numbers_paragraphs_from_one():
    msgs = build_messages(["a", "b"], [0, 1], "L", "I")
    assert "[1] a\n\n[2] b" in msgs[1]["content"]
    assert "Comment on any paragraph." in msgs[1]["content"]


# ---------- endpoint

def test_critique_endpoint_streams_items(monkeypatch):
    from fastapi.testclient import TestClient
    import app.api as api
    calls = []

    def fake(**kw):
        calls.append(kw)
        yield ("think", "plan")
        yield ("item", {"paragraph": 0, "quote": "q", "comment": "c", "suggestion": "s"})

    monkeypatch.setattr(api, "stream_critique", fake)
    r = TestClient(api.app).post("/critique/stream", json={
        "paragraphs": ["q here"],
        "lens": {"name": "Devil's advocate", "instruction": "Argue against it."},
        "modelName": "spark",
        "thinkingLevel": "medium",
    })
    events = [json.loads(line) for line in r.text.splitlines()]
    assert events == [
        {"type": "think", "text": "plan"},
        {"type": "item", "data": {"paragraph": 0, "quote": "q", "comment": "c", "suggestion": "s"}},
        {"type": "done"},
    ]
    assert calls[0]["lens_name"] == "Devil's advocate"
    assert calls[0]["thinking"] == "medium"
    assert calls[0]["targets"] is None


def test_critique_endpoint_rejects_empty_input():
    from fastapi.testclient import TestClient
    import app.api as api
    c = TestClient(api.app)
    lens = {"name": "x", "instruction": "y"}
    assert c.post("/critique/stream", json={"paragraphs": ["", " "], "lens": lens}).status_code == 400
    assert c.post("/critique/stream", json={"paragraphs": ["hi"], "lens": {"name": "x", "instruction": " "}}).status_code == 400
    assert c.post("/critique/stream", json={"paragraphs": ["hi"]}).status_code == 422
