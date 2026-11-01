import { endActivity, startActivity, updateActivity } from "./activity";

type StreamEvent = { type: "think" | "text" | "item" | "error" | "done"; text?: string; data?: unknown };

export type StreamOptions = {
    /** shown in the thinking indicator, e.g. "AI edit" */
    label: string;
    signal?: AbortSignal;
    onText?: (chunk: string, fullText: string) => void;
    /** structured results (e.g. one margin comment), as soon as each is complete */
    onItem?: (data: unknown) => void;
};

export class AIStreamError extends Error {}

/**
 * POST `body` to a backend NDJSON stream endpoint. Answer text is passed to
 * `onText` as it arrives, structured "item" events to `onItem`; reasoning ("think" events) drives the global thinking
 * indicator, which appears on the first thought and offers Cancel.
 * Resolves with the full answer text; rejects with AbortError on cancel.
 */
export async function streamAI(url: string, body: unknown, opts: StreamOptions): Promise<string> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    opts.signal?.addEventListener("abort", abort);

    let activityId: number | null = null;
    let text = "";
    let finished = false;
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok || !response.body) {
            let detail = response.statusText;
            try {
                detail = (await response.json()).detail ?? detail;
            } catch {
                /* not JSON */
            }
            throw new AIStreamError(`${response.status}: ${detail}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) !== -1) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                const ev = JSON.parse(line) as StreamEvent;
                if (ev.type === "think") {
                    if (activityId === null) activityId = startActivity(opts.label, abort);
                    const id = activityId;
                    updateActivity(id, (a) => ({ thinking: a.thinking + (ev.text ?? "") }));
                } else if (ev.type === "text") {
                    if (activityId !== null) updateActivity(activityId, () => ({ answering: true }));
                    text += ev.text ?? "";
                    opts.onText?.(ev.text ?? "", text);
                } else if (ev.type === "item") {
                    if (activityId !== null) updateActivity(activityId, () => ({ answering: true }));
                    opts.onItem?.(ev.data);
                } else if (ev.type === "error") {
                    throw new AIStreamError(ev.text ?? "Model error");
                } else if (ev.type === "done") {
                    finished = true;
                }
            }
        }
        if (!finished) {
            throw new AIStreamError("The connection to the AI server ended before the answer was complete.");
        }
        return text;
    } finally {
        // stop the request on every exit path (error event, bad JSON, onText throwing)
        controller.abort();
        opts.signal?.removeEventListener("abort", abort);
        if (activityId !== null) endActivity(activityId);
    }
}

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";
