"""Incremental JSON parser for streamed structured output.

The model's answer arrives as JSON (enforced by a response_format schema) a few
characters at a time. JsonStream turns those fragments into events as soon as
they can be known, so string fields can still be streamed into the editor:

    ("str", path, chunk)   part of a string value (decoded, escapes resolved)
    ("str_end", path)      that string value is complete
    ("value", path, v)     a complete number / bool / null

`path` is a tuple of object keys and array indexes, e.g. ("text",) or
("bullets", 2). Truncated input (e.g. max_tokens hit mid-string) simply stops
producing events; everything received so far has already been emitted.
"""
from __future__ import annotations

import json
from typing import Any, Iterator, Tuple

JsonEvent = Tuple[Any, ...]

_ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}
_WS = " \t\r\n"


class JsonStream:
    def __init__(self):
        self.stack: list[list] = []  # [kind ("obj"/"arr"), current key / index]
        self.mode = "value"  # value | key | colon | string | literal | after | done
        self.in_key = False
        self.buf = ""  # key or literal being read
        self.esc = False
        self.uni: str | None = None  # \uXXXX digits being read

    def _path(self) -> tuple:
        return tuple(f[1] for f in self.stack)

    def feed(self, text: str) -> Iterator[JsonEvent]:
        out = ""  # string chars collected during this feed
        for ch in text:
            if self.mode == "string":
                if self.uni is not None:
                    self.uni += ch
                    if len(self.uni) < 4:
                        continue
                    try:
                        ch = chr(int(self.uni, 16))
                    except ValueError:
                        ch = ""
                    self.uni = None
                elif self.esc:
                    self.esc = False
                    if ch == "u":
                        self.uni = ""
                        continue
                    ch = _ESCAPES.get(ch, ch)
                elif ch == "\\":
                    self.esc = True
                    continue
                elif ch == '"':
                    if self.in_key:
                        self.stack[-1][1] = self.buf
                        self.mode = "colon"
                    else:
                        if out:
                            yield ("str", self._path(), out)
                            out = ""
                        yield ("str_end", self._path())
                        self.mode = "after"
                    continue
                if self.in_key:
                    self.buf += ch
                else:
                    out += ch
                continue

            if self.mode == "literal":
                if ch not in ",}]" + _WS:
                    self.buf += ch
                    continue
                try:
                    yield ("value", self._path(), json.loads(self.buf))
                except ValueError:
                    pass
                self.mode = "after"  # fall through to handle ch

            if ch in _WS:
                continue
            if self.mode == "value":
                if ch == "{":
                    self.stack.append(["obj", None])
                    self.mode = "key"
                elif ch == "[":
                    self.stack.append(["arr", 0])
                elif ch == "]" and self.stack and self.stack[-1][0] == "arr":
                    self._close()
                elif ch == '"':
                    self.mode, self.in_key = "string", False
                else:
                    self.mode, self.buf = "literal", ch
            elif self.mode == "key":
                if ch == '"':
                    self.mode, self.in_key, self.buf = "string", True, ""
                elif ch == "}":
                    self._close()
            elif self.mode == "colon":
                if ch == ":":
                    self.mode = "value"
            elif self.mode == "after":
                if ch == ",":
                    if self.stack and self.stack[-1][0] == "obj":
                        self.mode = "key"
                    elif self.stack:
                        self.stack[-1][1] += 1
                        self.mode = "value"
                elif ch in "}]":
                    self._close()
        if out:
            yield ("str", self._path(), out)

    def _close(self):
        if self.stack:
            self.stack.pop()
        self.mode = "after" if self.stack else "done"
