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
import { toStoredDocument } from "./utils/editorStorage";
import VoiceDumpPlugin from "./plugins/VoiceDumpPlugin";
import { useEffect, useState, useCallback } from "react";

function generateKey() {
    return Math.random().toString(36).substring(2, 15);
}

function Placeholder() {
    return <></>;
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

    // Documents are kept in localStorage until the user deletes them (no
    // age-based cleanup: an untouched note must never silently disappear).
    const saveToStorage = useCallback(
        (editorState: EditorState) => {
            if (editorStateRef !== null) {
                editorStateRef.current = editorState;
            }
            try {
                localStorage.setItem(`editor-${storageKey}`, JSON.stringify(toStoredDocument(editorState)));
            } catch (error) {
                // e.g. QuotaExceededError: keep working; the backend sync still has a copy
                console.warn("LocalStorage save failed:", error);
            }
        },
        [storageKey, editorStateRef]
    );

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
                    {/* history-merge updates (e.g. streamed AI edits) must be saved too */}
                    <OnChangePlugin onChange={saveToStorage} ignoreHistoryMergeTagChange={false} />
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
                    <VoiceDumpPlugin />
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
