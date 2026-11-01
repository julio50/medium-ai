import { useSyncExternalStore } from "react";

/**
 * "Hide UI while typing" preference (on by default), shared by the menu bar
 * toggle and <QuietTypingPlugin />. A UI preference in localStorage, never
 * part of the document.
 */
const STORAGE_KEY = "quiet-typing";

function load(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) !== "false";
    } catch {
        return true;
    }
}

let enabled = load();
const listeners = new Set<() => void>();

export function setQuietTyping(on: boolean) {
    if (on === enabled) return;
    enabled = on;
    try {
        localStorage.setItem(STORAGE_KEY, String(on));
    } catch {
        // storage blocked: works for this session
    }
    listeners.forEach((l) => l());
}

export function useQuietTyping(): boolean {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => enabled
    );
}
