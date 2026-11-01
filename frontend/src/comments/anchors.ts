import {
    $createRangeSelection,
    $getNodeByKey,
    $getRoot,
    $getSelection,
    $isElementNode,
    $isLineBreakNode,
    $isRangeSelection,
    $isTextNode,
    ElementNode,
    LexicalEditor,
    LexicalNode,
    RangeSelection,
} from "lexical";
import type { ReviewComment } from "./store";

/** a piece of a block's text: a Lexical text node, or a line break (no key) */
type Segment = { key: string | null; start: number; text: string };

/** A "paragraph" for review purposes: a leaf block with text (paragraph,
 *  heading, quote, list item). Code blocks are skipped. */
export type TextBlock = { key: string; text: string; segments: Segment[] };

const SKIP_BLOCKS = new Set(["code"]);

function $segmentsOf(element: ElementNode, out: Segment[], pos: { n: number }) {
    for (const child of element.getChildren()) {
        if ($isTextNode(child)) {
            if (child.getType() === "autocomplete") continue; // ghost suggestion
            const text = child.getTextContent();
            out.push({ key: child.getKey(), start: pos.n, text });
            pos.n += text.length;
        } else if ($isLineBreakNode(child)) {
            out.push({ key: null, start: pos.n, text: "\n" });
            pos.n += 1;
        } else if ($isElementNode(child)) {
            $segmentsOf(child, out, pos); // inline elements, e.g. links
        }
        // decorators (images, equations) carry no reviewable text
    }
}

const isLeafBlock = (node: ElementNode) =>
    !node.getChildren().some((c) => $isElementNode(c) && !c.isInline());

/** All text blocks, in document order. Call inside editor.read/update. */
export function $collectTextBlocks(): TextBlock[] {
    const blocks: TextBlock[] = [];
    const walk = (node: ElementNode) => {
        for (const child of node.getChildren()) {
            if (!$isElementNode(child) || child.isInline() || SKIP_BLOCKS.has(child.getType())) continue;
            if (!isLeafBlock(child)) {
                walk(child);
                continue;
            }
            const segments: Segment[] = [];
            $segmentsOf(child, segments, { n: 0 });
            const text = segments.map((s) => s.text).join("");
            if (text.trim()) blocks.push({ key: child.getKey(), text, segments });
        }
    };
    walk($getRoot());
    return blocks;
}

/** Indexes (into `blocks`) of the blocks touched by the selection; a caret
 *  counts as its block. Call inside editor.read/update. */
export function $selectedBlockIndexes(blocks: TextBlock[]): number[] {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return [];
    const index = new Map(blocks.map((b, i) => [b.key, i]));
    const found = new Set<number>();
    const nodes: LexicalNode[] = [...selection.getNodes(), selection.anchor.getNode(), selection.focus.getNode()];
    for (const node of nodes) {
        let n: LexicalNode | null = node;
        while (n && !index.has(n.getKey())) n = n.getParent();
        if (n) found.add(index.get(n.getKey())!);
        else if ($isElementNode(node)) {
            // e.g. a list selected as a whole: take its blocks
            for (const d of node.getChildren()) {
                const i = index.get(d.getKey());
                if (i !== undefined) found.add(i);
            }
        }
    }
    return [...found].sort((a, b) => a - b);
}

export type ResolvedAnchor = { blockIndex: number; start: number; end: number };

function closest(candidates: number[], hint: number): number {
    return candidates.reduce((best, i) => (Math.abs(i - hint) < Math.abs(best - hint) ? i : best));
}

function nearestOccurrence(text: string, quote: string, hint: number): number {
    let best = -1;
    for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) {
        if (best === -1 || Math.abs(i - hint) < Math.abs(best - hint)) best = i;
    }
    return best;
}

/**
 * Find where a comment points in the current document, or null if its text is
 * gone (the comment is then "stale"). Prefers the unchanged paragraph, then
 * any paragraph containing the quote nearest the original position.
 */
export function resolveAnchor(c: ReviewComment, blocks: TextBlock[]): ResolvedAnchor | null {
    if (c.quote) {
        const withQuote = blocks.map((b, i) => (b.text.includes(c.quote) ? i : -1)).filter((i) => i !== -1);
        if (withQuote.length === 0) return null;
        const same = withQuote.filter((i) => blocks[i].text === c.paragraphText);
        const i = closest(same.length ? same : withQuote, c.blockIndex);
        const start = nearestOccurrence(blocks[i].text, c.quote, c.quoteStart);
        return { blockIndex: i, start, end: start + c.quote.length };
    }
    // whole-paragraph comment: the same paragraph, or one that still starts the same way
    let candidates = blocks.map((b, i) => (b.text === c.paragraphText ? i : -1)).filter((i) => i !== -1);
    if (candidates.length === 0 && c.paragraphText.length >= 24) {
        const head = c.paragraphText.slice(0, Math.min(40, Math.floor(c.paragraphText.length * 0.6)));
        candidates = blocks.map((b, i) => (b.text.startsWith(head) ? i : -1)).filter((i) => i !== -1);
    }
    if (candidates.length === 0) return null;
    const i = closest(candidates, c.blockIndex);
    return { blockIndex: i, start: 0, end: blocks[i].text.length };
}

/** DOM position of a text offset inside a block. */
function domPoint(editor: LexicalEditor, block: TextBlock, offset: number, preferEnd: boolean): [Node, number] | null {
    const segs = block.segments.filter((s) => s.key !== null);
    const seg =
        segs.find((s) => (preferEnd ? offset > s.start && offset <= s.start + s.text.length
            : offset >= s.start && offset < s.start + s.text.length)) ??
        (preferEnd ? [...segs].reverse().find((s) => s.start < offset) : segs.find((s) => s.start >= offset));
    if (!seg) return null;
    const el = editor.getElementByKey(seg.key!);
    if (!el) return null;
    let rest = Math.max(0, Math.min(seg.text.length, offset - seg.start));
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
        const len = t.data.length;
        if (rest < len || (preferEnd && rest === len)) return [t, rest];
        rest -= len;
        last = t;
    }
    return last ? [last, last.data.length] : [el, 0];
}

/** A DOM Range covering [start, end) of a block's text, for highlights. */
export function domRangeFor(editor: LexicalEditor, block: TextBlock, start: number, end: number): Range | null {
    const a = domPoint(editor, block, start, false);
    const b = domPoint(editor, block, end, true);
    if (!a || !b) return null;
    try {
        const range = document.createRange();
        range.setStart(a[0], a[1]);
        range.setEnd(b[0], b[1]);
        return range;
    } catch {
        return null;
    }
}

/** A selection over all of a block's content (to replace it). Call inside editor.update. */
export function $selectBlockContent(blockKey: string): RangeSelection | null {
    const block = $getNodeByKey(blockKey);
    if (!$isElementNode(block)) return null;
    const texts = block.getAllTextNodes().filter((t) => t.getType() !== "autocomplete");
    // drop a ghost suggestion so it doesn't end up inside the replacement
    block.getAllTextNodes().filter((t) => t.getType() === "autocomplete").forEach((t) => t.remove());
    const selection = $createRangeSelection();
    if (texts.length === 0) {
        selection.anchor.set(blockKey, 0, "element");
        selection.focus.set(blockKey, block.getChildrenSize(), "element");
    } else {
        const last = texts[texts.length - 1];
        selection.anchor.set(texts[0].getKey(), 0, "text");
        selection.focus.set(last.getKey(), last.getTextContentSize(), "text");
    }
    return selection;
}
