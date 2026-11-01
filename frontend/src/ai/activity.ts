import { useSyncExternalStore } from "react";

/**
 * Global store for in-flight AI work, shown by <ThinkingIndicator />.
 * An activity becomes visible as soon as the model starts thinking, and
 * stays until the answer is complete (or the user cancels).
 */
export type Activity = {
    id: number;
    label: string;
    startedAt: number;
    thinking: string; // reasoning streamed so far
    answering: boolean; // the model finished thinking and is writing
    cancel: () => void;
};

let activities: Activity[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
    activities = [...activities];
    listeners.forEach((l) => l());
}

export function startActivity(label: string, cancel: () => void): number {
    const id = nextId++;
    activities.push({ id, label, startedAt: Date.now(), thinking: "", answering: false, cancel });
    emit();
    return id;
}

export function updateActivity(id: number, patch: (a: Activity) => Partial<Activity>) {
    const a = activities.find((x) => x.id === id);
    if (!a) return;
    Object.assign(a, patch(a));
    emit();
}

export function endActivity(id: number) {
    const before = activities.length;
    activities = activities.filter((a) => a.id !== id);
    if (activities.length !== before) emit();
}

export function useActivities(): Activity[] {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => activities
    );
}

/** Short-lived messages (e.g. an AI edit that failed after its toolbar closed). */
export type Notice = { id: number; text: string };
let notices: Notice[] = [];
const noticeListeners = new Set<() => void>();

function emitNotices() {
    noticeListeners.forEach((l) => l());
}

export function notify(text: string, ms = 10000) {
    const id = nextId++;
    notices = [...notices, { id, text }];
    emitNotices();
    setTimeout(() => dismissNotice(id), ms);
}

export function dismissNotice(id: number) {
    notices = notices.filter((n) => n.id !== id);
    emitNotices();
}

export function useNotices(): Notice[] {
    return useSyncExternalStore(
        (l) => {
            noticeListeners.add(l);
            return () => noticeListeners.delete(l);
        },
        () => notices
    );
}
