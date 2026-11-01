import { EditorState } from "lexical";

/**
 * One storage format everywhere (localStorage, Save / Ctrl+S, backend sync):
 *   { version, timestamp, state }
 * where `state` is the serialized editor state with AI ghost suggestions removed.
 */
export const STORAGE_VERSION = "1.0";

export type StoredDocument = {
    version: string;
    timestamp: number;
    state: SerializedState;
};

type SerializedNode = { type?: string; children?: SerializedNode[]; [k: string]: unknown };
export type SerializedState = { root: SerializedNode; [k: string]: unknown };

/** Remove "autocomplete" ghost nodes so suggestions never get saved as text. */
function stripGhosts<T extends SerializedNode>(node: T): T {
    if (!Array.isArray(node.children)) return node;
    return {
        ...node,
        children: node.children.filter((c) => c?.type !== "autocomplete").map(stripGhosts),
    };
}

export function serializeEditorState(editorState: EditorState): SerializedState {
    const json = editorState.toJSON() as unknown as SerializedState;
    return { ...json, root: stripGhosts(json.root) };
}

export function toStoredDocument(editorState: EditorState): StoredDocument {
    return { version: STORAGE_VERSION, timestamp: Date.now(), state: serializeEditorState(editorState) };
}

/**
 * Accepts every shape that has ever been saved: the wrapped document, or a
 * bare editor state (older Save button / backend file). Returns a clean
 * serialized state, or null if it isn't a usable editor state.
 */
export function readStoredState(data: unknown): SerializedState | null {
    if (!data || typeof data !== "object") return null;
    const obj = data as Record<string, unknown>;
    const state = (obj.root ? obj : obj.state) as SerializedState | undefined;
    if (!state || typeof state !== "object" || !state.root || typeof state.root !== "object") {
        return null;
    }
    return { ...state, root: stripGhosts(state.root) };
}
