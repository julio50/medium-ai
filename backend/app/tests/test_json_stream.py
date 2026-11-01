import sys

sys.path.append(".")
from app.services.json_stream import JsonStream


def run(chunks):
    js, events = JsonStream(), []
    for c in chunks:
        events += list(js.feed(c))
    return events


def strings(events, path):
    return "".join(e[2] for e in events if e[0] == "str" and e[1] == path)


def test_streams_string_field_in_pieces():
    ev = run(['{"skip": fal', 'se, "te', 'xt": "Hel', 'lo \\"wor', 'ld\\"\\n"}'])
    assert ("value", ("skip",), False) in ev
    assert strings(ev, ("text",)) == 'Hello "world"\n'
    assert ("str_end", ("text",)) in ev
    # the first part of the string is emitted before the string is finished
    assert ev.index(("value", ("skip",), False)) < [e[0] for e in ev].index("str")


def test_array_of_strings():
    ev = run(['{"bullets": ["a', 'b", "c"', ', "d\\u00e9"]}'])
    assert strings(ev, ("bullets", 0)) == "ab"
    assert strings(ev, ("bullets", 1)) == "c"
    assert strings(ev, ("bullets", 2)) == "dé"
    assert [e for e in ev if e[0] == "str_end"] == [
        ("str_end", ("bullets", 0)), ("str_end", ("bullets", 1)), ("str_end", ("bullets", 2))]


def test_truncated_output_keeps_what_arrived():
    ev = run(['{\n  "skip": true', ',\n  "text": "half a sen'])
    assert ("value", ("skip",), True) in ev
    assert strings(ev, ("text",)) == "half a sen"
    assert ("str_end", ("text",)) not in ev


def test_numbers_null_nested():
    ev = run(['{"a": 1.5, "b": null, "c": {"d": [true, "x"]}}'])
    assert ("value", ("a",), 1.5) in ev
    assert ("value", ("b",), None) in ev
    assert ("value", ("c", "d", 0), True) in ev
    assert strings(ev, ("c", "d", 1)) == "x"
