import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { SAVE_ENDPOINT } from "../../constants";
import { serializeEditorState, STORAGE_VERSION } from "../../utils/editorStorage";

interface BackendSyncPluginProps {
    storageKey: string;
}

/** Every 30s, send the current document to the backend if it changed. */
export default function BackendSyncPlugin({ storageKey }: BackendSyncPluginProps) {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        let lastSynced = "";
        const syncInterval = setInterval(async () => {
            const state = serializeEditorState(editor.getEditorState());
            const serialized = JSON.stringify(state);
            if (serialized === lastSynced) return;
            try {
                const response = await fetch(SAVE_ENDPOINT, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ version: STORAGE_VERSION, timestamp: Date.now(), state }),
                });
                if (response.ok) lastSynced = serialized;
                else console.warn("Backend sync failed");
            } catch (error) {
                console.warn("Backend sync error:", error);
            }
        }, 30000);

        return () => clearInterval(syncInterval);
    }, [editor, storageKey]);

    return null;
}
