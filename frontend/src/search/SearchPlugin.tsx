import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $isElementNode, ElementNode, LexicalEditor, LexicalNode } from "lexical";
import { $isListNode } from "@lexical/list";
import SearchIcon from "@mui/icons-material/Search";
import { fetchIndexStatus, IndexStatus, SearchHit, searchDocument } from "../utils/documentsApi";
import { activeDocumentSync } from "../utils/documentSync";
import { isSearchShortcut, SEARCH_SHORTCUT, setSearchOpen, toggleSearch, useSearchOpen } from "./searchPanel";

const SEARCH_DEBOUNCE_MS = 180;
const STATUS_POLL_MS = 1500;
const FLASH_MS = 1800;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** The editor node a search hit points at: by its path, checked against its
 * text (the editor may have changed since the last save); else by text. */
function $findBlock(hit: SearchHit): ElementNode | null {
    const want = norm(hit.text).slice(0, 80);
    const matches = (n: LexicalNode | null | undefined): n is ElementNode =>
        !!n && $isElementNode(n) && norm(n.getTextContent()).startsWith(want);

    let node: LexicalNode | undefined = $getRoot();
    for (const i of hit.path) {
        node = $isElementNode(node) ? node.getChildren()[i] : undefined;
        if (!node) break;
    }
    if (matches(node)) return node;

    // fall back: the first block (top-level node or list item) with this text
    let found: ElementNode | null = null;
    const visit = (n: LexicalNode) => {
        if (found || !$isElementNode(n)) return;
        if ($isListNode(n)) {
            n.getChildren().forEach((item) => {
                if (found || !$isElementNode(item)) return;
                const nested = item.getChildren().find($isListNode);
                if (nested) visit(nested);
                else if (matches(item)) found = item;
            });
        } else if (matches(n)) {
            found = n;
        }
    };
    $getRoot().getChildren().forEach(visit);
    return found;
}

function jumpTo(editor: LexicalEditor, hit: SearchHit): boolean {
    let key: string | null = null;
    editor.update(() => {
        const node = $findBlock(hit);
        if (node) {
            key = node.getKey();
            node.selectStart();
        }
    });
    if (!key) return false;
    // after the update is committed, so the DOM exists and selection is set
    setTimeout(() => {
        editor.focus();
        const el = key ? editor.getElementByKey(key) : null;
        if (!el) return;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.remove("search-flash");
        void el.offsetWidth; // restart the animation when jumping to the same block twice
        el.classList.add("search-flash");
        setTimeout(() => el.classList.remove("search-flash"), FLASH_MS);
    }, 0);
    return true;
}

function Snippet({ text, spans }: { text: string; spans: [number, number][] }) {
    const parts: JSX.Element[] = [];
    let at = 0;
    spans.forEach(([s, e], i) => {
        if (s < at) return;
        if (s > at) parts.push(<Fragment key={`t${i}`}>{text.slice(at, s)}</Fragment>);
        parts.push(
            <mark key={`m${i}`} className="bg-accent/30 text-base-content rounded-sm px-px">
                {text.slice(s, e)}
            </mark>
        );
        at = e;
    });
    if (at < text.length) parts.push(<Fragment key="end">{text.slice(at)}</Fragment>);
    return <>{parts}</>;
}

function statusLine(status: IndexStatus | undefined, semantic: boolean | null): string {
    if (!status) return "";
    if (status.state === "offline")
        return "AI server unreachable: keyword search only" + (status.pendingBlocks ? `, ${status.pendingBlocks.toLocaleString()} blocks waiting` : "");
    if (status.pendingBlocks > 0) return `Indexing… ${status.pendingBlocks.toLocaleString()} blocks left`;
    if (semantic === false) return "Keyword search only (embedding unavailable)";
    return `${status.blocks.toLocaleString()} blocks indexed`;
}

/** Ctrl+K: search the current document (words and meaning); Enter jumps to the block. */
export default function SearchPlugin({ storageKey }: { storageKey: string }) {
    const [editor] = useLexicalComposerContext();
    const open = useSearchOpen();
    const [query, setQuery] = useState("");
    const [hits, setHits] = useState<SearchHit[]>([]);
    const [selected, setSelected] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [semantic, setSemantic] = useState<boolean | null>(null);
    const [status, setStatus] = useState<IndexStatus | undefined>();
    const [refresh, setRefresh] = useState(0); // re-run the query (index caught up)
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLUListElement>(null);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (isSearchShortcut(e)) {
                e.preventDefault();
                toggleSearch();
            }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    }, []);

    useEffect(() => () => setSearchOpen(false), []); // document closed

    // while open: index the latest edits, and show the index status
    useEffect(() => {
        if (!open) return;
        setTimeout(() => inputRef.current?.select(), 0);
        let stopped = false;
        let lastPending: number | null = null;
        const poll = async () => {
            const s = await fetchIndexStatus(storageKey);
            if (stopped) return;
            setStatus(s);
            if (s && lastPending !== null && lastPending > 0 && s.pendingBlocks === 0) setRefresh((n) => n + 1);
            if (s) lastPending = s.pendingBlocks;
        };
        activeDocumentSync()
            ?.push()
            .then((outcome) => {
                if (!stopped && outcome?.ok) setRefresh((n) => n + 1);
                poll();
            });
        poll();
        const t = setInterval(poll, STATUS_POLL_MS);
        return () => {
            stopped = true;
            clearInterval(t);
        };
    }, [open, storageKey]);

    useEffect(() => {
        if (!open) return;
        const q = query.trim();
        if (!q) {
            setHits([]);
            setError(null);
            setSemantic(null);
            return;
        }
        const ctrl = new AbortController();
        const t = setTimeout(async () => {
            setLoading(true);
            try {
                const res = await searchDocument(storageKey, query, ctrl.signal);
                setHits(res.hits);
                setSemantic(res.semantic);
                setSelected(0);
                setError(null);
            } catch (e) {
                if ((e as Error).name !== "AbortError") setError("Search needs the backend (is it running and up to date?)");
            } finally {
                if (!ctrl.signal.aborted) setLoading(false);
            }
        }, SEARCH_DEBOUNCE_MS);
        return () => {
            clearTimeout(t);
            ctrl.abort();
        };
    }, [query, open, storageKey, refresh]);

    useEffect(() => {
        listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
    }, [selected]);

    const close = useCallback(() => {
        setSearchOpen(false);
        editor.focus();
    }, [editor]);

    const choose = useCallback(
        (hit: SearchHit | undefined) => {
            if (!hit) return;
            setSearchOpen(false);
            if (!jumpTo(editor, hit)) {
                setSearchOpen(true);
                setError("That passage has changed since it was indexed; try again in a moment.");
            }
        },
        [editor]
    );

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelected((i) => Math.min(i + 1, hits.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelected((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            choose(hits[selected]);
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    };

    if (!open) return null;
    const line = statusLine(status, semantic);
    return createPortal(
        <div
            className="fixed inset-0 z-50 flex justify-center items-start pt-[12vh] px-4 bg-black/20"
            data-app-chrome="fade" // fully visible while its input has focus, even in focus mode
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                    e.preventDefault(); // don't move the editor's cursor
                    close();
                }
            }}
        >
            <div
                role="dialog"
                aria-label="Search this document"
                className="bg-surface border border-base-300 shadow-xl rounded-xl w-full max-w-2xl max-h-[70vh] flex flex-col font-poppins text-sm text-base-content"
            >
                <div className="flex items-center gap-2 px-3 py-2 border-b border-base-300">
                    <SearchIcon fontSize="small" className="text-base-content/50" />
                    <input
                        ref={inputRef}
                        className="flex-1 bg-transparent outline-none py-1 text-base text-base-content placeholder:text-base-content/40"
                        placeholder="Search this document: words or meaning"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={onKeyDown}
                        aria-controls="search-results"
                        aria-activedescendant={hits.length ? `search-hit-${selected}` : undefined}
                        spellCheck={false}
                    />
                    {loading && <span className="loading loading-spinner loading-xs text-accent" />}
                    <kbd className="kbd kbd-xs">Esc</kbd>
                </div>
                <ul
                    ref={listRef}
                    id="search-results"
                    role="listbox"
                    className="overflow-y-auto py-1"
                    onMouseDown={(e) => e.preventDefault()} // keep focus in the input
                >
                    {error && <li className="px-4 py-3 text-danger">{error}</li>}
                    {!error && query.trim() && !loading && hits.length === 0 && (
                        <li className="px-4 py-3 text-base-content/60">No matches in this document.</li>
                    )}
                    {!query.trim() && (
                        <li className="px-4 py-3 text-base-content/60">
                            Finds passages by their words and by what they mean. ↑↓ to choose, Enter to jump there.
                        </li>
                    )}
                    {hits.map((h, i) => (
                        <li
                            key={h.blockId}
                            id={`search-hit-${i}`}
                            data-index={i}
                            role="option"
                            aria-selected={i === selected}
                            className={
                                "mx-1 px-3 py-2 rounded-lg cursor-pointer " +
                                (i === selected ? "bg-base-200" : "hover:bg-base-200/60")
                            }
                            onMouseEnter={() => setSelected(i)}
                            onClick={() => choose(h)}
                        >
                            {h.headingPath && (
                                <div className="text-xs text-base-content/50 truncate mb-0.5">{h.headingPath}</div>
                            )}
                            <div
                                className={
                                    "leading-snug font-merriweather " + (h.kind === "heading" ? "font-bold" : "")
                                }
                            >
                                <Snippet text={h.snippet} spans={h.highlights} />
                            </div>
                        </li>
                    ))}
                </ul>
                <div
                    className="flex items-center gap-3 px-3 py-1.5 border-t border-base-300 text-xs text-base-content/60"
                    onMouseDown={(e) => e.preventDefault()}
                >
                    {status?.state === "offline" || (status?.pendingBlocks ?? 0) > 0 ? (
                        <span className="flex items-center gap-1.5">
                            {status?.state !== "offline" && <span className="loading loading-dots loading-xs text-accent" />}
                            {line}
                        </span>
                    ) : (
                        <span>{line}</span>
                    )}
                    <span className="ml-auto">{SEARCH_SHORTCUT} to open/close</span>
                </div>
            </div>
        </div>,
        document.body
    );
}
