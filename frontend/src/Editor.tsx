import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import LexicalErrorBoundary from "@lexical/react/LexicalErrorBoundary";
import basicTheme from "./themes/BasicTheme";
import { HorizontalDividerNode } from "./nodes/HorizontalDividerNode";
import { ImageNode } from "./nodes/Image/ImageNode";
import { EquationNode } from "./nodes/Math/EquationNode";
import { ImagePlugin } from "./plugins/ImagePlugin";
import { HorizontalDividerPlugin } from "./plugins/HorizontalDividerPlugin";
import CodeBlockPlugin from "./plugins/CodeBlockPlugin";
import { EquationListenerPlugin } from "./plugins/EquationListenerPlugin";
import EditorBehaviourPlugin from "./plugins/EditorBehaviourPlugin";
import { EditorCommandsPlugin } from "./plugins/EditorCommands";
import FloatingTextFormatToolbarPlugin from "./plugins/FloatingElements/FloatingTextToolbar";
import { CodeHighlightNode, CodeNode } from "@lexical/code";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { LinkNode } from "@lexical/link";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import FloatingLinkEditorPlugin from "./plugins/FloatingElements/FloatingLinkEditor";
import FloatingEquationEditorPlugin from "./plugins/FloatingElements/FloatingEquationEditor";
import FloatingBlockToolbarPlugin from "./plugins/FloatingElements/FloatingBlockToolbar";
import CodeActionMenuPlugin from "./plugins/FloatingElements/CodeActionMenu";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { TRANSFORMERS } from "@lexical/markdown";
import { ListItemNode, ListNode } from "@lexical/list";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import AIAutoCompletePlugin from "./plugins/AIAutoCompletePlugin";
import { AutoCompleteNode } from "./nodes/AIAutoCompleteNode";
import { AutoCompleteModel } from "./components/MenuBar";
import { EditorState } from "lexical";
import LoadInitialStatePlugin from "./plugins/LoadInitialStatePlugin";
import BackendSyncPlugin from "./plugins/BackendSyncPlugin";
import { useRef, useEffect, useState, useCallback } from "react";

function Placeholder() {
    return <></>;
}

// Storage utilities
const STORAGE_VERSION = '1.0';
const MAX_STORAGE_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

interface StorageData {
    version: string;
    timestamp: number;
    state: any;
}

function generateKey() {
    return Math.random().toString(36).substring(2, 15);
}

function cleanupStorage() {
    const now = Date.now();
    Object.keys(localStorage).forEach(key => {
        if (key.startsWith('editor-')) {
            try {
                const data = JSON.parse(localStorage.getItem(key) || '');
                if (data.timestamp && (now - data.timestamp > MAX_STORAGE_AGE)) {
                    localStorage.removeItem(key);
                }
            } catch (e) {
                // Remove corrupted entries
                localStorage.removeItem(key);
            }
        }
    });
}

export default function Editor({
    autoCompleteModel,
    editorStateRef,
}: {
    autoCompleteModel: AutoCompleteModel;
    editorStateRef: React.MutableRefObject<EditorState | null>;
}) {
    const [storageKey, setStorageKey] = useState(() => {
        const urlParams = new URLSearchParams(window.location.search);
        const key = urlParams.get('key');
        if (!key) {
            const newKey = generateKey();
            // Update URL with new key
            const newUrl = new URL(window.location.href);
            newUrl.searchParams.set('key', newKey);
            window.history.pushState({}, '', newUrl);
            return newKey;
        }
        return key;
    });

    // Update storage key when URL changes
    useEffect(() => {
        const handleUrlChange = () => {
            const urlParams = new URLSearchParams(window.location.search);
            const key = urlParams.get('key');
            if (!key) {
                const newKey = generateKey();
                // Update URL with new key
                const newUrl = new URL(window.location.href);
                newUrl.searchParams.set('key', newKey);
                window.history.pushState({}, '', newUrl);
                setStorageKey(newKey);
            } else {
                setStorageKey(key);
            }
        };

        window.addEventListener('popstate', handleUrlChange);
        return () => window.removeEventListener('popstate', handleUrlChange);
    }, []);

    // Periodic storage cleanup
    useEffect(() => {
        cleanupStorage();
        const cleanup = setInterval(cleanupStorage, 24 * 60 * 60 * 1000); // Daily cleanup
        return () => clearInterval(cleanup);
    }, []);

    const saveToStorage = useCallback((editorState: EditorState) => {
        if (editorStateRef !== null) {
            editorStateRef.current = editorState;
            try {
                const storageData: StorageData = {
                    version: STORAGE_VERSION,
                    timestamp: Date.now(),
                    state: editorState
                };
                localStorage.setItem(
                    `editor-${storageKey}`,
                    JSON.stringify(storageData)
                );
            } catch (error) {
                if (error instanceof Error) {
                    if (error.name === 'QuotaExceededError') {
                        console.warn('LocalStorage quota exceeded - cleaning up old entries');
                        cleanupStorage();
                        // Retry save after cleanup
                        try {
                            const storageData: StorageData = {
                                version: STORAGE_VERSION,
                                timestamp: Date.now(),
                                state: editorState
                            };
                            localStorage.setItem(
                                `editor-${storageKey}`,
                                JSON.stringify(storageData)
                            );
                        } catch (retryError) {
                            console.warn('LocalStorage save failed after cleanup:', retryError);
                        }
                    } else {
                        console.warn('LocalStorage error:', error);
                    }
                }
            }
        }
    }, [storageKey, editorStateRef]);

    const initialConfig = {
        editorState: null,
        namespace: "MyEditor",
        onError(error: Error) {
            throw error;
        },
        nodes: [
            HorizontalDividerNode,
            ImageNode,
            EquationNode,
            CodeHighlightNode,
            CodeNode,
            HeadingNode,
            LinkNode,
            QuoteNode,
            ListNode,
            ListItemNode,
            AutoCompleteNode,
        ] as const,
        theme: basicTheme,
    };

    return (
        <LexicalComposer initialConfig={initialConfig}>
            <div className="editor-container">
                <div className="editor-inner">
                    <RichTextPlugin
                        placeholder={<Placeholder />}
                        contentEditable={
                            <ContentEditable
                                className="editor-input"
                                spellCheck={false}
                            />
                        }
                        ErrorBoundary={LexicalErrorBoundary}
                    />
                    <OnChangePlugin onChange={saveToStorage} />
                    <LinkPlugin />
                    <HistoryPlugin />
                    <FloatingLinkEditorPlugin />
                    <ImagePlugin />
                    <HorizontalDividerPlugin />
                    <CodeBlockPlugin />
                    <EquationListenerPlugin />
                    <FloatingEquationEditorPlugin />
                    <EditorBehaviourPlugin />
                    <EditorCommandsPlugin />
                    <FloatingTextFormatToolbarPlugin />
                    <FloatingBlockToolbarPlugin />
                    <CodeActionMenuPlugin />
                    <ListPlugin />
                    <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
                    <LoadInitialStatePlugin storageKey={storageKey} />
                    <BackendSyncPlugin storageKey={storageKey} />
                    {autoCompleteModel !== "none" && (
                        <AIAutoCompletePlugin
                            autoCompleteModel={autoCompleteModel}
                        />
                    )}
                </div>
            </div>
        </LexicalComposer>
    );
}
