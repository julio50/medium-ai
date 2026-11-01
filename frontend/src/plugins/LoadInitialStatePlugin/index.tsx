import { useEffect, useState } from "react";
import { LOAD_ENDPOINT } from "../../constants";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $nodesOfType, $getRoot, EditorState, LexicalEditor, TextNode } from "lexical";
import { reduceParagraphMargin } from "../EditorBehaviourPlugin";
import { readStoredState, SerializedState } from "../../utils/editorStorage";

interface LoadInitialStatePluginProps {
    storageKey: string;
}

export default function LoadInitialStatePlugin({ storageKey }: LoadInitialStatePluginProps) {
    const [initialState, setInitialState] = useState<EditorState | null>(null);
    const [editor] = useLexicalComposerContext();

    const loadState = async (): Promise<SerializedState | null> => {
        // Try localStorage first. Unreadable entries are left alone (never
        // deleted), so nothing is lost if this code can't parse them.
        const localData = localStorage.getItem(`editor-${storageKey}`);
        if (localData) {
            try {
                const state = readStoredState(JSON.parse(localData));
                if (state) return state;
            } catch (e) {
                console.warn("Invalid localStorage data:", e);
            }
        }

        // Then try the backend (accepts every format it has ever saved)
        try {
            const response = await fetch(LOAD_ENDPOINT);
            if (response.ok) return readStoredState(await response.json());
        } catch (e) {
            console.warn("Error loading state from backend:", e);
        }
        return null;
    };

    const removeHighlight = (editor: LexicalEditor) => {
        editor.update(() => {
            const textNodes = $nodesOfType(TextNode);
            textNodes.forEach((node) => {
                if (node.hasFormat("highlight")) {
                    node.toggleFormat("highlight");
                }
            });
        });
    };

    const reduceParagraphMarginOnLoad = (editor: LexicalEditor) => {
        editor.update(() => {
            reduceParagraphMargin(editor);
        });
    };

    useEffect(() => {
        // Reset state when storage key changes
        setInitialState(null);
    }, [storageKey]);

    useEffect(() => {
        if (initialState === null) {
            loadState().then((data) => {
                let parsed: EditorState | null = null;
                if (data) {
                    try {
                        parsed = editor.parseEditorState(JSON.stringify(data));
                    } catch (e) {
                        console.warn("Saved document couldn't be loaded:", e);
                    }
                }
                if (parsed) {
                    setInitialState(parsed);
                    editor.setEditorState(parsed);
                    removeHighlight(editor);
                    reduceParagraphMarginOnLoad(editor);
                } else {
                    // Create empty editor state for new documents
                    editor.update(() => {
                        const root = $getRoot();
                        root.clear();
                    });
                }
            });
        }
    }, [initialState, editor, storageKey]);

    return null;
}
