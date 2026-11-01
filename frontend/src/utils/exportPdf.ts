/**
 * "Export PDF" through the browser's print pipeline: the `@media print` rules
 * in styles/print.css hide all app chrome (anything marked `data-app-chrome`,
 * plus everything portaled straight into <body>) and print just the document,
 * with selectable text and working links. The user picks "Save as PDF" in the
 * print dialog.
 */

const MAX_TITLE_LENGTH = 80;
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]+/g;

/** Visible document text of a block, without AI ghost suggestions. */
function blockText(block: Element): string {
    const clone = block.cloneNode(true) as Element;
    clone.querySelectorAll(".editor-text-autocomplete").forEach((n) => n.remove());
    return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The document's first heading, or failing that its first non-empty line. */
export function documentTitle(root: Element | null): string {
    if (!root) return "";
    const blocks = Array.from(root.children);
    const heading = blocks.find((b) => /^H[1-6]$/.test(b.tagName) && blockText(b));
    const first = heading ?? blocks.find((b) => blockText(b));
    let title = first ? blockText(first) : "";
    title = title.replace(/\s*:\s*/g, " - ").replace(UNSAFE_FILENAME_CHARS, " ").replace(/\s+/g, " ").trim();
    if (title.length > MAX_TITLE_LENGTH) {
        const cut = title.slice(0, MAX_TITLE_LENGTH);
        title = (cut.lastIndexOf(" ") > 40 ? cut.slice(0, cut.lastIndexOf(" ")) : cut).trim() + "…";
    }
    return title;
}

/** Open the print dialog with a filename suggested from the document's title. */
export function exportPdf() {
    const root = document.querySelector(".editor-input");
    const title = documentTitle(root);
    const previousTitle = document.title;
    // Chrome/Edge/Firefox suggest "<document.title>.pdf" when saving
    if (title) document.title = title;

    let restored = false;
    const restore = () => {
        if (restored) return;
        restored = true;
        document.title = previousTitle;
        window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    try {
        window.print();
    } catch (e) {
        restore();
        throw e;
    }
}
