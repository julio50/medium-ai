import { useEffect, useRef, useState } from "react";
import { Activity, dismissNotice, useActivities, useNotices } from "../ai/activity";

function Elapsed({ since }: { since: number }) {
    const [, tick] = useState(0);
    useEffect(() => {
        const t = setInterval(() => tick((n) => n + 1), 1000);
        return () => clearInterval(t);
    }, []);
    const s = Math.floor((Date.now() - since) / 1000);
    return <>{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</>;
}

function ActivityCard({ a }: { a: Activity }) {
    const [expanded, setExpanded] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    // keep the newest reasoning in view while it streams
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [a.thinking, expanded]);

    return (
        <div className="bg-white border border-gray-200 shadow-lg rounded-xl p-3 w-80 font-poppins text-sm text-gray-800">
            <div className="flex items-center gap-2">
                <span className="loading loading-dots loading-xs text-accent" />
                <span className="font-medium">{a.label}</span>
                <span className="text-gray-500">
                    · {a.answering ? "writing" : "thinking"} <Elapsed since={a.startedAt} />
                </span>
                <button
                    className="btn btn-ghost btn-xs ml-auto normal-case"
                    onClick={() => setExpanded(!expanded)}
                    title={expanded ? "Collapse reasoning" : "Show full reasoning"}
                >
                    {expanded ? "less" : "more"}
                </button>
                <button className="btn btn-ghost btn-xs normal-case text-error" onClick={a.cancel}>
                    Cancel
                </button>
            </div>
            <div
                ref={scrollRef}
                className={
                    "mt-2 text-xs italic text-gray-500 whitespace-pre-wrap overflow-y-auto " +
                    (expanded ? "max-h-72" : "max-h-12")
                }
            >
                {a.thinking}
            </div>
        </div>
    );
}

/** Bottom-left stack of in-flight AI work that is thinking, plus notices. */
export default function ThinkingIndicator() {
    const activities = useActivities();
    const notices = useNotices();
    if (activities.length === 0 && notices.length === 0) return null;
    return (
        <div
            className="fixed bottom-4 left-4 z-50 flex flex-col gap-2"
            // keep focus (and the cursor) in the editor: clicking "more"/"less"/
            // Cancel must not blur it, or the in-flight suggestion is dropped
            onMouseDown={(e) => e.preventDefault()}
        >
            {notices.map((n) => (
                <div
                    key={n.id}
                    className="bg-white border border-red-200 shadow-lg rounded-xl p-3 w-80 font-poppins text-sm text-red-700 flex gap-2"
                >
                    <span className="flex-1">{n.text}</span>
                    <button className="btn btn-ghost btn-xs" onClick={() => dismissNotice(n.id)}>
                        ✕
                    </button>
                </div>
            ))}
            {activities.map((a) => (
                <ActivityCard key={a.id} a={a} />
            ))}
        </div>
    );
}
