import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNodeByKey, $getSelection, $isRangeSelection, $isRootNode, LexicalNode, NodeKey } from "lexical";
import { mergeRegister } from "@lexical/utils";
import {
    FOCUS_MODE_SHORTCUT,
    isFocusModeShortcut,
    setFocusMode,
    toggleFocusMode,
    useFocusMode,
} from "./focusMode";

/*
 * Focus mode: the top-level block holding the cursor stays fully visible, the
 * other blocks are dimmed, and app chrome fades out (see the "Focus mode"
 * section of index.css).
 *
 * Everything here is DOM-only: `focus-mode` on <html>, `data-focus-active` on
 * the active block's element and `data-focus-dim` on the editor root. Nothing
 * touches the Lexical document, so it's never saved. Data attributes (rather
 * than classes) because some decorator nodes overwrite their element's
 * className when they're selected.
 */
const ACTIVE_ATTR = "data-focus-active";
const DIM_ATTR = "data-focus-dim";
const REVEAL_ATTR = "data-focus-reveal";
const HTML_CLASS = "focus-mode";
/** Mouse this close to the top edge (px) brings the menu bar back. */
const REVEAL_ZONE = 48;
/** Typewriter scrolling only recenters when the caret drifts this far (px). */
const RECENTER_THRESHOLD = 72;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/** The top-level block the selection is in; null if there is none. */
function $getActiveBlockKey(): NodeKey | null {
    const selection = $getSelection();
    if (selection === null) return null;
    let node: LexicalNode | null;
    if ($isRangeSelection(selection)) {
        node = selection.focus.getNode();
        // a selection on the root itself points at one of its children
        if ($isRootNode(node)) {
            const size = node.getChildrenSize();
            node = size > 0 ? node.getChildAtIndex(Math.min(selection.focus.offset, size - 1)) : null;
        }
    } else {
        node = selection.getNodes()[0] ?? null;
    }
    if (node === null || $isRootNode(node)) return null;
    return node.getTopLevelElement()?.getKey() ?? null;
}

export default function FocusModePlugin() {
    const [editor] = useLexicalComposerContext();
    const enabled = useFocusMode();

    // the shortcut works whether or not focus mode is on
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (isFocusModeShortcut(e)) {
                e.preventDefault();
                toggleFocusMode();
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, []);

    useEffect(() => {
        if (!enabled) return;
        const html = document.documentElement;
        html.classList.add(HTML_CLASS);

        let rootElem: HTMLElement | null = null;
        let activeKey: NodeKey | null = null;
        let activeElem: HTMLElement | null = null;
        let lastKeyAt = 0;
        let frame = 0;
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

        const markActive = (elem: HTMLElement | null) => {
            if (elem !== activeElem) {
                activeElem?.removeAttribute(ACTIVE_ATTR);
                activeElem = elem;
            }
            // re-set every time: a block whose DOM was recreated lost it
            activeElem?.setAttribute(ACTIVE_ATTR, "");
            // with nothing active (no cursor yet) nothing is dimmed
            rootElem?.toggleAttribute(DIM_ATTR, activeElem !== null);
        };

        const sync = () => {
            editor.getEditorState().read(() => {
                const key = $getActiveBlockKey();
                // keep the last block while the editor has no selection (e.g. blurred)
                if (key !== null) activeKey = key;
                else if (activeKey !== null && $getNodeByKey(activeKey) === null) activeKey = null;
            });
            markActive(activeKey !== null ? editor.getElementByKey(activeKey) : null);
        };

        // Typewriter scrolling: after the user types or moves the cursor with
        // the keyboard, scroll the caret back toward the middle of the screen.
        // Never in response to mouse/wheel scrolling, so it can't fight the user.
        const recenter = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const sel = window.getSelection();
                if (!rootElem || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return;
                if (!rootElem.contains(sel.anchorNode)) return;
                let rect: DOMRect | undefined = sel.getRangeAt(0).getBoundingClientRect();
                // collapsed ranges in empty blocks have no box
                if (rect.height === 0) rect = activeElem?.getBoundingClientRect();
                if (!rect || rect.height === 0) return;
                const delta = rect.top + Math.min(rect.height, 48) / 2 - window.innerHeight * 0.45;
                if (Math.abs(delta) < RECENTER_THRESHOLD) return;
                window.scrollBy({ top: delta, behavior: reducedMotion.matches ? "auto" : "smooth" });
            });
        };

        const onEditorKeyDown = (e: KeyboardEvent) => {
            if (!MODIFIER_KEYS.has(e.key)) lastKeyAt = performance.now();
        };

        const onMouseMove = (e: MouseEvent) => {
            const reveal = e.clientY <= REVEAL_ZONE;
            if (reveal !== html.hasAttribute(REVEAL_ATTR)) html.toggleAttribute(REVEAL_ATTR, reveal);
        };
        document.addEventListener("mousemove", onMouseMove);

        const unregister = mergeRegister(
            editor.registerRootListener((root, prevRoot) => {
                prevRoot?.removeEventListener("keydown", onEditorKeyDown);
                prevRoot?.removeAttribute(DIM_ATTR);
                rootElem = root;
                root?.addEventListener("keydown", onEditorKeyDown);
                sync();
            }),
            editor.registerUpdateListener(() => {
                sync();
                if (performance.now() - lastKeyAt < 500) {
                    lastKeyAt = 0;
                    recenter();
                }
            })
        );
        // bring the current block into view when focus mode starts
        recenter();

        return () => {
            unregister();
            cancelAnimationFrame(frame);
            document.removeEventListener("mousemove", onMouseMove);
            rootElem?.removeEventListener("keydown", onEditorKeyDown);
            rootElem?.removeAttribute(DIM_ATTR);
            activeElem?.removeAttribute(ACTIVE_ATTR);
            html.classList.remove(HTML_CLASS);
            html.removeAttribute(REVEAL_ATTR);
        };
    }, [editor, enabled]);

    if (!enabled) return null;
    return createPortal(
        <div
            className="focus-exit-pill fixed top-3 right-4 z-40 font-poppins"
            data-app-chrome="fade"
            onMouseDown={(e) => e.preventDefault()} // don't steal the editor's cursor
        >
            <button
                className="btn btn-xs btn-ghost normal-case rounded-full border border-base-300 bg-surface text-base-content/75"
                onClick={() => setFocusMode(false)}
                title={`Exit focus mode (${FOCUS_MODE_SHORTCUT})`}
            >
                Exit focus · {FOCUS_MODE_SHORTCUT}
            </button>
        </div>,
        document.body
    );
}
