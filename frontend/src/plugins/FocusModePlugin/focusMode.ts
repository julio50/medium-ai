import { useSyncExternalStore } from "react";

/**
 * Focus mode on/off, shared by the menu bar (outside the editor) and
 * <FocusModePlugin /> (inside it). It's a UI preference kept in localStorage,
 * never part of the Lexical document.
 */
const STORAGE_KEY = "focus-mode";

/** Human-readable shortcut, for titles and hints. */
export const FOCUS_MODE_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⇧F" : "Ctrl+Shift+F";

export function isFocusModeShortcut(e: KeyboardEvent): boolean {
    return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyF";
}

function load(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
        return false;
    }
}

let enabled = load();
const listeners = new Set<() => void>();

export function setFocusMode(on: boolean) {
    if (on === enabled) return;
    enabled = on;
    try {
        localStorage.setItem(STORAGE_KEY, String(on));
    } catch {
        // storage full / blocked: the toggle still works for this session
    }
    listeners.forEach((l) => l());
}

export function toggleFocusMode() {
    setFocusMode(!enabled);
}

export function useFocusMode(): boolean {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => enabled
    );
}
