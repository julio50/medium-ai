import { useSyncExternalStore } from "react";

/**
 * Colour theme: "system" (default, follows the OS live), "light" or "dark".
 * A UI preference in localStorage, never part of the document.
 *
 * The resolved theme is `data-theme` on <html>: daisyUI themes, the CSS
 * variables in index.css and Tailwind `dark:` utilities all key off it.
 * index.html applies it before the first paint (keep its inline script in
 * sync with STORAGE_KEY and resolve()); this module keeps it up to date.
 */
export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const STORAGE_KEY = "theme";
const PREFERENCES: ThemePreference[] = ["system", "light", "dark"];

const isPreference = (v: unknown): v is ThemePreference => PREFERENCES.includes(v as ThemePreference);

function load(): ThemePreference {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        return isPreference(saved) ? saved : "system";
    } catch {
        return "system";
    }
}

const media: MediaQueryList | null =
    typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

let preference = load();
let systemDark = media?.matches ?? false;
let theme = resolve();
const listeners = new Set<() => void>();

function resolve(): Theme {
    return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

function apply() {
    theme = resolve();
    const html = document.documentElement;
    if (html.getAttribute("data-theme") !== theme) html.setAttribute("data-theme", theme);
    html.style.colorScheme = theme;
}

function changed() {
    apply();
    listeners.forEach((l) => l());
}

apply();

// the OS switched while the app is open (only matters for "system")
const onSystemChange = (e: MediaQueryListEvent) => {
    systemDark = e.matches;
    changed();
};
if (media?.addEventListener) media.addEventListener("change", onSystemChange);
else media?.addListener?.(onSystemChange); // Safari < 14

// another tab changed the setting
window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    preference = isPreference(e.newValue) ? e.newValue : "system";
    changed();
});

export function setThemePreference(next: ThemePreference) {
    if (next === preference) return;
    preference = next;
    try {
        localStorage.setItem(STORAGE_KEY, next);
    } catch {
        // storage full / blocked: the setting still works for this session
    }
    changed();
}

/** System -> Light -> Dark -> System */
export function cycleThemePreference() {
    setThemePreference(PREFERENCES[(PREFERENCES.indexOf(preference) + 1) % PREFERENCES.length]);
}

const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
};

export function useThemePreference(): ThemePreference {
    return useSyncExternalStore(subscribe, () => preference);
}

/** The theme actually shown ("system" resolved). */
export function useTheme(): Theme {
    return useSyncExternalStore(subscribe, () => theme);
}
