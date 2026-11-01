"""Per-document storage: save/load/list/delete, block indexing on save, and
the one-time import of the old shared `editor_state.json`."""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np
from loguru import logger

from app.store.blocks import Block, OldBlock, derive_title, extract_blocks, match_blocks
from app.store.db import Database, chunks
from app.store.vectors import VectorCache

KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
# the document that keyless /save_state + /load_state calls (old editor tabs) use,
# and that the old shared editor_state.json is imported as
LEGACY_KEY = "imported-editor-state"
LEGACY_FILE = "editor_state.json"
STORAGE_VERSION = "1.0"


class InvalidKey(ValueError):
    pass


class StaleWrite(Exception):
    """The stored document is newer than the one being saved."""

    def __init__(self, current: dict):
        super().__init__("A newer version of this document is stored")
        self.current = current


@dataclass
class SaveResult:
    meta: dict
    inserted: int = 0  # new blocks
    edited: int = 0  # blocks whose text changed (re-embedded)
    moved: int = 0  # same text, new position or heading (not re-embedded)
    deleted: int = 0
    unchanged: int = 0


def now_ms() -> int:
    return int(time.time() * 1000)


def check_key(key: str) -> str:
    if not isinstance(key, str) or not KEY_RE.match(key):
        raise InvalidKey("Document keys are 1-128 letters, digits, '-' or '_'.")
    return key


def read_stored_state(data: Any) -> dict | None:
    """Accepts every shape the editor has ever saved: {version, timestamp,
    state} or a bare editor state. Mirrors frontend readStoredState."""
    if not isinstance(data, dict):
        return None
    state = data if "root" in data else data.get("state")
    if not isinstance(state, dict) or not isinstance(state.get("root"), dict):
        return None
    return state


META_COLUMNS = "key, title, custom_title, project_id, sort_order, version, created_at, updated_at, saved_at, words, block_count"


def _meta(row) -> dict:
    return {
        "key": row["key"],
        "title": row["title"],
        "customTitle": row["custom_title"],
        "projectId": row["project_id"],
        "sortOrder": row["sort_order"],
        "version": row["version"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "savedAt": row["saved_at"],
        "words": row["words"],
        "blocks": row["block_count"],
    }


@dataclass
class Layout:
    """A document's block order: ids[position], paths[position]."""

    ids: np.ndarray  # int64
    paths: list[list[int]]
    position_of: dict[int, int]

    @classmethod
    def build(cls, ids: np.ndarray, paths: list[list[int]]) -> "Layout":
        return cls(ids, paths, {int(i): p for p, i in enumerate(ids.tolist())})


class DocumentStore:
    def __init__(self, db: Database, vectors: VectorCache, on_change: Callable[[], None] = lambda: None):
        self.db = db
        self.vectors = vectors
        self.on_change = on_change  # wakes the embedding worker
        self._layouts: dict[int, Layout] = {}
        self._layout_lock = threading.Lock()
        self.generation = 0  # bumped by every write (status cache)

    def layout(self, doc_id: int) -> Layout:
        with self._layout_lock:
            lay = self._layouts.get(doc_id)
        if lay is None:
            row = self.db.conn().execute("SELECT layout, paths FROM documents WHERE id = ?", (doc_id,)).fetchone()
            ids = np.frombuffer(row["layout"], dtype=np.int64) if row else np.zeros(0, dtype=np.int64)
            lay = Layout.build(ids, json.loads(row["paths"]) if row else [])
            with self._layout_lock:
                self._layouts[doc_id] = lay
        return lay

    def _set_layout(self, doc_id: int, lay: Layout | None):
        with self._layout_lock:
            if lay is None:
                self._layouts.pop(doc_id, None)
            else:
                self._layouts[doc_id] = lay

    # ---------- reads

    def get_meta(self, key: str) -> dict | None:
        row = self.db.conn().execute(f"SELECT {META_COLUMNS} FROM documents WHERE key = ?", (key,)).fetchone()
        return _meta(row) if row else None

    def load_raw(self, key: str) -> tuple[dict, str] | None:
        """(metadata, editor state as a JSON string): the state is passed
        through untouched, so big documents aren't parsed just to be sent."""
        row = self.db.conn().execute(
            f"SELECT {META_COLUMNS}, state FROM documents WHERE key = ?", (key,)
        ).fetchone()
        return (_meta(row), row["state"]) if row else None

    def list(self, project_id: int | None = None) -> list[dict]:
        sql = f"SELECT {META_COLUMNS} FROM documents"
        args: tuple = ()
        if project_id is not None:
            sql += " WHERE project_id = ?"
            args = (project_id,)
        sql += " ORDER BY updated_at DESC"
        return [_meta(r) for r in self.db.conn().execute(sql, args)]

    def doc_id(self, key: str) -> int | None:
        row = self.db.conn().execute("SELECT id FROM documents WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    # ---------- writes

    def save(
        self,
        key: str,
        state: dict,
        timestamp: int | None = None,
        version: str = STORAGE_VERSION,
        title: str | None = None,
        force: bool = False,
    ) -> SaveResult:
        """Store a document and update its blocks (unchanged blocks keep their
        ids and embeddings). Refuses (StaleWrite) to replace a document whose
        stored content is newer than `timestamp`, unless `force`."""
        check_key(key)
        if read_stored_state(state) is not state:
            raise ValueError("Not an editor state (no root node).")
        state_json = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
        blocks = extract_blocks(state)  # CPU work outside the writer lock
        derived = derive_title(blocks)
        words = sum(len(b.text.split()) for b in blocks)
        ts = int(timestamp) if timestamp else now_ms()
        saved_at = now_ms()

        with self.db.write() as c:
            row = c.execute("SELECT id, updated_at, custom_title FROM documents WHERE key = ?", (key,)).fetchone()
            if row and not force and row["updated_at"] > ts:
                raise StaleWrite(self.get_meta(key))
            custom = (title.strip() or None) if title is not None else (row["custom_title"] if row else None)
            if row is None:
                doc_id = c.execute(
                    "INSERT INTO documents(key, title, custom_title, version, state, created_at, updated_at, saved_at, words, block_count)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (key, custom or derived, custom, version, state_json, min(ts, saved_at), ts, saved_at, words, len(blocks)),
                ).lastrowid
            else:
                doc_id = row["id"]
                c.execute(
                    "UPDATE documents SET title=?, custom_title=?, version=?, state=?, updated_at=?, saved_at=?, words=?, block_count=?"
                    " WHERE id=?",
                    (custom or derived, custom, version, state_json, ts, saved_at, words, len(blocks), doc_id),
                )
            result = self._sync_blocks(c, doc_id, blocks)
            result.meta = _meta(c.execute(f"SELECT {META_COLUMNS} FROM documents WHERE id = ?", (doc_id,)).fetchone())
            self.generation += 1
        if result.inserted or result.edited:
            self.on_change()
        return result

    def _sync_blocks(self, c, doc_id: int, blocks: list[Block]) -> SaveResult:
        old_layout = self.layout(doc_id)
        old = {r["id"]: r for r in c.execute(
            "SELECT id, hash, heading, kind, level FROM blocks WHERE doc_id = ?", (doc_id,))}
        old_order = [i for i in old_layout.ids.tolist() if i in old]
        ids = match_blocks([OldBlock(i, old[i]["hash"]) for i in old_order], blocks)
        res = SaveResult(meta={})
        changed_hash: list[tuple[int, str]] = []  # (block id, new hash) for the vector cache
        final_ids: list[int] = []

        for b, bid in zip(blocks, ids):
            heading = b.heading
            if bid is None:
                bid = c.execute(
                    "INSERT INTO blocks(doc_id, kind, level, heading, text, hash, tokens) VALUES (?,?,?,?,?,?,?)",
                    (doc_id, b.kind, b.level, heading, b.text, b.hash, b.tokens),
                ).lastrowid
                res.inserted += 1
                changed_hash.append((bid, b.hash))
            else:
                o = old[bid]
                if o["hash"] != b.hash:
                    c.execute(
                        "UPDATE blocks SET kind=?, level=?, heading=?, text=?, hash=?, tokens=? WHERE id=?",
                        (b.kind, b.level, heading, b.text, b.hash, b.tokens, bid),
                    )
                    res.edited += 1
                    changed_hash.append((bid, b.hash))
                elif (o["heading"], o["level"]) != (heading, b.level):
                    c.execute("UPDATE blocks SET heading=?, level=? WHERE id=?", (heading, b.level, bid))
                    res.moved += 1
                elif old_layout.position_of.get(bid) != b.position:
                    res.moved += 1
                else:
                    res.unchanged += 1
            final_ids.append(bid)

        kept = set(final_ids)
        gone = [i for i in old if i not in kept]
        for part in chunks(gone):
            c.execute(f"DELETE FROM blocks WHERE id IN ({','.join('?' * len(part))})", part)
        res.deleted = len(gone)

        lay = Layout.build(np.array(final_ids, dtype=np.int64), [b.path for b in blocks])
        c.execute(
            "UPDATE documents SET layout = ?, paths = ? WHERE id = ?",
            (lay.ids.tobytes(), json.dumps(lay.paths, separators=(",", ":")), doc_id),
        )
        self._set_layout(doc_id, lay)  # under the writer lock, like the vectors

        # keep the in-memory vectors in step (we still hold the writer lock)
        self.vectors.remove(doc_id, gone)
        if changed_hash and self.vectors.loaded(doc_id):
            vecs = self._vectors_for(c, {h for _, h in changed_hash})
            self.vectors.put((bid, doc_id, vecs[h]) for bid, h in changed_hash if h in vecs)
            self.vectors.remove(doc_id, [bid for bid, h in changed_hash if h not in vecs])
        return res

    @staticmethod
    def _vectors_for(c, hashes: set[str]) -> dict[str, bytes]:
        out: dict[str, bytes] = {}
        for part in chunks(list(hashes)):
            q = ",".join("?" * len(part))
            for r in c.execute(f"SELECT hash, vec FROM embeddings WHERE hash IN ({q})", part):
                out[r[0]] = r[1]
        return out

    def delete(self, key: str) -> bool:
        """Delete a document with its whole index (blocks, keyword index, vectors).
        (Its embeddings are garbage-collected later by the worker, so an
        immediate undo/re-save doesn't need to re-embed.)"""
        with self.db.write() as c:
            row = c.execute("SELECT id FROM documents WHERE key = ?", (key,)).fetchone()
            if not row:
                return False
            c.execute("DELETE FROM documents WHERE id = ?", (row["id"],))  # cascades to blocks + FTS
            self.vectors.drop_doc(row["id"])
            self._set_layout(row["id"], None)
            self.generation += 1
        return True

    # ---------- migration

    def import_legacy_file(self, data_dir: Path) -> str | None:
        """Import the old shared `editor_state.json` as a document, once per
        distinct file content. The file itself is never modified or removed.
        Returns the key it was imported as (None if nothing was imported)."""
        path = Path(data_dir) / LEGACY_FILE
        if not path.is_file():
            return None
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        imported = json.loads(self.db.get_meta("legacy_imports") or "{}")
        if digest in imported:
            return None
        try:
            data = json.loads(raw)
        except ValueError as e:
            logger.warning(f"Not importing {path}: invalid JSON ({e})")
            return None
        state = read_stored_state(data)
        if state is None:
            logger.warning(f"Not importing {path}: not an editor state")
            return None
        key = None
        if extract_blocks(state):  # an empty document isn't worth a list entry
            key = LEGACY_KEY
            n = 2
            while self.get_meta(key) is not None:
                key, n = f"{LEGACY_KEY}-{n}", n + 1
            ts = data.get("timestamp") if isinstance(data.get("timestamp"), (int, float)) else None
            self.save(key, state, timestamp=int(ts or path.stat().st_mtime * 1000),
                      version=str(data.get("version") or STORAGE_VERSION))
            logger.info(f"Imported {path} as document '{key}'")
        else:
            logger.info(f"{path} holds an empty document: nothing to import")
        imported[digest] = key
        self.db.set_meta("legacy_imports", json.dumps(imported))
        return key
