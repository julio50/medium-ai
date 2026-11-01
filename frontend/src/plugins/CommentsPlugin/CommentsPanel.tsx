import { ReactNode, useState } from "react";
import CloseIcon from "@mui/icons-material/Close";
import EditIcon from "@mui/icons-material/EditOutlined";
import CopyIcon from "@mui/icons-material/ContentCopyOutlined";
import { Lens, LENS_COLORS, lensColor, newLensId, useLenses } from "../../comments/lenses";
import { useTheme } from "../../theme/theme";
import LensEditor from "./LensEditor";

export type Scope = "document" | "selection";

export type LensRun = {
    lensId: string;
    name: string;
    color: string;
    status: "running" | "done" | "cancelled" | "error";
    count: number;
    error?: string;
};

type Props = {
    variant: "popover" | "drawer";
    scope: Scope;
    setScope: (s: Scope) => void;
    selectionCount: number;
    runs: LensRun[];
    running: boolean;
    onRun: (lensIds: string[]) => void;
    onCancel: () => void;
    counts: { open: number; resolved: number; dismissed: number; stale: number };
    showClosed: boolean;
    setShowClosed: (on: boolean) => void;
    onClearClosed: () => void;
    onClearAll: () => void;
    onClose: () => void;
    children?: ReactNode;
};

/** keep the editor's cursor/selection: only text fields may take focus */
export function keepEditorFocus(e: React.MouseEvent) {
    const t = e.target as HTMLElement;
    if (!t.closest("input, textarea, select")) e.preventDefault();
}

export default function CommentsPanel(p: Props) {
    const theme = useTheme();
    const shown = (color: string) => lensColor(color, theme);
    const { lenses, selected, toggleSelected, saveLens, deleteLens } = useLenses();
    const [editing, setEditing] = useState<{ lens: Lens; isNew: boolean } | null>(null);
    const [confirmClear, setConfirmClear] = useState(false);
    const scope = p.selectionCount === 0 ? "document" : p.scope;
    const closed = p.counts.resolved + p.counts.dismissed;

    const startNew = (from?: Lens) =>
        setEditing({
            isNew: true,
            lens: from
                ? { ...from, id: newLensId(), name: `${from.name} (copy)`, builtin: false }
                : { id: newLensId(), name: "", instruction: "", color: LENS_COLORS[(lenses.length + 3) % LENS_COLORS.length] },
        });

    return (
        <div
            data-app-chrome
            onMouseDown={keepEditorFocus}
            className={
                "bg-surface border border-base-300 shadow-lg font-poppins text-sm text-base-content flex flex-col " +
                (p.variant === "drawer"
                    ? "fixed top-0 right-0 bottom-0 z-50 w-full max-w-sm rounded-none border-y-0 border-r-0"
                    : "fixed bottom-36 right-4 z-50 w-80 max-h-[calc(100vh-10rem)] rounded-xl")
            }
        >
            <div className="flex items-center px-3 pt-3 pb-2">
                <span className="font-medium">Margin comments</span>
                <span className="ml-2 text-xs text-base-content/50">Alt+C</span>
                <button className="btn btn-ghost btn-xs btn-square ml-auto" onClick={p.onClose} title="Close (Esc)">
                    <CloseIcon fontSize="small" />
                </button>
            </div>

            <div className="overflow-y-auto px-3 pb-3 flex flex-col gap-3">
                <section>
                    <div className="text-xs text-base-content/60 mb-1">Lenses</div>
                    <ul className="flex flex-col">
                        {lenses.map((l) => (
                            <li key={l.id} className="group flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-base-200/50">
                                <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer" title={l.instruction}>
                                    <input
                                        type="checkbox"
                                        className="checkbox checkbox-xs"
                                        style={{ borderColor: shown(l.color), ...(selected.includes(l.id) ? { backgroundColor: shown(l.color) } : {}) }}
                                        checked={selected.includes(l.id)}
                                        onChange={() => toggleSelected(l.id)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    />
                                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: shown(l.color) }} />
                                    <span className="truncate">{l.name}</span>
                                </label>
                                <button
                                    className="btn btn-ghost btn-xs btn-square opacity-0 group-hover:opacity-100 focus:opacity-100"
                                    onClick={() => (l.builtin ? startNew(l) : setEditing({ lens: l, isNew: false }))}
                                    title={l.builtin ? "Copy into a custom lens you can edit" : "Edit lens"}
                                >
                                    {l.builtin ? <CopyIcon sx={{ fontSize: 14 }} /> : <EditIcon sx={{ fontSize: 14 }} />}
                                </button>
                            </li>
                        ))}
                    </ul>
                    {editing ? (
                        <div className="mt-2">
                            <LensEditor
                                key={editing.lens.id}
                                lens={editing.lens}
                                isNew={editing.isNew}
                                onSave={(lens) => {
                                    saveLens(lens);
                                    setEditing(null);
                                }}
                                onDelete={() => {
                                    deleteLens(editing.lens.id);
                                    setEditing(null);
                                }}
                                onCancel={() => setEditing(null)}
                            />
                        </div>
                    ) : (
                        <button className="btn btn-ghost btn-xs normal-case font-normal mt-1" onClick={() => startNew()}>
                            + New lens
                        </button>
                    )}
                </section>

                <section className="flex flex-col gap-2">
                    <div className="btn-group w-full">
                        <button
                            className={"btn btn-xs normal-case flex-1 " + (scope === "document" ? "btn-active" : "btn-ghost border-base-300")}
                            onClick={() => p.setScope("document")}
                        >
                            Whole document
                        </button>
                        <button
                            className={"btn btn-xs normal-case flex-1 " + (scope === "selection" ? "btn-active" : "btn-ghost border-base-300")}
                            disabled={p.selectionCount === 0}
                            onClick={() => p.setScope("selection")}
                            title={p.selectionCount === 0 ? "Put the cursor in, or select, the paragraphs to review" : undefined}
                        >
                            Selection{p.selectionCount ? ` (${p.selectionCount} ¶)` : ""}
                        </button>
                    </div>
                    {p.running ? (
                        <button className="btn btn-sm btn-outline normal-case" onClick={p.onCancel}>
                            Cancel
                        </button>
                    ) : (
                        <button
                            className="btn btn-sm btn-accent normal-case"
                            disabled={selected.length === 0}
                            onClick={() => p.onRun(selected)}
                            title="Alt+Shift+C"
                        >
                            {selected.length === 0
                                ? "Pick a lens"
                                : `Run ${selected.length === 1 ? lenses.find((l) => l.id === selected[0])?.name : `${selected.length} lenses`}`}
                        </button>
                    )}
                    {p.runs.length > 0 && (
                        <ul className="flex flex-col gap-0.5 text-xs">
                            {p.runs.map((r) => (
                                <li key={r.lensId} className="flex items-center gap-2">
                                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: shown(r.color) }} />
                                    <span className="truncate">{r.name}</span>
                                    <span className={"ml-auto shrink-0 " + (r.status === "error" ? "text-error" : "text-base-content/60")}>
                                        {r.status === "running" && <span className="loading loading-dots loading-xs align-middle mr-1" />}
                                        {r.status === "error"
                                            ? "failed"
                                            : `${r.count} comment${r.count === 1 ? "" : "s"}${r.status === "running" ? "…" : r.status === "cancelled" ? " (stopped)" : ""}`}
                                    </span>
                                </li>
                            ))}
                            {p.runs
                                .filter((r) => r.error)
                                .map((r) => (
                                    <li key={r.lensId + "-err"} className="text-error break-words">
                                        {r.name}: {r.error}
                                    </li>
                                ))}
                        </ul>
                    )}
                </section>

                <section className="text-xs text-base-content/60 flex flex-col gap-1">
                    <div>
                        {p.counts.open} open · {p.counts.resolved} resolved · {p.counts.dismissed} dismissed
                        {p.counts.stale > 0 && ` · ${p.counts.stale} stale`}
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            className="toggle toggle-xs toggle-accent"
                            checked={p.showClosed}
                            onChange={(e) => p.setShowClosed(e.target.checked)}
                            onMouseDown={(e) => e.preventDefault()}
                        />
                        Show resolved &amp; dismissed
                    </label>
                    <div className="flex gap-1 -mx-2">
                        <button className="btn btn-ghost btn-xs normal-case font-normal" disabled={closed === 0} onClick={p.onClearClosed}>
                            Delete resolved &amp; dismissed
                        </button>
                        {confirmClear ? (
                            <button
                                className="btn btn-ghost btn-xs normal-case font-normal text-error"
                                onClick={() => {
                                    p.onClearAll();
                                    setConfirmClear(false);
                                }}
                                onMouseLeave={() => setConfirmClear(false)}
                            >
                                Really delete all?
                            </button>
                        ) : (
                            <button
                                className="btn btn-ghost btn-xs normal-case font-normal"
                                disabled={p.counts.open + closed + p.counts.stale === 0}
                                onClick={() => setConfirmClear(true)}
                            >
                                Delete all
                            </button>
                        )}
                    </div>
                </section>

                {p.children}
            </div>
        </div>
    );
}

