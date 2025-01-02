import { useEffect, useState } from "react";
import { LOAD_ENDPOINT } from "../../constants";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $nodesOfType, $getRoot, EditorState, LexicalEditor, TextNode } from "lexical";
import { reduceParagraphMargin } from "../EditorBehaviourPlugin";

interface LoadInitialStatePluginProps {
    storageKey: string;
}

interface StorageData {
    version: string;
    timestamp: number;
    state: any;
}

export default function LoadInitialStatePlugin({ storageKey }: LoadInitialStatePluginProps) {
    const [initialState, setInitialState] = useState<EditorState | null>(null);
    const [editor] = useLexicalComposerContext();

    const loadState = async () => {
        try {
            // Try localStorage first
            const localData = localStorage.getItem(`editor-${storageKey}`);
            if (localData) {
                try {
                    const parsedData = JSON.parse(localData) as StorageData;
                    // Validate storage data structure
                    if (parsedData.version && parsedData.timestamp && parsedData.state) {
                        return parsedData.state;
                    }
                } catch (e) {
                    console.warn('Invalid localStorage data:', e);
                    // Remove corrupted data
                    localStorage.removeItem(`editor-${storageKey}`);
                }
            }

            // Then try backend
            const response = await fetch(LOAD_ENDPOINT);
            if (response.ok) {
                const data = await response.json();
                return data;
            }
            
            // Return null for new documents or when no state is found
            return null;
            
        } catch (e) {
            console.warn("Error loading state:", e);
            return null;
        }
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
                if (data) {
                    setInitialState(data);
                    const initialEditorState = editor.parseEditorState(data);
                    editor.setEditorState(initialEditorState);
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
