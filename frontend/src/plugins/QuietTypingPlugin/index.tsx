import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useQuietTyping } from "./quietTyping";

const CLASS = "typing-quiet";
// mouse travel (px) that counts as "the user reached for the mouse"
const MOVE_THRESHOLD = 12;

/** Keys that are writing, not commands (Ctrl/Cmd/Alt shortcuts don't count). */
function isTypingKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    return e.key.length === 1 || e.key === "Enter" || e.key === "Backspace" || e.key === "Delete";
}

/**
 * Hide UI while typing: as soon as the user types in the editor, everything
 * marked `data-app-chrome` (menu bar, mic, margin...) fades out; it comes back
 * when the mouse moves. Same hooks and styling as focus mode
 * (styles/focus-mode.css), lighter: no dimming of other paragraphs.
 */
export default function QuietTypingPlugin() {
    const [editor] = useLexicalComposerContext();
    const enabled = useQuietTyping();

    useEffect(() => {
        const html = document.documentElement;
        if (!enabled) {
            html.classList.remove(CLASS);
            return;
        }

        let moved = 0;
        let last: { x: number; y: number } | null = null;

        const onKeyDown = (e: KeyboardEvent) => {
            if (!isTypingKey(e)) return;
            html.classList.add(CLASS);
            moved = 0;
            last = null;
        };
        const show = () => html.classList.remove(CLASS);
        const onMouseMove = (e: MouseEvent) => {
            if (!html.classList.contains(CLASS)) return;
            if (last) moved += Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y);
            last = { x: e.clientX, y: e.clientY };
            if (moved > MOVE_THRESHOLD) show();
        };

        const unregister = editor.registerRootListener((root, prevRoot) => {
            prevRoot?.removeEventListener("keydown", onKeyDown);
            root?.addEventListener("keydown", onKeyDown);
        });
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("pointerdown", show);
        window.addEventListener("blur", show);
        return () => {
            unregister();
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("pointerdown", show);
            window.removeEventListener("blur", show);
            html.classList.remove(CLASS);
        };
    }, [editor, enabled]);

    return null;
}
