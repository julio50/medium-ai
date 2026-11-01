import { forwardRef } from "react";
import { ReviewComment } from "../../comments/store";
import { withAlpha } from "../../comments/lenses";

type Props = {
    c: ReviewComment;
    color: string;
    lensName: string;
    active: boolean;
    hot: boolean;
    stale?: boolean;
    fixing: boolean;
    onActivate: () => void;
    onHover: (on: boolean) => void;
    onResolve: () => void;
    onDismiss: () => void;
    onReopen: () => void;
    onDelete: () => void;
    onFix: () => void;
    className?: string;
};

/** One margin comment. Buttons never take focus away from the editor (the
 *  container that renders cards prevents mousedown's default). */
const CommentCard = forwardRef<HTMLDivElement, Props>(function CommentCard(
    { c, color, lensName, active, hot, stale, fixing, onActivate, onHover, onResolve, onDismiss, onReopen, onDelete, onFix, className },
    ref
) {
    const open = c.status === "open";
    return (
        <div
            ref={ref}
            data-comment-id={c.id}
            className={
                "bg-surface border rounded-xl p-3 font-poppins text-sm text-base-content cursor-pointer transition-shadow " +
                (active ? "shadow-lg border-base-content/20 " : hot ? "shadow-md border-base-content/20 " : "shadow-sm border-base-300 ") +
                (open && !stale ? "" : "opacity-60 ") +
                (className ?? "")
            }
            style={{ borderLeft: `4px solid ${color}`, boxShadow: hot && !active ? `0 0 0 2px ${withAlpha(color, 0.35)}` : undefined }}
            onClick={onActivate}
            onMouseEnter={() => onHover(true)}
            onMouseLeave={() => onHover(false)}
        >
            <div className="flex items-center gap-2 text-xs">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                <span className="font-medium truncate" style={{ color }}>
                    {lensName}
                </span>
                {!open && <span className="ml-auto text-base-content/50 capitalize">{c.status}</span>}
                {open && stale && <span className="ml-auto text-base-content/50">text changed</span>}
            </div>
            <div
                className={"mt-1.5 text-xs italic text-base-content/60 border-l-2 pl-2 " + (active ? "" : "line-clamp-2")}
                style={{ borderColor: withAlpha(color, 0.5) }}
            >
                {c.quote ? `“${c.quote}”` : "Whole paragraph"}
            </div>
            <p className={"mt-1.5 leading-snug whitespace-pre-wrap " + (active ? "" : "line-clamp-4")}>{c.comment}</p>
            {c.suggestion && active && (
                <p className="mt-1.5 text-xs leading-snug text-base-content/75 whitespace-pre-wrap">
                    <span className="font-medium text-base-content/90">Suggestion: </span>
                    {c.suggestion}
                </p>
            )}
            <div className="mt-2 flex items-center gap-1 -mx-1" onClick={(e) => e.stopPropagation()}>
                {open ? (
                    <>
                        <button className="btn btn-ghost btn-xs normal-case font-normal" onClick={onResolve} title="Mark as handled">
                            Resolve
                        </button>
                        <button className="btn btn-ghost btn-xs normal-case font-normal" onClick={onDismiss} title="Not useful: hide it">
                            Dismiss
                        </button>
                        {!stale && (
                            <button
                                className={"btn btn-ghost btn-xs normal-case font-normal ml-auto " + (fixing ? "loading" : "")}
                                style={{ color }}
                                disabled={fixing}
                                onClick={onFix}
                                title="Rewrite this paragraph with AI to address the comment (Ctrl+Z undoes it)"
                            >
                                {fixing ? "Fixing" : "Fix with AI"}
                            </button>
                        )}
                    </>
                ) : (
                    <>
                        <button className="btn btn-ghost btn-xs normal-case font-normal" onClick={onReopen}>
                            Reopen
                        </button>
                        <button className="btn btn-ghost btn-xs normal-case font-normal text-base-content/60" onClick={onDelete}>
                            Delete
                        </button>
                    </>
                )}
            </div>
        </div>
    );
});

export default CommentCard;
