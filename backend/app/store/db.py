"""SQLite database holding the documents and their search index.

One file (`library.sqlite3` in the data dir), WAL mode, one connection per
thread. Writes are serialized with `Database.lock` (FastAPI runs sync
endpoints in a thread pool, and the embedding worker is another thread), so
writers never see SQLITE_BUSY and in-memory caches can be updated in the
same critical section as the commit.
"""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- room for books/projects with ordered chapters (no UI yet)
CREATE TABLE IF NOT EXISTS projects (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
    id           INTEGER PRIMARY KEY,
    key          TEXT NOT NULL UNIQUE,      -- the editor's ?key= id
    title        TEXT NOT NULL,             -- custom_title, else derived from the content
    custom_title TEXT,
    project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    sort_order   REAL,                      -- position within the project
    version      TEXT NOT NULL,             -- stored-format version from the editor
    state        TEXT NOT NULL,             -- serialized Lexical editor state (JSON)
    created_at   INTEGER NOT NULL,          -- ms since epoch
    updated_at   INTEGER NOT NULL,          -- ms: when the content was edited (editor clock)
    saved_at     INTEGER NOT NULL,          -- ms: last save (server clock)
    words        INTEGER NOT NULL DEFAULT 0,
    block_count  INTEGER NOT NULL DEFAULT 0,
    -- block order: int64 block ids in document order, and their JSON paths.
    -- Kept here rather than per block row, so inserting a paragraph at the
    -- top of a book rewrites one value instead of 100k rows.
    layout       BLOB NOT NULL DEFAULT x'',
    paths        TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS documents_project ON documents(project_id, sort_order);

-- text blocks of each document (see store/blocks.py); their order is documents.layout
CREATE TABLE IF NOT EXISTS blocks (
    id       INTEGER PRIMARY KEY,           -- stable across edits elsewhere
    doc_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    kind     TEXT NOT NULL,                 -- paragraph|heading|listitem|quote|code
    level    INTEGER,                       -- heading level
    heading  TEXT NOT NULL,                 -- heading path, e.g. "Chapter 3 › Referrals"
    text     TEXT NOT NULL,
    hash     TEXT NOT NULL,                 -- content hash (kind + text)
    tokens   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS blocks_doc ON blocks(doc_id);
CREATE INDEX IF NOT EXISTS blocks_hash ON blocks(hash);

-- content-addressed: identical blocks (moved, copied, undone) share one embedding
CREATE TABLE IF NOT EXISTS embeddings (
    hash TEXT PRIMARY KEY,
    vec  BLOB NOT NULL                      -- float16, unit length
);

-- blocks the embedding server rejected (retried a few times, then skipped)
CREATE TABLE IF NOT EXISTS embed_failures (
    hash     TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    error    TEXT,
    at       INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
    text, heading,
    content='blocks', content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS blocks_fts_insert AFTER INSERT ON blocks BEGIN
    INSERT INTO blocks_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
END;
CREATE TRIGGER IF NOT EXISTS blocks_fts_delete AFTER DELETE ON blocks BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, old.heading);
END;
CREATE TRIGGER IF NOT EXISTS blocks_fts_update AFTER UPDATE OF text, heading ON blocks BEGIN
    INSERT INTO blocks_fts(blocks_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, old.heading);
    INSERT INTO blocks_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
END;
"""


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()  # serializes writers (see module docstring)
        self._local = threading.local()
        self._all: list[sqlite3.Connection] = []
        self._all_lock = threading.Lock()
        with self.lock:
            conn = self.conn()
            conn.executescript(SCHEMA)
            if self.get_meta("schema_version") is None:
                self.set_meta("schema_version", str(SCHEMA_VERSION))

    def conn(self) -> sqlite3.Connection:
        """This thread's connection (autocommit; use `write()` for transactions)."""
        c = getattr(self._local, "conn", None)
        if c is None:
            c = sqlite3.connect(self.path, isolation_level=None, check_same_thread=False, timeout=30)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA synchronous=NORMAL")
            c.execute("PRAGMA foreign_keys=ON")
            c.execute("PRAGMA busy_timeout=30000")
            c.execute("PRAGMA cache_size=-32000")  # 32 MB page cache per connection
            self._local.conn = c
            with self._all_lock:
                self._all.append(c)
        return c

    @contextmanager
    def write(self) -> Iterator[sqlite3.Connection]:
        """A write transaction, holding the writer lock until it's committed."""
        with self.lock:
            c = self.conn()
            c.execute("BEGIN IMMEDIATE")
            try:
                yield c
            except BaseException:
                c.execute("ROLLBACK")
                raise
            c.execute("COMMIT")

    def get_meta(self, key: str) -> str | None:
        row = self.conn().execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def set_meta(self, key: str, value: str, conn: sqlite3.Connection | None = None) -> None:
        (conn or self.conn()).execute(
            "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    def close(self) -> None:
        with self._all_lock:
            for c in self._all:
                try:
                    c.close()
                except Exception:
                    pass
            self._all.clear()
        self._local = threading.local()


def chunks(items: list, n: int = 500) -> Iterator[list]:
    """SQLite caps bound parameters per statement; batch IN (...) lists."""
    for i in range(0, len(items), n):
        yield items[i : i + n]
