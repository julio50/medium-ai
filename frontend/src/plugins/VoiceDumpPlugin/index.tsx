import { useCallback, useEffect, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
    $createParagraphNode,
    $createTextNode,
    $getRoot,
    $getSelection,
    $isRangeSelection,
    $isParagraphNode,
    LexicalNode,
} from "lexical";
import { $createListItemNode, $createListNode } from "@lexical/list";
import MicIcon from "@mui/icons-material/Mic";
import StopIcon from "@mui/icons-material/Stop";
import { TIDY_ENDPOINT, TRANSCRIBE_ENDPOINT } from "../../constants";
import { modelParams, useAISettings } from "../../ai/settings";
import { isAbort, streamAI } from "../../ai/stream";

type Status = "idle" | "starting" | "recording" | "transcribing" | "tidying";

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** Build editor nodes: bullet lines become a bulleted list, the rest paragraphs. */
function $buildNodes(text: string): LexicalNode[] {
    const nodes: LexicalNode[] = [];
    let list: ReturnType<typeof $createListNode> | null = null;
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line) {
            list = null;
            continue;
        }
        if (BULLET.test(line)) {
            if (!list) {
                list = $createListNode("bullet");
                nodes.push(list);
            }
            const item = $createListItemNode();
            item.append($createTextNode(line.replace(BULLET, "")));
            list.append(item);
        } else {
            list = null;
            const p = $createParagraphNode();
            p.append($createTextNode(line));
            nodes.push(p);
        }
    }
    return nodes;
}

function pickMimeType(): string {
    const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
    return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) ?? "";
}

/**
 * Voice brain-dump: press the mic (or Alt+V), talk, press again. The recording
 * is transcribed on the AI server and inserted after the paragraph the cursor
 * was in — optionally tidied into bullet points first. Esc while recording
 * discards it.
 */
export default function VoiceDumpPlugin() {
    const [editor] = useLexicalComposerContext();
    const aiSettings = useAISettings();
    const [status, setStatus] = useState<Status>("idle");
    const [message, setMessage] = useState<string>("");
    const [startedAt, setStartedAt] = useState(0);
    const [, tick] = useState(0);
    const [tidy, setTidyState] = useState<boolean>(() => localStorage.getItem("voice-tidy") !== "false");
    const setTidy = (on: boolean) => {
        setTidyState(on);
        localStorage.setItem("voice-tidy", String(on));
    };

    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const discardRef = useRef(false);
    const insertKeyRef = useRef<string | null>(null); // top-level block to insert after
    const statusRef = useRef<Status>("idle");
    statusRef.current = status;
    const settingsRef = useRef(aiSettings);
    settingsRef.current = aiSettings;
    const tidyRef = useRef(tidy);
    tidyRef.current = tidy;

    useEffect(() => {
        if (status !== "recording") return;
        const t = setInterval(() => tick((n) => n + 1), 500);
        return () => clearInterval(t);
    }, [status]);

    const flash = (msg: string) => {
        setMessage(msg);
        setTimeout(() => setMessage((m) => (m === msg ? "" : m)), 6000);
    };

    const insertText = useCallback(
        (text: string) => {
            editor.update(() => {
                const nodes = $buildNodes(text);
                if (nodes.length === 0) return;
                const root = $getRoot();
                const anchor = insertKeyRef.current
                    ? root.getChildren().find((n) => n.getKey() === insertKeyRef.current)
                    : undefined;
                if (anchor) {
                    // fill an empty paragraph instead of leaving a blank line
                    if ($isParagraphNode(anchor) && anchor.getTextContent().trim() === "") {
                        anchor.replace(nodes[0]);
                    } else {
                        anchor.insertAfter(nodes[0]);
                    }
                    let prev = nodes[0];
                    for (const n of nodes.slice(1)) {
                        prev.insertAfter(n);
                        prev = n;
                    }
                } else {
                    nodes.forEach((n) => root.append(n));
                }
                const last = nodes[nodes.length - 1];
                last.selectEnd();
            });
        },
        [editor]
    );

    const process = useCallback(
        async (blob: Blob, ext: string) => {
            setStatus("transcribing");
            let transcript = "";
            try {
                const form = new FormData();
                form.append("file", blob, `brain-dump.${ext}`);
                const res = await fetch(TRANSCRIBE_ENDPOINT, { method: "POST", body: form });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail ?? res.statusText);
                transcript = (data.text ?? "").trim();
            } catch (e) {
                setStatus("idle");
                flash(`Transcription failed: ${e instanceof Error ? e.message : e}`);
                return;
            }
            if (!transcript) {
                setStatus("idle");
                flash("Didn't catch anything — try again?");
                return;
            }
            if (!tidyRef.current) {
                insertText(transcript);
                setStatus("idle");
                return;
            }
            setStatus("tidying");
            try {
                const bullets = await streamAI(
                    TIDY_ENDPOINT,
                    { transcript, ...modelParams(settingsRef.current) },
                    { label: "Tidying brain-dump" }
                );
                insertText(bullets.trim() || transcript);
            } catch (e) {
                // never lose the recording: fall back to the raw transcript
                insertText(transcript);
                if (!isAbort(e)) flash("Couldn't tidy it, so I inserted the raw transcript.");
            }
            setStatus("idle");
        },
        [insertText]
    );

    const start = useCallback(async () => {
        // block a second start while the permission prompt / mic is opening
        statusRef.current = "starting";
        setStatus("starting");
        if (!navigator.mediaDevices?.getUserMedia) {
            setStatus("idle");
            flash("Microphone needs https or localhost. Open the app via http://localhost:5173.");
            return;
        }
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
            setStatus("idle");
            flash("Microphone permission denied.");
            return;
        }
        // remember where the cursor is: the dump goes right after that block
        editor.getEditorState().read(() => {
            const sel = $getSelection();
            insertKeyRef.current = $isRangeSelection(sel)
                ? sel.anchor.getNode().getTopLevelElement()?.getKey() ?? null
                : null;
        });
        const mimeType = pickMimeType();
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        const ext = (recorder.mimeType || mimeType).includes("mp4") ? "mp4"
            : (recorder.mimeType || mimeType).includes("ogg") ? "ogg" : "webm";
        chunksRef.current = [];
        discardRef.current = false;
        recorder.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
        recorder.onstop = () => {
            stream.getTracks().forEach((t) => t.stop());
            recorderRef.current = null;
            if (discardRef.current) {
                setStatus("idle");
                flash("Recording discarded.");
                return;
            }
            process(new Blob(chunksRef.current, { type: recorder.mimeType }), ext);
        };
        recorder.start(1000);
        recorderRef.current = recorder;
        setStartedAt(Date.now());
        setStatus("recording");
        setMessage("");
    }, [editor, process]);

    const stop = useCallback((discard = false) => {
        discardRef.current = discard;
        recorderRef.current?.stop();
    }, []);

    const toggle = useCallback(() => {
        if (statusRef.current === "recording") stop();
        else if (statusRef.current === "idle") start();
    }, [start, stop]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyV") {
                e.preventDefault();
                toggle();
            } else if (e.key === "Escape" && statusRef.current === "recording") {
                e.preventDefault();
                stop(true);
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [toggle, stop]);

    // release the mic if the editor unmounts mid-recording
    useEffect(() => () => stop(true), [stop]);

    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const label =
        status === "recording" ? `Listening… ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}  (Esc to discard)`
        : status === "starting" ? "Opening microphone…"
        : status === "transcribing" ? "Transcribing…"
        : status === "tidying" ? "Tidying into bullets…"
        : message;

    return (
        <div
            className="fixed bottom-4 right-4 z-50 flex items-center gap-2 font-poppins text-sm"
            data-app-chrome // hidden in focus mode and print
            onMouseDown={(e) => e.preventDefault()} // don't steal the editor's cursor
        >
            {label && (
                <span className="bg-surface border border-base-300 shadow rounded-full px-3 py-1 text-base-content/90">
                    {label}
                </span>
            )}
            {status === "idle" && (
                <label
                    className="bg-surface border border-base-300 shadow rounded-full px-3 py-1 flex items-center gap-2 cursor-pointer text-base-content/90"
                    title="Turn the transcript into clean bullet points with the selected model"
                >
                    Tidy
                    <input
                        type="checkbox"
                        className="toggle toggle-xs toggle-accent"
                        checked={tidy}
                        onChange={(e) => setTidy(e.target.checked)}
                    />
                </label>
            )}
            <button
                className={
                    "btn btn-circle shadow-lg " +
                    (status === "recording" ? "btn-error animate-pulse" : "btn-accent") +
                    (status === "transcribing" || status === "tidying" ? " loading" : "")
                }
                onClick={toggle}
                disabled={status !== "idle" && status !== "recording"}
                title={status === "recording" ? "Stop and transcribe (Alt+V)" : "Voice brain-dump (Alt+V)"}
            >
                {status === "recording" ? <StopIcon /> : status === "idle" ? <MicIcon /> : null}
            </button>
        </div>
    );
}
