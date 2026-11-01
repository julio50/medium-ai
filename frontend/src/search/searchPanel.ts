import { useSyncExternalStore } from "react";

/**
 * Search panel open/closed, shared by the menu bar button (outside the
 * editor) and <SearchPlugin /> (inside it).
 */
export const SEARCH_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl+K";

export function isSearchShortcut(e: KeyboardEvent): boolean {
    return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyK";
}

let open = false;
const listeners = new Set<() => void>();

export function setSearchOpen(on: boolean) {
    if (on === open) return;
    open = on;
    listeners.forEach((l) => l());
}

export function toggleSearch() {
    setSearchOpen(!open);
}

export function useSearchOpen(): boolean {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => open
    );
}
