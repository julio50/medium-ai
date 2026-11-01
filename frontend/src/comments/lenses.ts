import { useSyncExternalStore } from "react";

/**
 * A lens is one angle to review the writing from. The backend is lens-agnostic:
 * it only receives `name` + `instruction`, so any number of lenses can be added
 * here or created by the user (custom lenses live in localStorage).
 */
export type Lens = {
    id: string;
    name: string;
    /** #rrggbb */
    color: string;
    instruction: string;
    builtin?: boolean;
};

export const BUILTIN_LENSES: Lens[] = [
    {
        id: "devils-advocate",
        name: "Devil's advocate",
        color: "#e11d48",
        builtin: true,
        instruction:
            "Argue the other side. For the claims, arguments and recommendations that matter most, give the strongest " +
            "counter-argument a smart, well-informed critic would make: the one the writer most needs to answer. " +
            "Skip trivial nitpicks.",
    },
    {
        id: "skeptical-customer",
        name: "Skeptical customer",
        color: "#ea580c",
        builtin: true,
        instruction:
            "Read as a prospective buyer who has been burned before. Raise the objections, doubts and unanswered " +
            "questions (price, risk, time, effort, 'will this work for me?', 'why you and not someone else?') that " +
            "would stop you from taking the next step.",
    },
    {
        id: "clarity-editor",
        name: "Clarity editor",
        color: "#2563eb",
        builtin: true,
        instruction:
            "Flag sentences that are vague, abstract, jargon-heavy, overlong or confusing on a first read, and say " +
            "what a reader would misunderstand or skim past. Suggest a clearer, more concrete way to say it.",
    },
    {
        id: "proof-checker",
        name: "Proof checker",
        color: "#7c3aed",
        builtin: true,
        instruction:
            "Find claims that need support: results, numbers, comparisons, 'best / proven / most' statements and " +
            "promises. For each, say what evidence would make it believable (a specific figure, an example, a case " +
            "study, a testimonial, a source).",
    },
    {
        id: "compliance",
        name: "Compliance",
        color: "#0d9488",
        builtin: true,
        instruction:
            "Flag health, medical and advertising claims that could get a healthcare business (e.g. a chiropractic " +
            "clinic) in trouble with regulators, ad platforms' health policies or patients: promises to cure or fix " +
            "conditions, guaranteed results, unsubstantiated outcomes or statistics, before/after implications, fake " +
            "urgency or scarcity, and copy that calls out the reader's health condition ('Do you suffer from...?'). " +
            "Explain the risk and suggest compliant wording.",
    },
    {
        id: "yes-and",
        name: "Yes-and",
        color: "#16a34a",
        builtin: true,
        instruction:
            "Be an enthusiastic collaborator. Where an idea is promising, say how to push it further: a bolder angle, " +
            "a vivid example or story, an extension, an unexpected implication. Build on what is there; don't criticise it.",
    },
];

/** swatches offered for custom lenses */
export const LENS_COLORS = [
    "#e11d48", "#ea580c", "#ca8a04", "#16a34a", "#0d9488",
    "#0891b2", "#2563eb", "#7c3aed", "#c026d3", "#475569",
];

const CUSTOM_KEY = "comment-lenses";
const SELECTED_KEY = "comment-lenses-selected";

function load<T>(key: string, fallback: T, valid: (v: unknown) => boolean): T {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        const v = JSON.parse(raw);
        return valid(v) ? (v as T) : fallback;
    } catch {
        return fallback;
    }
}

function save(key: string, value: unknown) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        console.warn("Could not save lenses:", e);
    }
}

const isLens = (l: unknown): l is Lens => {
    const x = l as Lens;
    return !!x && typeof x.id === "string" && typeof x.name === "string" &&
        typeof x.instruction === "string" && /^#[0-9a-f]{6}$/i.test(x.color);
};

type LensState = { custom: Lens[]; selected: string[] };

let state: LensState = {
    custom: load<Lens[]>(CUSTOM_KEY, [], (v) => Array.isArray(v)).filter(isLens).map((l) => ({ ...l, builtin: false })),
    selected: load<string[]>(SELECTED_KEY, ["devils-advocate"], (v) => Array.isArray(v)),
};
const listeners = new Set<() => void>();

function set(next: Partial<LensState>) {
    state = { ...state, ...next };
    if (next.custom) save(CUSTOM_KEY, state.custom);
    if (next.selected) save(SELECTED_KEY, state.selected);
    listeners.forEach((l) => l());
}

export function allLenses(s: LensState = state): Lens[] {
    return [...BUILTIN_LENSES, ...s.custom];
}

export function findLens(id: string): Lens | undefined {
    return allLenses().find((l) => l.id === id);
}

export function useLenses() {
    const s = useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => state
    );
    const lenses = allLenses(s);
    return {
        lenses,
        selected: s.selected.filter((id) => lenses.some((l) => l.id === id)),
        toggleSelected(id: string) {
            set({ selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id] });
        },
        /** create (no matching id) or update a custom lens */
        saveLens(lens: Lens) {
            const clean = { ...lens, builtin: false, name: lens.name.trim(), instruction: lens.instruction.trim() };
            const exists = state.custom.some((l) => l.id === lens.id);
            set({
                custom: exists ? state.custom.map((l) => (l.id === lens.id ? clean : l)) : [...state.custom, clean],
                selected: exists || state.selected.includes(lens.id) ? state.selected : [...state.selected, lens.id],
            });
        },
        deleteLens(id: string) {
            set({ custom: state.custom.filter((l) => l.id !== id), selected: state.selected.filter((x) => x !== id) });
        },
    };
}

export const newLensId = () => "custom-" + Math.random().toString(36).slice(2, 10);

/** "#rrggbb" + alpha (0-1) -> "#rrggbbaa" */
export function withAlpha(color: string, alpha: number): string {
    const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0");
    return /^#[0-9a-f]{6}$/i.test(color) ? color + a : color;
}

// ----- dark theme: lens colours as shown on screen

/** dark theme's raised surface (index.css --color-surface): cards and panels */
const DARK_SURFACE = [37, 38, 43];
const MIN_CONTRAST = 4.5; // WCAG AA for text

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function luminance(rgb: number[]): number {
    const [r, g, b] = rgb.map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const darkCache = new Map<string, string>();

/**
 * The lens colour to draw with (text, underlines, chips). Stored colours are
 * tuned for white; on the dark theme they are mixed toward white just enough
 * to stay legible as text on a dark card, keeping their hue.
 */
export function lensColor(color: string, theme: "light" | "dark"): string {
    if (theme === "light" || !/^#[0-9a-f]{6}$/i.test(color)) return color;
    let out = darkCache.get(color);
    if (out === undefined) {
        const base = channels(color);
        const bg = luminance(DARK_SURFACE);
        let mixed = base;
        for (let t = 0; t <= 1; t += 0.05) {
            mixed = base.map((c) => Math.round(c + (255 - c) * t));
            if ((luminance(mixed) + 0.05) / (bg + 0.05) >= MIN_CONTRAST) break;
        }
        out = "#" + mixed.map((c) => c.toString(16).padStart(2, "0")).join("");
        darkCache.set(color, out);
    }
    return out;
}
