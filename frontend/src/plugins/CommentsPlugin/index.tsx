import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, $setSelection, RangeSelection } from "lexical";
import CommentIcon from "@mui/icons-material/RateReviewOutlined";
import { AI_EDIT_ENDPOINT, CRITIQUE_ENDPOINT } from "../../constants";
import { modelParams, useAISettings } from "../../ai/settings";
import { isAbort, streamAI } from "../../ai/stream";
import { notify } from "../../ai/activity";
import { findLens, Lens, lensColor, useLenses, withAlpha } from "../../comments/lenses";
import { useTheme } from "../../theme/theme";
import { CommentStatus, loadComments, newCommentId, ReviewComment, saveComments } from "../../comments/store";
import {
    $collectTextBlocks,
    $selectBlockContent,
    $selectedBlockIndexes,
    domRangeFor,
    resolveAnchor,
    TextBlock,
} from "../../comments/anchors";
import CommentCard from "./CommentCard";
import CommentsPanel, { keepEditorFocus, LensRun, Scope } from "./CommentsPanel";

/** page-coordinate rectangle */
type Rect = { x: number; y: number; w: number; h: number };

type Anchor = {
    blockKey: string;
    blockIndex: number;
    start: number;
    /** the comment is about the whole paragraph (no quote) */
    whole: boolean;
    /** where the card would like to sit */
    top: number;
    /** quote highlight (or the paragraph's left bar for whole-paragraph comments) */
    rects: Rect[];
};

type Layout = {
    mode: "margin" | "drawer";
    left: number;
    width: number;
    minTop: number;
    anchors: Record<string, Anchor>;
    stale: string[];
};

const EMPTY_LAYOUT: Layout = { mode: "margin", left: 0, width: 0, minTop: 0, anchors: {}, stale: [] };
const MARGIN_GAP = 16; // editor column -> cards
const MIN_CARD_WIDTH = 220; // below this the comments move into a drawer
const MAX_CARD_WIDTH = 300;
const CARD_GAP = 8;

/** merge the per-element rects of one line so overlapping fills don't darken */
function mergeRects(list: DOMRectList | DOMRect[]): Rect[] {
    const rects = Array.from(list)
        .filter((r) => r.width > 0.5 && r.height > 0.5)
        .map((r) => ({ x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }))
        .sort((a, b) => a.y - b.y || a.x - b.x);
    const out: Rect[] = [];
    for (const r of rects) {
        const prev = out[out.length - 1];
        if (prev && Math.abs(prev.y - r.y) < 3 && Math.abs(prev.h - r.h) < 3 && r.x <= prev.x + prev.w + 1) {
            const right = Math.max(prev.x + prev.w, r.x + r.w);
            prev.w = right - prev.x;
        } else out.push({ ...r });
    }
    return out;
}

function fixInstruction(c: ReviewComment, lensName: string): string {
    return [
        `Revise this paragraph to address a reviewer's comment (${lensName} lens).`,
        `Comment: ${c.comment}`,
        c.suggestion ? `Suggested fix: ${c.suggestion}` : "",
        c.quote ? `The comment is about this part: "${c.quote}"` : "",
        "Change only what is needed to address the comment. Keep everything else, the voice and the language as they are, and return the whole revised paragraph.",
    ]
        .filter(Boolean)
        .join("\n");
}

/** Validate one streamed comment against the paragraphs that were sent. */
function toComment(data: unknown, paragraphs: string[], lens: Lens): ReviewComment | null {
    const d = data as Partial<{ paragraph: number; quote: string; comment: string; suggestion: string }>;
    if (!d || typeof d.paragraph !== "number" || typeof d.comment !== "string" || !d.comment.trim()) return null;
    const text = paragraphs[d.paragraph];
    if (text === undefined) return null;
    const quote = typeof d.quote === "string" && d.quote && text.includes(d.quote) ? d.quote : "";
    return {
        id: newCommentId(),
        lensId: lens.id,
        lensName: lens.name,
        color: lens.color,
        paragraphText: text,
        blockIndex: d.paragraph,
        quote,
        quoteStart: quote ? text.indexOf(quote) : 0,
        comment: d.comment.trim(),
        suggestion: typeof d.suggestion === "string" ? d.suggestion.trim() : "",
        status: "open",
        createdAt: Date.now(),
    };
}

const readBool = (key: string) => {
    try {
        return localStorage.getItem(key) === "true";
    } catch {
        return false;
    }
};

/**
 * Margin comments with lenses: run one or more lenses (devil's advocate,
 * skeptical customer, custom ones...) over the document or the selected
 * paragraphs; each comment appears in the right margin next to its paragraph,
 * in its lens's color, and can be resolved, dismissed or fixed with AI.
 *
 * Alt+C opens the panel, Alt+Shift+C runs the checked lenses. Comments are kept
 * per document in localStorage, outside the Lexical document.
 */
export default function CommentsPlugin({ storageKey }: { storageKey: string }) {
    const [editor] = useLexicalComposerContext();
    const aiSettings = useAISettings();
    const settingsRef = useRef(aiSettings);
    settingsRef.current = aiSettings;
    const { lenses, selected } = useLenses();
    const lensById = useMemo(() => new Map(lenses.map((l) => [l.id, l])), [lenses]);

    // ----- comments of this document
    const [doc, setDoc] = useState(() => ({ key: storageKey, comments: loadComments(storageKey) }));
    useEffect(() => {
        setDoc((d) => (d.key === storageKey ? d : { key: storageKey, comments: loadComments(storageKey) }));
    }, [storageKey]);
    const loadedRef = useRef(doc);
    useEffect(() => {
        if (loadedRef.current === doc) return; // nothing changed since loading
        loadedRef.current = doc;
        saveComments(doc.key, doc.comments);
    }, [doc]);
    const comments = doc.key === storageKey ? doc.comments : [];
    const commentsRef = useRef(comments);
    commentsRef.current = comments;

    const updateComments = useCallback((docKey: string, fn: (list: ReviewComment[]) => ReviewComment[]) => {
        setDoc((d) => (d.key === docKey ? { ...d, comments: fn(d.comments) } : d));
    }, []);
    const setStatus = useCallback(
        (id: string, status: CommentStatus) =>
            updateComments(storageKey, (list) => list.map((c) => (c.id === id ? { ...c, status } : c))),
        [storageKey, updateComments]
    );
    const remove = useCallback(
        (pred: (c: ReviewComment) => boolean) => updateComments(storageKey, (list) => list.filter((c) => !pred(c))),
        [storageKey, updateComments]
    );

    // ----- UI state
    const [panelOpen, setPanelOpen] = useState(false);
    const [scope, setScope] = useState<Scope>("document");
    const [selectionCount, setSelectionCount] = useState(0);
    const [runs, setRuns] = useState<LensRun[]>([]);
    const [hidden, setHidden] = useState<Set<string>>(new Set()); // being replaced by a re-run
    const [fixing, setFixing] = useState<Set<string>>(new Set());
    const theme = useTheme();
    const [active, setActive] = useState<string | null>(null);
    const [hot, setHot] = useState<string[]>([]);
    const [showClosed, setShowClosedState] = useState(() => readBool("comments-show-closed"));
    const setShowClosed = (on: boolean) => {
        setShowClosedState(on);
        try {
            localStorage.setItem("comments-show-closed", String(on));
        } catch {
            /* ignore */
        }
    };
    const controllersRef = useRef<AbortController[]>([]);
    const running = runs.some((r) => r.status === "running");
    const activeRef = useRef(active);
    activeRef.current = active;

    // ----- layout: where every comment points, and where the margin is
    const [layout, setLayout] = useState<Layout>(EMPTY_LAYOUT);
    const layoutRef = useRef(layout);
    layoutRef.current = layout;
    const layoutKeyRef = useRef("");

    const computeLayout = useCallback(() => {
        const root = editor.getRootElement();
        if (!root) return;
        const rootRect = root.getBoundingClientRect();
        const avail = document.documentElement.clientWidth - rootRect.right - MARGIN_GAP - 16;
        const anchors: Record<string, Anchor> = {};
        const stale: string[] = [];
        editor.getEditorState().read(() => {
            const blocks = $collectTextBlocks();
            for (const c of commentsRef.current) {
                const a = resolveAnchor(c, blocks);
                if (!a) {
                    stale.push(c.id);
                    continue;
                }
                const block = blocks[a.blockIndex];
                const el = editor.getElementByKey(block.key);
                if (!el) {
                    stale.push(c.id);
                    continue;
                }
                const blockRect = el.getBoundingClientRect();
                const whole = !c.quote;
                let rects: Rect[];
                if (whole) {
                    rects = [{ x: blockRect.left + window.scrollX - 14, y: blockRect.top + window.scrollY, w: 3, h: blockRect.height }];
                } else {
                    const range = domRangeFor(editor, block, a.start, a.end);
                    rects = range ? mergeRects(range.getClientRects()) : [];
                    if (rects.length === 0) rects = mergeRects([blockRect]);
                }
                anchors[c.id] = {
                    blockKey: block.key,
                    blockIndex: a.blockIndex,
                    start: a.start,
                    whole,
                    top: (whole ? blockRect.top + window.scrollY : rects[0].y) - 6,
                    rects,
                };
            }
        });
        const next: Layout = {
            mode: avail >= MIN_CARD_WIDTH ? "margin" : "drawer",
            left: rootRect.right + window.scrollX + MARGIN_GAP,
            width: Math.min(MAX_CARD_WIDTH, Math.max(0, avail)),
            minTop: rootRect.top + window.scrollY,
            anchors,
            stale,
        };
        const key = JSON.stringify(next);
        if (key !== layoutKeyRef.current) {
            layoutKeyRef.current = key;
            setLayout(next);
        }
    }, [editor]);

    const rafRef = useRef(0);
    const scheduleLayout = useCallback(() => {
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = 0;
            computeLayout();
        });
    }, [computeLayout]);
    useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

    useEffect(scheduleLayout, [comments, scheduleLayout]);

    useEffect(() => {
        const onScrollOrResize = () => scheduleLayout();
        window.addEventListener("resize", onScrollOrResize);
        window.addEventListener("scroll", onScrollOrResize, true);
        document.fonts?.ready.then(scheduleLayout).catch(() => undefined);
        let observer: ResizeObserver | null = null;
        const unregisterRoot = editor.registerRootListener((root) => {
            observer?.disconnect();
            observer = null;
            if (root) {
                observer = new ResizeObserver(scheduleLayout);
                observer.observe(root);
            }
        });
        const unregisterUpdate = editor.registerUpdateListener(({ editorState }) => {
            scheduleLayout();
            editorState.read(() => {
                const n = $selectedBlockIndexes($collectTextBlocks()).length;
                setSelectionCount((prev) => (prev === n ? prev : n));
            });
        });
        return () => {
            window.removeEventListener("resize", onScrollOrResize);
            window.removeEventListener("scroll", onScrollOrResize, true);
            observer?.disconnect();
            unregisterRoot();
            unregisterUpdate();
        };
    }, [editor, scheduleLayout]);

    const isShown = useCallback(
        (c: ReviewComment) => !hidden.has(c.id) && (c.status === "open" || showClosed),
        [hidden, showClosed]
    );
    const staleSet = useMemo(() => new Set(layout.stale), [layout.stale]);
    // anchored comments, in document order
    const placed = useMemo(
        () =>
            comments
                .filter((c) => isShown(c) && layout.anchors[c.id])
                .sort((a, b) => {
                    const x = layout.anchors[a.id], y = layout.anchors[b.id];
                    return x.blockIndex - y.blockIndex || x.start - y.start || a.createdAt - b.createdAt;
                }),
        [comments, isShown, layout.anchors]
    );
    const staleComments = comments.filter((c) => isShown(c) && staleSet.has(c.id));
    const counts = {
        open: comments.filter((c) => c.status === "open" && !hidden.has(c.id) && !staleSet.has(c.id)).length,
        resolved: comments.filter((c) => c.status === "resolved").length,
        dismissed: comments.filter((c) => c.status === "dismissed").length,
        stale: comments.filter((c) => c.status === "open" && staleSet.has(c.id)).length,
    };

    // ----- stack the margin cards next to their paragraphs without overlaps
    const marginRef = useRef<HTMLDivElement>(null);
    const positionCards = useCallback(() => {
        const container = marginRef.current;
        const { anchors, minTop } = layoutRef.current;
        if (!container) return;
        const items = Array.from(container.querySelectorAll<HTMLElement>(":scope > [data-comment-id]"))
            .map((el) => ({ el, a: anchors[el.dataset.commentId!], h: el.offsetHeight }))
            .filter((i) => i.a);
        // DOM order is document order already (see `placed`)
        const tops = items.map((i) => Math.max(minTop, i.a.top));
        const forward = (from: number) => {
            for (let i = Math.max(1, from); i < items.length; i++) {
                tops[i] = Math.max(tops[i], tops[i - 1] + items[i - 1].h + CARD_GAP);
            }
        };
        const ai = items.findIndex((i) => i.el.dataset.commentId === activeRef.current);
        if (ai <= 0) forward(1);
        else {
            // the active card sits exactly next to its quote; the others make room
            forward(ai + 1);
            for (let i = ai - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - items[i].h - CARD_GAP);
            if (tops[0] < minTop) {
                tops[0] = minTop;
                forward(1);
            }
        }
        items.forEach((i, k) => (i.el.style.top = `${tops[k]}px`));
    }, []);

    useLayoutEffect(positionCards, [positionCards, layout, placed, active, lensById]);
    useEffect(() => {
        const container = marginRef.current;
        if (!container || layout.mode !== "margin") return;
        const observer = new ResizeObserver(() => positionCards());
        Array.from(container.children).forEach((el) => observer.observe(el));
        return () => observer.disconnect();
    }, [layout.mode, placed, positionCards]);

    // ----- hover / click in the document highlights the matching cards
    const placedRef = useRef(placed);
    placedRef.current = placed;
    useEffect(() => {
        const hitTest = (e: MouseEvent): string[] => {
            const { anchors } = layoutRef.current;
            const shown = new Set(placedRef.current.map((c) => c.id));
            const ids = Object.keys(anchors).filter((id) => shown.has(id));
            const inQuote = ids.filter((id) =>
                !anchors[id].whole &&
                anchors[id].rects.some((r) => e.pageX >= r.x - 1 && e.pageX <= r.x + r.w + 1 && e.pageY >= r.y - 1 && e.pageY <= r.y + r.h + 1)
            );
            if (inQuote.length) return inQuote;
            const target = e.target as Node;
            return ids.filter((id) => editor.getElementByKey(anchors[id].blockKey)?.contains(target));
        };
        let current = "";
        const onMove = (e: MouseEvent) => {
            const ids = hitTest(e);
            const key = ids.join(",");
            if (key !== current) {
                current = key;
                setHot(ids);
            }
        };
        const onLeave = () => {
            current = "";
            setHot([]);
        };
        const onDown = (e: MouseEvent) => {
            const { anchors } = layoutRef.current;
            const quote = hitTest(e).find((id) => !anchors[id].whole);
            setActive(quote ?? null);
        };
        return editor.registerRootListener((root, prev) => {
            prev?.removeEventListener("mousemove", onMove);
            prev?.removeEventListener("mouseleave", onLeave);
            prev?.removeEventListener("mousedown", onDown);
            root?.addEventListener("mousemove", onMove);
            root?.addEventListener("mouseleave", onLeave);
            root?.addEventListener("mousedown", onDown);
        });
    }, [editor]);
    const [hoverCard, setHoverCard] = useState<string | null>(null);
    const hotSet = useMemo(() => new Set(hoverCard ? [...hot, hoverCard] : hot), [hot, hoverCard]);

    const activate = (id: string) => {
        setActive(id);
        const a = layoutRef.current.anchors[id];
        if (!a) return;
        const r = a.rects[0];
        const viewTop = r.y - window.scrollY;
        if (viewTop < 80 || viewTop + r.h > window.innerHeight - 80) {
            window.scrollTo({ top: Math.max(0, r.y - window.innerHeight / 3), behavior: "smooth" });
        }
    };

    // in the drawer, bring the active card into view (e.g. after clicking its quote)
    const drawerListRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!active || layout.mode !== "drawer") return;
        drawerListRef.current?.querySelector(`[data-comment-id="${active}"]`)?.scrollIntoView({ block: "nearest" });
    }, [active, layout.mode]);
    useEffect(() => {
        // clicking a highlighted quote on a narrow screen opens the drawer at its card
        if (active && layoutRef.current.mode === "drawer" && layoutRef.current.anchors[active]) setPanelOpen(true);
    }, [active]);

    // ----- run lenses
    const runLenses = useCallback(
        (lensIds: string[]) => {
            const chosen = lensIds.map(findLens).filter((l): l is Lens => !!l);
            if (chosen.length === 0 || runs.some((r) => r.status === "running")) return;
            let blocks: TextBlock[] = [];
            let targets: number[] | null = null;
            editor.getEditorState().read(() => {
                blocks = $collectTextBlocks();
                if (scope === "selection") targets = $selectedBlockIndexes(blocks);
            });
            if (blocks.length === 0) {
                notify("Nothing to review yet: write something first.", 5000);
                return;
            }
            if (targets !== null && (targets as number[]).length === 0) targets = null;
            const targetSet = targets ? new Set<number>(targets) : null;
            const paragraphs = blocks.map((b) => b.text);
            const docKey = storageKey;
            const controller = new AbortController();
            controllersRef.current.push(controller);
            setRuns(chosen.map((l) => ({ lensId: l.id, name: l.name, color: l.color, status: "running", count: 0 })));
            const patchRun = (lensId: string, patch: (r: LensRun) => Partial<LensRun>) =>
                setRuns((list) => list.map((r) => (r.lensId === lensId ? { ...r, ...patch(r) } : r)));

            let pending = chosen.length;
            for (const lens of chosen) {
                // a re-run replaces this lens's open comments in the reviewed paragraphs
                const replaced = new Set(
                    commentsRef.current
                        .filter((c) => {
                            if (c.lensId !== lens.id || c.status !== "open") return false;
                            if (!targetSet) return true;
                            const a = resolveAnchor(c, blocks);
                            return !!a && targetSet.has(a.blockIndex);
                        })
                        .map((c) => c.id)
                );
                setHidden((h) => new Set([...h, ...replaced]));
                const unhide = () =>
                    setHidden((h) => new Set([...h].filter((id) => !replaced.has(id))));

                streamAI(
                    CRITIQUE_ENDPOINT,
                    {
                        paragraphs,
                        targets,
                        lens: { name: lens.name, instruction: lens.instruction },
                        ...modelParams(settingsRef.current),
                    },
                    {
                        label: `${lens.name} comments`,
                        signal: controller.signal,
                        onItem: (data) => {
                            const c = toComment(data, paragraphs, lens);
                            if (!c) return;
                            updateComments(docKey, (list) => [...list, c]);
                            patchRun(lens.id, (r) => ({ count: r.count + 1 }));
                        },
                    }
                )
                    .then(() => {
                        updateComments(docKey, (list) => list.filter((c) => !replaced.has(c.id)));
                        patchRun(lens.id, () => ({ status: "done" }));
                    })
                    .catch((e) => {
                        if (isAbort(e)) {
                            patchRun(lens.id, () => ({ status: "cancelled" }));
                        } else {
                            const message = e instanceof Error ? e.message : String(e);
                            patchRun(lens.id, () => ({ status: "error", error: message }));
                        }
                    })
                    .finally(() => {
                        unhide();
                        if (--pending === 0) {
                            controllersRef.current = controllersRef.current.filter((c) => c !== controller);
                        }
                    });
            }
        },
        [editor, runs, scope, storageKey, updateComments]
    );

    const cancelRuns = () => {
        controllersRef.current.forEach((c) => c.abort());
        controllersRef.current = [];
    };
    useEffect(() => () => controllersRef.current.forEach((c) => c.abort()), []);

    // ----- fix with AI: stream a revision of the paragraph into the document
    const fixWithAI = async (c: ReviewComment) => {
        let block: TextBlock | null = null;
        editor.getEditorState().read(() => {
            const blocks = $collectTextBlocks();
            const a = resolveAnchor(c, blocks);
            block = a ? blocks[a.blockIndex] : null;
        });
        if (!block) {
            notify("This comment's text has changed, so it can't be fixed automatically.", 6000);
            return;
        }
        const target: TextBlock = block;
        const lensName = lensById.get(c.lensId)?.name ?? c.lensName;
        const controller = new AbortController();
        setFixing((s) => new Set(s).add(c.id));
        let insertAt: RangeSelection | null = null;
        let started = false;
        try {
            await streamAI(
                AI_EDIT_ENDPOINT,
                {
                    instruction: fixInstruction(c, lensName),
                    selectedText: target.text,
                    temperature: 20,
                    ...modelParams(settingsRef.current),
                },
                {
                    label: `Fix: ${lensName}`,
                    signal: controller.signal,
                    onText: (chunk) => {
                        const first = !started;
                        started = true;
                        editor.update(
                            () => {
                                // first chunk replaces the paragraph, later ones append
                                const sel = first ? $selectBlockContent(target.key) : insertAt?.clone() ?? null;
                                if (!sel) {
                                    controller.abort();
                                    return;
                                }
                                $setSelection(sel);
                                const selection = $getSelection();
                                if (!$isRangeSelection(selection)) return;
                                selection.insertText(chunk);
                                const after = $getSelection();
                                insertAt = $isRangeSelection(after) ? after.clone() : null;
                            },
                            // one undo step for the whole fix
                            { tag: first ? undefined : "history-merge" }
                        );
                    },
                }
            );
            setStatus(c.id, "resolved");
        } catch (e) {
            if (isAbort(e)) return;
            const message = e instanceof Error ? e.message : String(e);
            notify(started ? `Fix stopped early: ${message} Press Ctrl+Z to undo it.` : `Fix with AI failed: ${message}`);
        } finally {
            setFixing((s) => {
                const n = new Set(s);
                n.delete(c.id);
                return n;
            });
        }
    };

    // ----- shortcuts: Alt+C panel, Alt+Shift+C run, Esc closes / deselects
    const runRef = useRef(runLenses);
    runRef.current = runLenses;
    const selectedRef = useRef(selected);
    selectedRef.current = selected;
    const panelOpenRef = useRef(panelOpen);
    panelOpenRef.current = panelOpen;
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyC") {
                e.preventDefault();
                if (e.shiftKey) {
                    if (selectedRef.current.length) runRef.current(selectedRef.current);
                    else setPanelOpen(true);
                } else setPanelOpen((o) => !o);
            } else if (e.key === "Escape" && (panelOpenRef.current || activeRef.current)) {
                const t = e.target as HTMLElement | null;
                if (t?.closest?.("input, textarea")) return; // the lens editor handles its own Esc
                setPanelOpen(false);
                setActive(null);
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, []);

    // ----- render
    // as drawn: lens colours get lighter variants on the dark theme
    const colorOf = (c: ReviewComment) => lensColor(lensById.get(c.lensId)?.color ?? c.color, theme);
    const card = (c: ReviewComment, opts: { stale?: boolean; className?: string } = {}) => (
        <CommentCard
            key={c.id}
            c={c}
            color={colorOf(c)}
            lensName={lensById.get(c.lensId)?.name ?? c.lensName}
            active={active === c.id}
            hot={hotSet.has(c.id)}
            stale={opts.stale}
            fixing={fixing.has(c.id)}
            className={opts.className}
            onActivate={() => (opts.stale ? setActive(c.id) : activate(c.id))}
            onHover={(on) => setHoverCard((h) => (on ? c.id : h === c.id ? null : h))}
            onResolve={() => setStatus(c.id, "resolved")}
            onDismiss={() => setStatus(c.id, "dismissed")}
            onReopen={() => setStatus(c.id, "open")}
            onDelete={() => remove((x) => x.id === c.id)}
            onFix={() => fixWithAI(c)}
        />
    );

    const staleSection = staleComments.length > 0 && (
        <section className="flex flex-col gap-2">
            <div className="flex items-center text-xs text-base-content/60">
                <span>Text changed since these were written</span>
                <button
                    className="btn btn-ghost btn-xs normal-case font-normal ml-auto"
                    onClick={() => remove((c) => staleSet.has(c.id))}
                >
                    Delete
                </button>
            </div>
            {staleComments.map((c) => card(c, { stale: true }))}
        </section>
    );

    const highlights = placed.map((c) => {
        const a = layout.anchors[c.id];
        if (c.status !== "open" && active !== c.id) return null;
        const color = colorOf(c);
        const strong = active === c.id || hotSet.has(c.id);
        return a.rects.map((r, i) => (
            <div
                key={`${c.id}-${i}`}
                className="absolute pointer-events-none rounded-sm"
                style={{
                    left: r.x,
                    top: r.y,
                    width: r.w,
                    height: r.h,
                    background: a.whole ? withAlpha(color, strong ? 0.9 : 0.45) : strong ? withAlpha(color, 0.2) : undefined,
                    borderBottom: a.whole ? undefined : `2px solid ${withAlpha(color, strong ? 0.9 : 0.5)}`,
                    // tint the text under it without hiding it: darken on white, lighten on dark
                    mixBlendMode: theme === "dark" ? "screen" : "multiply",
                }}
            />
        ));
    });

    return createPortal(
        <>
            <div data-app-chrome className="absolute top-0 left-0 z-0" aria-hidden>
                {highlights}
            </div>

            {layout.mode === "margin" && (
                <div
                    ref={marginRef}
                    data-app-chrome
                    className="absolute top-0 z-20"
                    style={{ left: layout.left, width: layout.width }}
                    onMouseDown={keepEditorFocus}
                    aria-label="Margin comments"
                >
                    {placed.map((c) => card(c, { className: "absolute left-0 right-0 transition-[top] duration-150" }))}
                </div>
            )}

            {panelOpen && (
                <CommentsPanel
                    variant={layout.mode === "drawer" ? "drawer" : "popover"}
                    scope={scope}
                    setScope={setScope}
                    selectionCount={selectionCount}
                    runs={runs}
                    running={running}
                    onRun={runLenses}
                    onCancel={cancelRuns}
                    counts={counts}
                    showClosed={showClosed}
                    setShowClosed={setShowClosed}
                    onClearClosed={() => remove((c) => c.status !== "open")}
                    onClearAll={() => remove(() => true)}
                    onClose={() => setPanelOpen(false)}
                >
                    {layout.mode === "drawer" && (
                        <div ref={drawerListRef} className="flex flex-col gap-2">
                            {placed.length === 0 && !staleSection && (
                                <p className="text-xs text-base-content/50">No comments yet. Pick lenses and press Run.</p>
                            )}
                            {placed.map((c) => card(c))}
                        </div>
                    )}
                    {staleSection}
                </CommentsPanel>
            )}

            <button
                data-app-chrome="fade"
                className={
                    "fixed bottom-20 right-4 z-40 btn btn-sm normal-case gap-2 rounded-full shadow bg-surface hover:bg-base-200/50 border-base-300 hover:border-base-300 text-base-content/90 font-poppins font-normal " +
                    (panelOpen ? "border-base-content/40 hover:border-base-content/40" : "")
                }
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setPanelOpen((o) => !o)}
                title="Margin comments: review with lenses (Alt+C; Alt+Shift+C runs the checked lenses)"
            >
                {running ? <span className="loading loading-spinner loading-xs" /> : <CommentIcon sx={{ fontSize: 18 }} />}
                Comments
                {counts.open > 0 && <span className="badge badge-sm badge-accent">{counts.open}</span>}
            </button>
        </>,
        document.body
    );
}
