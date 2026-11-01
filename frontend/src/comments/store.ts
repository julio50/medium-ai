/**
 * Margin comments, stored per document in localStorage (`comments-<key>`,
 * next to `editor-<key>`). They are deliberately NOT part of the Lexical
 * document: they never end up in saves, exports or the backend copy.
 *
 * Lexical node keys change on every reload, so a comment is anchored by text:
 * the paragraph it was made on and the exact quote inside it (see anchors.ts).
 */
export type CommentStatus = "open" | "resolved" | "dismissed";

export type ReviewComment = {
    id: string;
    lensId: string;
    /** snapshots, used if the lens is later edited away or deleted */
    lensName: string;
    color: string;
    /** text of the paragraph the comment was made on */
    paragraphText: string;
    /** position of that paragraph among the document's text blocks (tie-breaker) */
    blockIndex: number;
    /** exact substring of paragraphText; "" = the whole paragraph */
    quote: string;
    /** where the quote started in paragraphText (tie-breaker for repeated quotes) */
    quoteStart: number;
    comment: string;
    suggestion: string;
    status: CommentStatus;
    createdAt: number;
};

const VERSION = 1;
const storageKeyFor = (docKey: string) => `comments-${docKey}`;

export function loadComments(docKey: string): ReviewComment[] {
    try {
        const raw = localStorage.getItem(storageKeyFor(docKey));
        if (!raw) return [];
        const data = JSON.parse(raw);
        const list: unknown[] = Array.isArray(data?.comments) ? data.comments : [];
        return list.filter(
            (c): c is ReviewComment =>
                !!c && typeof (c as ReviewComment).id === "string" &&
                typeof (c as ReviewComment).comment === "string" &&
                typeof (c as ReviewComment).paragraphText === "string"
        ).map((c) => ({ ...c, quote: c.quote ?? "", suggestion: c.suggestion ?? "", status: c.status ?? "open" }));
    } catch {
        return [];
    }
}

export function saveComments(docKey: string, comments: ReviewComment[]) {
    try {
        if (comments.length === 0) localStorage.removeItem(storageKeyFor(docKey));
        else localStorage.setItem(storageKeyFor(docKey), JSON.stringify({ version: VERSION, comments }));
    } catch (e) {
        console.warn("Could not save comments:", e);
    }
}

export const newCommentId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
