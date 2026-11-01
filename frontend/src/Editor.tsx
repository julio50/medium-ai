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
import { DocumentSync, setActiveDocumentSync, activeDocumentSync } from "./utils/documentSync";
import SearchPlugin from "./search/SearchPlugin";
import VoiceDumpPlugin from "./plugins/VoiceDumpPlugin";
import FocusModePlugin from "./plugins/FocusModePlugin";
import QuietTypingPlugin from "./plugins/QuietTypingPlugin";
import CommentsPlugin from "./plugins/CommentsPlugin";
import { useEffect, useMemo, useCallback } from "react";

function Placeholder() {
    return <></>;
}

/** One document; App remounts the editor (key={storageKey}) per document. */
export default function Editor({
    storageKey,
    autoCompleteModel,
    editorStateRef,
}: {
    storageKey: string;
    autoCompleteModel: AutoCompleteModel;
    editorStateRef: React.MutableRefObject<EditorState | null>;
}) {
    // localStorage (offline cache) + backend sync of this document. Documents
    // are kept until the user deletes them (no age-based cleanup).
    const sync = useMemo(() => new DocumentSync(storageKey), [storageKey]);

    useEffect(() => {
        setActiveDocumentSync(sync);
        // don't lose the last (debounced) edits when the tab closes
        const flush = () => sync.flushLocal();
        window.addEventListener("pagehide", flush);
        return () => {
            window.removeEventListener("pagehide", flush);
            sync.flushLocal();
            if (activeDocumentSync() === sync) setActiveDocumentSync(null);
        };
    }, [sync]);

    const onChange = useCallback(
        (editorState: EditorState) => {
            if (editorStateRef !== null) {
                editorStateRef.current = editorState;
            }
            sync.onChange(editorState);
        },
        [sync, editorStateRef]
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
                    <OnChangePlugin onChange={onChange} ignoreHistoryMergeTagChange={false} />
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
                    <LoadInitialStatePlugin storageKey={storageKey} sync={sync} />
                    <BackendSyncPlugin sync={sync} />
                    <SearchPlugin storageKey={storageKey} />
                    <VoiceDumpPlugin />
                    <FocusModePlugin />
                    <QuietTypingPlugin />
                    <CommentsPlugin storageKey={storageKey} />
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
