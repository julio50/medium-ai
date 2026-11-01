import { EditorState } from "lexical";
import { notify } from "../ai/activity";
import { listServerDocuments, saveServerDocument, SaveOutcome } from "./documentsApi";
import { readStoredState, serializeEditorState, STORAGE_VERSION, StoredDocument } from "./editorStorage";

/**
 * Keeps one open document in step with localStorage (offline cache, written
 * shortly after each change) and the backend (the source of truth when its
 * copy is newer; pushed every 30 s, on Save / Ctrl+S, when the search panel
 * opens, and when the document is closed). Conflicts resolve by edit time:
 * the backend refuses to replace a newer copy with an older one.
 */

const LOCAL_DEBOUNCE_MS = 400; // serializing a book on every keystroke would lag

export const localKey = (key: string) => `editor-${key}`;

export function readLocalDocument(key: string): { state: StoredDocument["state"]; timestamp: number } | null {
    try {
        const raw = localStorage.getItem(localKey(key));
        if (!raw) return null;
        const data = JSON.parse(raw);
        const state = readStoredState(data);
        return state ? { state, timestamp: Number(data?.timestamp) || 0 } : null;
    } catch (e) {
        // unreadable entries are left alone (never deleted)
        console.warn("Invalid localStorage data:", e);
        return null;
    }
}

export class DocumentSync {
    readonly key: string;
    private latest: EditorState | null = null;
    private json: string | null = null; // current content (serialized)
    private editedAt = 0; // when `json` last changed
    private serverJson: string | null = null; // what the backend has (as far as we know)
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pushing: Promise<SaveOutcome | null> | null = null;
    private conflict = false; // the backend has a newer copy: stop auto-pushing over it
    private loaded = false; // nothing is saved before the document has loaded

    constructor(key: string) {
        this.key = key;
    }

    /** After loading: the editor now shows content edited at `timestamp`;
     * `onServer` says whether the backend already has exactly this. */
    loadedFrom(editorState: EditorState, timestamp: number, onServer: boolean) {
        this.latest = editorState;
        const state = serializeEditorState(editorState);
        this.json = JSON.stringify(state);
        this.editedAt = timestamp || Date.now();
        this.loaded = true;
        if (!state.root.children?.length) {
            this.serverJson = this.json; // a blank new document: nothing to save until it's edited
            return;
        }
        this.serverJson = onServer ? this.json : null;
        this.writeLocal();
    }

    /** Every editor change (cheap: the work is debounced). */
    onChange(editorState: EditorState) {
        if (!this.loaded) return;
        this.latest = editorState;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flushLocal(), LOCAL_DEBOUNCE_MS);
    }

    /** Serialize pending changes now; write the local cache if they're new. */
    flushLocal() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (!this.latest || !this.loaded) return;
        const json = JSON.stringify(serializeEditorState(this.latest));
        if (json === this.json) return; // e.g. only the selection moved
        this.json = json;
        this.editedAt = Date.now();
        this.conflict = false; // a new edit: the user's latest work wins
        this.writeLocal();
    }

    private writeLocal() {
        if (this.json === null) return;
        try {
            localStorage.setItem(
                localKey(this.key),
                `{"version":${JSON.stringify(STORAGE_VERSION)},"timestamp":${this.editedAt},"state":${this.json}}`
            );
        } catch (error) {
            // e.g. QuotaExceededError for a book: the backend keeps the copy
            console.warn("LocalStorage save failed:", error);
        }
    }

    get dirty(): boolean {
        this.flushLocal();
        return this.json !== null && this.json !== this.serverJson;
    }

    /** Send the document to the backend if it changed. `null` = nothing to do. */
    async push(opts: { manual?: boolean } = {}): Promise<SaveOutcome | null> {
        if (this.pushing) await this.pushing;
        if (!this.dirty || (this.conflict && !opts.manual)) return null;
        const json = this.json as string;
        const body = `{"version":${JSON.stringify(STORAGE_VERSION)},"timestamp":${this.editedAt},"state":${json}}`;
        this.pushing = saveServerDocument(this.key, body).then((outcome) => {
            if (outcome.ok) {
                this.serverJson = json;
                this.conflict = false;
            } else if (outcome.conflict && !this.conflict) {
                this.conflict = true;
                notify(
                    "A newer version of this document is on the server (edited elsewhere). " +
                        "Reload the page to get it; this browser's copy is kept until then.",
                    20000
                );
            }
            return outcome;
        });
        try {
            return await this.pushing;
        } finally {
            this.pushing = null;
        }
    }
}

let active: DocumentSync | null = null;

/** The document open in the editor (for Save / Ctrl+S and the search panel). */
export function activeDocumentSync(): DocumentSync | null {
    return active;
}

export function setActiveDocumentSync(sync: DocumentSync | null) {
    active = sync;
}

/**
 * Once per page load: upload documents that only this browser has (or has a
 * newer copy of), so the backend holds everything and old notes can't be
 * lost when localStorage is cleared. The backend rejects stale copies.
 */
export async function uploadLocalOnlyDocuments(skipKey?: string) {
    const server = await listServerDocuments();
    if (!server) return; // backend down (or an older backend): try next time
    const serverAt = new Map(server.map((d) => [d.key, d.updatedAt]));
    for (let i = 0; i < localStorage.length; i++) {
        const name = localStorage.key(i);
        if (!name?.startsWith("editor-")) continue;
        const key = name.slice("editor-".length);
        if (key === skipKey || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) continue;
        const local = readLocalDocument(key);
        if (!local || !local.state.root?.children?.length) continue;
        const at = serverAt.get(key);
        if (at !== undefined && at >= local.timestamp) continue;
        const outcome = await saveServerDocument(key, {
            version: STORAGE_VERSION,
            timestamp: local.timestamp || Date.now(),
            state: local.state,
        });
        if (!outcome.ok && !outcome.conflict) return; // backend trouble: stop for now
    }
}
