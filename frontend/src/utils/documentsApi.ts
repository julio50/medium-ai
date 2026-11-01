import { DOCUMENTS_ENDPOINT, INDEX_STATUS_ENDPOINT, SEARCH_ENDPOINT } from "../constants";
import { readStoredState, SerializedState, StoredDocument } from "./editorStorage";

/**
 * The backend document store (backend/app/store). It's the source of truth
 * when its copy is newer; localStorage is the offline cache. Every document
 * is its own world: search only ever looks inside one document.
 */

export type DocumentMeta = {
    key: string;
    title: string;
    updatedAt: number; // ms: when the content was last edited
    savedAt: number;
    words: number;
    blocks: number;
};

export type SaveOutcome =
    | { ok: true; meta: DocumentMeta }
    | { ok: false; conflict: true; current: DocumentMeta } // the server has a newer version
    | { ok: false; conflict: false; error: string };

const url = (key: string) => `${DOCUMENTS_ENDPOINT}/${encodeURIComponent(key)}`;

/** The server's copy, `null` if it has none, `undefined` if it can't be reached. */
export async function fetchServerDocument(
    key: string,
    timeoutMs = 8000
): Promise<{ state: SerializedState; timestamp: number } | null | undefined> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url(key), { signal: ctrl.signal });
        if (res.status === 404) return null;
        if (!res.ok) return undefined;
        const data = await res.json();
        const state = readStoredState(data);
        return state ? { state, timestamp: Number(data.timestamp) || 0 } : null;
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
    }
}

/** `doc` may be pre-serialized (a book is costly to stringify twice). */
export async function saveServerDocument(key: string, doc: StoredDocument | string): Promise<SaveOutcome> {
    try {
        const res = await fetch(url(key), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: typeof doc === "string" ? doc : JSON.stringify(doc),
        });
        if (res.ok) return { ok: true, meta: await res.json() };
        if (res.status === 409) {
            const data = await res.json().catch(() => ({}));
            return { ok: false, conflict: true, current: data?.detail?.current };
        }
        const data = await res.json().catch(() => ({}));
        return { ok: false, conflict: false, error: String(data?.detail ?? res.statusText) };
    } catch {
        return { ok: false, conflict: false, error: "Backend not reachable" };
    }
}

export async function listServerDocuments(): Promise<DocumentMeta[] | undefined> {
    try {
        const res = await fetch(DOCUMENTS_ENDPOINT);
        if (!res.ok) return undefined;
        return (await res.json()).documents;
    } catch {
        return undefined;
    }
}

export type SearchHit = {
    blockId: number;
    headingPath: string;
    kind: string;
    position: number;
    path: number[]; // child indices from the root to the block's node
    text: string;
    snippet: string;
    highlights: [number, number][]; // character spans in `snippet`
    score: number;
    keywordRank: number | null;
    similarity: number | null;
};

export type SearchResult = { hits: SearchHit[]; semantic: boolean; tookMs: number };

export async function searchDocument(
    documentKey: string,
    query: string,
    signal?: AbortSignal,
    k = 30
): Promise<SearchResult> {
    const res = await fetch(SEARCH_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_key: documentKey, query, k }),
        signal,
    });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    return res.json();
}

export type IndexStatus = {
    blocks: number;
    pendingBlocks: number;
    failedBlocks: number;
    state: "idle" | "indexing" | "offline";
    lastError: string | null;
    retryInSeconds: number | null;
    model: string;
};

export async function fetchIndexStatus(documentKey: string): Promise<IndexStatus | undefined> {
    try {
        const res = await fetch(`${INDEX_STATUS_ENDPOINT}?key=${encodeURIComponent(documentKey)}`);
        return res.ok ? res.json() : undefined;
    } catch {
        return undefined;
    }
}
