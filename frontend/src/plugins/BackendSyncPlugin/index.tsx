import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { SAVE_ENDPOINT } from "../../constants";

export default function BackendSyncPlugin() {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        const syncInterval = setInterval(async () => {
            const editorState = editor.getEditorState();
            try {
                const response = await fetch(SAVE_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(editorState),
                });
                if (!response.ok) {
                    console.warn('Backend sync failed');
                }
            } catch (error) {
                console.warn('Backend sync error:', error);
            }
        }, 30000); // Sync every 30 seconds

        return () => clearInterval(syncInterval);
    }, [editor]);

    return null;
}
