import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $nodesOfType, $getRoot, TextNode } from "lexical";
import { reduceParagraphMargin } from "../EditorBehaviourPlugin";
import { fetchServerDocument } from "../../utils/documentsApi";
import { DocumentSync, readLocalDocument } from "../../utils/documentSync";
import { SerializedState } from "../../utils/editorStorage";

interface LoadInitialStatePluginProps {
    storageKey: string;
    sync: DocumentSync;
    /** called once the document is in the editor */
    onLoaded?: () => void;
}

/**
 * Loads the document from the backend or localStorage, whichever copy was
 * edited last (the backend wins a tie). If this browser's copy is newer, or
 * the backend doesn't have the document yet, it's uploaded right away. The
 * editor is remounted per document, so this runs once per document.
 */
export default function LoadInitialStatePlugin({ storageKey, sync, onLoaded }: LoadInitialStatePluginProps) {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const local = readLocalDocument(storageKey);
            const server = await fetchServerDocument(storageKey);
            if (cancelled) return;
            let chosen: { state: SerializedState; timestamp: number } | null = null;
            let onServer = false;
            if (server && (!local || server.timestamp >= local.timestamp)) {
                chosen = server;
                onServer = true;
            } else if (local) {
                chosen = local;
            }

            let loaded = false;
            if (chosen) {
                try {
                    editor.setEditorState(editor.parseEditorState(JSON.stringify(chosen.state)));
                    loaded = true;
                } catch (e) {
                    console.warn("Saved document couldn't be loaded:", e);
                }
            }
            // discrete: committed synchronously, so the baseline below sees it
            editor.update(
                () => {
                    if (loaded) {
                        removeHighlight();
                        reduceParagraphMargin(editor);
                    } else {
                        $getRoot().clear(); // new document
                    }
                },
                { discrete: true }
            );
            // baseline for change detection: the content as loaded
            sync.loadedFrom(editor.getEditorState(), loaded && chosen ? chosen.timestamp : 0, loaded && onServer);
            if (loaded && !onServer) sync.push(); // the backend lacks this copy (or has an older one)
            onLoaded?.();
        })();
        return () => {
            cancelled = true;
        };
    }, [editor, storageKey, sync]);

    return null;
}

function removeHighlight() {
    $nodesOfType(TextNode).forEach((node) => {
        if (node.hasFormat("highlight")) node.toggleFormat("highlight");
    });
}

