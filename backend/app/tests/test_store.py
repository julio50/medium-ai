"""Document store, block identity, incremental embedding, hybrid search,
retrieve() and the document endpoints. Embeddings are faked: a hashed
bag-of-words vector, so texts sharing words are similar."""
import hashlib
import json
import re
import sys

import numpy as np
import pytest

sys.path.append(".")
from app.store import Library
from app.store.blocks import OldBlock, extract_blocks, match_blocks
from app.store.documents import LEGACY_KEY, StaleWrite
from app.store.search import fts_query, make_snippet

DIM = 64


class FakeEmbed:
    def __init__(self):
        self.calls: list[list[str]] = []
        self.down = False

    def __call__(self, texts):
        if self.down:
            import openai

            raise openai.APIConnectionError(request=None)  # type: ignore[arg-type]
        self.calls.append(list(texts))
        return [self.vec(t) for t in texts]

    @staticmethod
    def vec(text):
        v = np.zeros(DIM, dtype=np.float32)
        for w in re.findall(r"\w+", text.lower().split("query: ")[-1]):
            v[int(hashlib.md5(w.encode()).hexdigest(), 16) % DIM] += 1
        return (v if v.any() else np.ones(DIM, dtype=np.float32)).tolist()

    @property
    def embedded(self):
        return [t for c in self.calls for t in c]


# ---------- Lexical JSON builders

def text(t):
    return {"type": "text", "text": t, "detail": 0, "format": 0, "mode": "normal", "style": "", "version": 1}


def para(t):
    return {"type": "paragraph", "children": [text(t)] if t else [], "direction": None, "format": "", "indent": 0, "version": 1}


def heading(t, tag="h1"):
    return {"type": "heading", "tag": tag, "children": [text(t)], "direction": None, "format": "", "indent": 0, "version": 1}


def items(*ts, nested=None):
    children = [{"type": "listitem", "value": i + 1, "children": [text(t)], "version": 1} for i, t in enumerate(ts)]
    if nested:
        children.append({"type": "listitem", "children": [nested], "version": 1})
    return {"type": "list", "listType": "bullet", "tag": "ul", "start": 1, "children": children, "version": 1}


def doc(*children):
    return {"root": {"type": "root", "children": list(children), "direction": None, "format": "", "indent": 0, "version": 1}}


@pytest.fixture
def emb():
    return FakeEmbed()


@pytest.fixture
def lib(tmp_path, emb):
    lib = Library(tmp_path, embed=emb, model="fake")
    yield lib
    lib.close()


def drain(lib):
    while lib.embedder.run_once():
        pass


def block_rows(lib, key):
    """The document's blocks in order: dicts with id, position, text, heading, path."""
    doc_id = lib.documents.doc_id(key)
    if doc_id is None:
        return []
    lay = lib.documents.layout(doc_id)
    rows = {r["id"]: r for r in lib.db.conn().execute("SELECT id, text, heading FROM blocks WHERE doc_id = ?", (doc_id,))}
    return [{"id": i, "position": p, "text": rows[i]["text"], "heading": rows[i]["heading"], "path": lay.paths[p]}
            for p, i in enumerate(lay.ids.tolist())]


# ---------- block extraction

def test_extract_blocks_heading_paths_and_lists():
    state = doc(
        heading("Chapter 3"), para("Intro text."),
        heading("Referrals", "h2"), para("Ask every patient."), para(""),
        items("first", "second", nested=items("deep")),
        {"type": "quote", "children": [text("A quote")], "version": 1},
        {"type": "code", "children": [{"type": "code-highlight", "text": "x = 1"}, {"type": "linebreak"},
                                      {"type": "code-highlight", "text": "y"}], "version": 1},
        {"type": "horizontal-divider", "version": 1},
        heading("Chapter 4"), para("Later."),
    )
    blocks = extract_blocks(state)
    assert [(b.kind, b.text) for b in blocks] == [
        ("heading", "Chapter 3"), ("paragraph", "Intro text."), ("heading", "Referrals"),
        ("paragraph", "Ask every patient."), ("listitem", "first"), ("listitem", "second"), ("listitem", "deep"),
        ("quote", "A quote"), ("code", "x = 1\ny"), ("heading", "Chapter 4"), ("paragraph", "Later."),
    ]
    assert blocks[3].heading == "Chapter 3 › Referrals"
    assert blocks[2].heading == "Chapter 3"  # a heading's path is its parents
    assert blocks[9].heading == "" and blocks[10].heading == "Chapter 4"
    assert [b.position for b in blocks] == list(range(11))  # empty paragraph skipped
    assert blocks[4].path == [5, 0] and blocks[6].path == [5, 2, 0, 0]


def test_ghost_suggestions_and_images_are_not_text():
    p = para("Hello")
    p["children"] += [{"type": "autocomplete", "text": " ghost"}, {"type": "image", "src": "x"}]
    assert extract_blocks(doc(p))[0].text == "Hello"


def _ids(old_texts, new_texts):
    old = [OldBlock(i + 100, b.hash) for i, b in enumerate(extract_blocks(doc(*map(para, old_texts))))]
    return match_blocks(old, extract_blocks(doc(*map(para, new_texts))))


def test_identity_survives_edits_elsewhere():
    old = ["a", "b", "c", "d", "e"]
    assert _ids(old, ["new", "a", "b", "c", "d", "e"]) == [None, 100, 101, 102, 103, 104]  # insert at top
    assert _ids(old, ["a", "b", "d", "e"]) == [100, 101, 103, 104]  # delete
    assert _ids(old, ["a", "b", "C!", "d", "e"]) == [100, 101, 102, 103, 104]  # edit keeps the id
    assert _ids(old, ["d", "a", "b", "c", "e"]) == [103, 100, 101, 102, 104]  # move
    assert _ids(["x", "x", "y"], ["x", "y", "x"]) == [100, 102, 101]  # duplicates used once


def test_identity_on_large_documents_is_fast():
    old = [f"paragraph {i}" for i in range(20000)]
    new = old[:5000] + ["inserted"] + old[5000:12000] + ["edited"] + old[12001:]
    ids = _ids(old, new)
    assert ids[:5000] == list(range(100, 5100)) and ids[5000] is None
    assert ids[12001] == 12100  # the edited paragraph kept its id


# ---------- saving + incremental embedding

def test_only_new_and_changed_blocks_are_embedded(lib, emb):
    lib.documents.save("d1", doc(heading("Title"), para("one two"), para("three four")), 1)
    drain(lib)
    assert sorted(emb.embedded) == ["Title", "one two", "three four"]
    before = {r["text"]: r["id"] for r in block_rows(lib, "d1")}

    emb.calls.clear()
    res = lib.documents.save("d1", doc(heading("Title"), para("inserted"), para("one two"), para("three FOUR")), 2)
    assert (res.inserted, res.edited, res.moved, res.unchanged, res.deleted) == (1, 1, 1, 1, 0)
    drain(lib)
    assert sorted(emb.embedded) == ["inserted", "three FOUR"]
    after = {r["text"]: r["id"] for r in block_rows(lib, "d1")}
    assert after["one two"] == before["one two"] and after["three FOUR"] == before["three four"]

    emb.calls.clear()
    lib.documents.save("d2", doc(para("one two")), 3)  # same content elsewhere: shared embedding
    drain(lib)
    assert emb.embedded == []
    assert lib.status()["pendingBlocks"] == 0


def test_worker_retries_when_server_is_down(lib, emb):
    lib.documents.save("d1", doc(para("alpha beta")), 1)
    emb.down = True
    with pytest.raises(Exception):
        lib.embedder.run_once()
    assert lib.status()["pendingBlocks"] == 1
    emb.down = False
    assert lib.embedder.run_once() == 1
    assert lib.status()["pendingBlocks"] == 0


def test_rejected_blocks_are_skipped_after_retries(lib, emb):
    lib.documents.save("d1", doc(para("good text"), para("bad text")), 1)

    def picky(texts):
        if any("bad" in t for t in texts):
            raise ValueError("input too long")
        return emb(texts)

    lib.embedder.embed = picky
    for _ in range(3):
        lib.embedder.run_once()
    assert lib.status()["pendingBlocks"] == 0
    assert lib.status()["failedBlocks"] == 1
    assert "good text" in emb.embedded


def test_stale_writes_are_refused(lib):
    lib.documents.save("d1", doc(para("newer")), 2000)
    with pytest.raises(StaleWrite):
        lib.documents.save("d1", doc(para("older")), 1000)
    lib.documents.save("d1", doc(para("forced")), 1000, force=True)
    assert lib.documents.get_meta("d1")["title"] == "forced"


def test_titles(lib):
    assert lib.documents.save("a", doc(para("First line\nsecond"), heading("The Heading")), 1).meta["title"] == "The Heading"
    assert lib.documents.save("b", doc(para("Just text")), 1).meta["title"] == "Just text"
    assert lib.documents.save("c", doc(para("")), 1).meta["title"] == "Untitled"
    assert lib.documents.save("b", doc(para("Just text")), 2, title="My Book").meta["title"] == "My Book"
    assert lib.documents.save("b", doc(para("Changed")), 3).meta["title"] == "My Book"  # custom title sticks


# ---------- search

@pytest.fixture
def corpus(lib):
    lib.documents.save("clinic", doc(
        heading("Chapter 3"), heading("Referrals", "h2"),
        para("Ask every happy patient for a referral after their third visit."),
        para("Weather was nice today."),
        heading("Pricing", "h2"), para("Cash programs priced per month work best."),
    ), 1)
    lib.documents.save("novel", doc(heading("Prologue"), para("The dragon slept under the mountain."),
                                    para("Patient readers love slow referral jokes.")), 1)
    drain(lib)
    return lib


def test_keyword_search_with_stemming_and_prefix(corpus):
    hits, _ = corpus.searcher.search("clinic", "referrals", semantic=False)
    # stemmed text matches first; blocks under a "Referrals" heading match weaker
    assert [h.text[:9] for h in hits] == ["Referrals", "Ask every", "Weather w"]
    hits, _ = corpus.searcher.search("novel", "drag", semantic=False)  # prefix while typing
    assert hits[0].text.startswith("The dragon")
    assert fts_query('the "evil" AND') == '"evil"'  # FTS syntax is neutralized


def test_vector_and_hybrid_ranking(corpus):
    hits, semantic = corpus.searcher.search("novel", "mountain dragon")
    assert semantic and hits[0].text.startswith("The dragon")
    assert hits[0].keyword_rank == 1 and hits[0].similarity is not None
    # in both lists -> ranks above blocks found by only one
    hits, _ = corpus.searcher.search("clinic", "happy patient referral")
    assert hits[0].text.startswith("Ask every happy patient")
    assert hits[0].score == pytest.approx(1.0)
    assert hits[0].heading_path == "Chapter 3 › Referrals"


def test_search_never_crosses_documents(corpus):
    # "patient" and "referral" occur in both documents
    for semantic in (True, False):
        hits, _ = corpus.searcher.search("clinic", "patient referral jokes", semantic=semantic)
        assert hits and all(h.document_key == "clinic" for h in hits)
        clinic_ids = {r["id"] for r in block_rows(corpus, "clinic")}
        assert {h.block_id for h in hits} <= clinic_ids
    hits, _ = corpus.searcher.search("novel", "patient referral jokes")
    assert {h.block_id for h in hits} <= {r["id"] for r in block_rows(corpus, "novel")}
    assert corpus.searcher.search("missing", "referral") == ([], False)
    # the novel's vectors are not even in the clinic's matrix
    assert corpus.vectors.count(corpus.documents.doc_id("clinic")) == len(block_rows(corpus, "clinic"))


def test_search_falls_back_to_keywords_when_embedding_fails(corpus, emb):
    emb.down = True
    hits, semantic = corpus.searcher.search("novel", "dragon")
    assert not semantic and hits[0].text.startswith("The dragon")


def test_delete_drops_the_documents_index(corpus):
    novel = corpus.documents.doc_id("novel")
    corpus.searcher.search("novel", "dragon")  # loads its matrix
    assert corpus.vectors.loaded(novel)
    assert corpus.documents.delete("novel")
    assert not corpus.vectors.loaded(novel)
    assert corpus.searcher.search("novel", "dragon mountain") == ([], False)
    c = corpus.db.conn()
    assert c.execute("SELECT COUNT(*) FROM blocks_fts WHERE blocks_fts MATCH 'dragon'").fetchone()[0] == 0
    assert c.execute("SELECT COUNT(*) FROM blocks WHERE doc_id = ?", (novel,)).fetchone()[0] == 0
    assert corpus.embedder.gc() == 3  # its embeddings go with the next GC
    assert not corpus.documents.delete("novel")
    # re-created under the same key: a fresh, empty world
    corpus.documents.save("novel", doc(para("A new story.")), 5)
    hits, _ = corpus.searcher.search("novel", "dragon")
    assert hits == []


def test_removed_blocks_leave_the_index(corpus):
    clinic = corpus.documents.doc_id("clinic")
    corpus.searcher.search("clinic", "x")  # matrix loaded, so saves must keep it in step
    corpus.documents.save("clinic", doc(heading("Chapter 3"), para("Only this is left.")), 2)
    hits, _ = corpus.searcher.search("clinic", "weather nice")
    assert all("Weather" not in h.text for h in hits)
    assert corpus.vectors.count(clinic) == 1  # the edited block waits for its new embedding
    drain(corpus)
    assert corpus.vectors.count(clinic) == 2


def test_vector_cache_evicts_least_recently_used(corpus):
    corpus.vectors.max_bytes = 1  # only the document being searched stays in memory
    clinic, novel = corpus.documents.doc_id("clinic"), corpus.documents.doc_id("novel")
    corpus.searcher.search("clinic", "patient")
    corpus.searcher.search("novel", "dragon")
    assert corpus.vectors.loaded(novel) and not corpus.vectors.loaded(clinic)
    hits, _ = corpus.searcher.search("clinic", "happy patient referral")  # reloads
    assert hits[0].text.startswith("Ask every") and hits[0].similarity is not None


def test_vector_matrix_compacts_after_many_removals():
    from app.store.vectors import DocMatrix

    m = DocMatrix()
    rng = np.random.default_rng(0)
    vecs = rng.standard_normal((5000, 8)).astype(np.float32)
    m.append(np.arange(5000), vecs / np.linalg.norm(vecs, axis=1, keepdims=True))
    m.remove(range(0, 4000))
    assert m.n == 1000 and len(m) == 1000  # compacted
    top = m.search(m.mat[0], 1, [])
    assert top[0][0] == 4000


def test_snippet_highlights():
    s, spans = make_snippet("Ask every patient for referrals.", ["referral"])
    assert [s[a:b] for a, b in spans] == ["referrals"]
    long = "word " * 200 + "the target sentence " + "tail " * 100
    s, spans = make_snippet(long, ["target"])
    assert s.startswith("… ") and s.endswith(" …") and [s[a:b] for a, b in spans] == ["target"]


# ---------- retrieve()

def test_retrieve_merges_adjacent_and_respects_budget(lib):
    lib.documents.save("book", doc(*[para(f"Section {i}: " + ("zebra stripes " if i in (5, 6, 20) else "filler words ") * 10)
                                     for i in range(40)]), 1)
    drain(lib)
    passages = lib.retrieve("book", "zebra stripes", token_budget=10000)
    spans = sorted((p.start_position, p.end_position) for p in passages[:2])
    assert (5, 6) in spans and (20, 20) in spans  # 5 and 6 merged into one passage
    assert len({b for p in passages for b in p.block_ids}) == sum(len(p.block_ids) for p in passages)  # no duplicates

    small = lib.retrieve("book", "zebra stripes", token_budget=60)
    assert sum(p.tokens for p in small) <= 60 and small
    assert all("zebra" in p.text for p in small)


def test_retrieve_excludes_blocks(lib):
    lib.documents.save("book", doc(*[para(f"p{i} " + ("zebra" if i in (2, 9) else "other")) for i in range(12)]), 1)
    drain(lib)
    window = lib.searcher.blocks_in_range("book", 0, 4)  # the local window around the cursor
    passages = lib.retrieve("book", "zebra", exclude_block_ids=window, token_budget=1000)
    ids = {b for p in passages for b in p.block_ids}
    assert ids and not ids & set(window)
    assert passages[0].start_position == 9


def test_retrieve_truncates_only_when_nothing_fits(lib):
    lib.documents.save("book", doc(para("zebra " + "long " * 2000)), 1)
    drain(lib)
    [p] = lib.retrieve("book", "zebra", token_budget=200)
    assert p.truncated and p.tokens <= 200
    assert lib.retrieve("book", "zebra", token_budget=10) == []


def test_retrieve_stays_in_its_document(lib):
    lib.documents.save("a", doc(para("zebra in document a")), 1)
    lib.documents.save("b", doc(*[para(f"zebra zebra {i}") for i in range(20)]), 1)
    drain(lib)
    passages = lib.retrieve("a", "zebra", token_budget=5000)
    assert [p.text for p in passages] == ["zebra in document a"]


# ---------- migration

def test_legacy_file_is_imported_once_and_kept(tmp_path, emb):
    legacy = {"version": "1.0", "timestamp": 1700000000000, "state": doc(heading("Old Notes"), para("Kept safe."))}
    (tmp_path / "editor_state.json").write_text(json.dumps(legacy))
    lib = Library(tmp_path, embed=emb, model="fake")
    meta = lib.documents.get_meta(LEGACY_KEY)
    assert meta["title"] == "Old Notes" and meta["updatedAt"] == 1700000000000
    lib.close()
    lib = Library(tmp_path, embed=emb, model="fake")  # restart: not imported twice
    assert [d["key"] for d in lib.documents.list()] == [LEGACY_KEY]
    assert json.loads((tmp_path / "editor_state.json").read_text()) == legacy
    lib.close()


def test_empty_legacy_file_is_not_imported(tmp_path, emb):
    (tmp_path / "editor_state.json").write_text(json.dumps({"version": "1.0", "timestamp": 1, "state": doc(para(""))}))
    lib = Library(tmp_path, embed=emb, model="fake")
    assert lib.documents.list() == []
    lib.close()


def test_embedding_model_change_reindexes(tmp_path, emb):
    lib = Library(tmp_path, embed=emb, model="fake")
    lib.documents.save("d", doc(para("hello world")), 1)
    drain(lib)
    lib.close()
    lib = Library(tmp_path, embed=emb, model="other-model")
    assert lib.status()["pendingBlocks"] == 1
    lib.close()


# ---------- endpoints

@pytest.fixture
def client(lib):
    from fastapi.testclient import TestClient

    import app.api as api

    api.set_library(lib)
    yield TestClient(api.app)  # no lifespan: the test library has no worker thread
    api.set_library(None)


def test_document_endpoints(client, lib):
    body = {"version": "1.0", "timestamp": 1000, "state": doc(heading("Hello"), para("World"))}
    r = client.put("/documents/abc", json=body)
    assert r.status_code == 200 and r.json()["title"] == "Hello" and r.json()["changes"]["inserted"] == 2

    r = client.get("/documents/abc")
    assert r.status_code == 200
    got = r.json()
    assert got["state"] == body["state"] and got["timestamp"] == 1000 and got["key"] == "abc"

    assert client.put("/documents/abc", json={**body, "timestamp": 500}).status_code == 409
    assert client.put("/documents/abc?force=true", json={**body, "timestamp": 500}).status_code == 200

    assert [d["key"] for d in client.get("/documents").json()["documents"]] == ["abc"]
    assert client.get("/documents/nope").status_code == 404
    assert client.get("/documents/bad%20key").status_code == 400
    assert client.put("/documents/x", json={"state": {"no": "root"}}).status_code == 400
    assert client.delete("/documents/abc").status_code == 200
    assert client.get("/documents/abc").status_code == 404


def test_search_and_status_endpoints(client, lib):
    client.put("/documents/abc", json={"timestamp": 1, "state": doc(heading("Notes"), para("Referral programs for clinics"))})
    client.put("/documents/other", json={"timestamp": 1, "state": doc(para("Referral elsewhere"))})
    assert client.get("/index/status?key=abc").json()["pendingBlocks"] == 2
    assert client.get("/index/status").json()["pendingBlocks"] == 3
    drain(lib)
    assert client.get("/index/status?key=abc").json()["pendingBlocks"] == 0
    r = client.post("/search", json={"query": "referral", "k": 5, "document_key": "abc"}).json()
    assert len(r["hits"]) == 1
    hit = r["hits"][0]
    assert hit["headingPath"] == "Notes" and "documentTitle" not in hit
    assert [hit["snippet"][a:b] for a, b in hit["highlights"]] == ["Referral"]
    assert r["semantic"] is True and hit["path"] == [1]
    assert client.post("/search", json={"query": "referral"}).status_code == 422  # a document is required
    assert client.post("/search", json={"query": "referral", "document_key": "nope"}).json()["hits"] == []


def test_legacy_endpoints_still_work(client):
    stored = {"version": "1.0", "timestamp": 5, "state": doc(para("legacy"))}
    assert client.post("/save_state", json=stored).status_code == 200
    assert client.get("/load_state").json()["state"] == stored["state"]
    assert client.post("/save_state?key=k1", json=stored["state"]).status_code == 200  # bare state
    assert client.get("/load_state?key=k1").json()["state"] == stored["state"]


def test_big_documents_save(client):
    words = " ".join(["lorem"] * 120)
    state = doc(*[heading(f"Chapter {i // 100}") if i % 100 == 0 else para(f"{i} {words}") for i in range(6000)])
    r = client.put("/documents/book", json={"timestamp": 1, "state": state})
    assert r.status_code == 200 and r.json()["blocks"] == 6000


def test_request_size_limit():
    from fastapi.testclient import TestClient

    import app.api as api

    small = api.BodySizeLimit(api.app, max_bytes=1000)
    r = TestClient(small).put("/documents/x", content=b"x" * 2000, headers={"content-type": "application/json"})
    assert r.status_code == 413


def test_positions_and_paths_follow_edits_without_rewriting_blocks(lib):
    lib.documents.save("d", doc(para("alpha"), para("bravo"), items("charlie")), 1)
    ids = [r["id"] for r in block_rows(lib, "d")]
    res = lib.documents.save("d", doc(para("new first"), para("alpha"), para("bravo"), items("charlie")), 2)
    assert res.moved == 3 and res.inserted == 1
    rows = block_rows(lib, "d")
    assert [r["id"] for r in rows[1:]] == ids
    assert [r["path"] for r in rows] == [[0], [1], [2], [3, 0]]
    hits, _ = lib.searcher.search("d", "charlie", semantic=False)
    assert (hits[0].position, hits[0].path) == (3, [3, 0])
    assert lib.searcher.blocks_in_range("d", 1, 2) == ids[:2]
