import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { SAVE_ENDPOINT } from "../../constants";

interface BackendSyncPluginProps {
    storageKey: string;
}

interface StorageData {
    version: string;
    timestamp: number;
    state: any;
}

export default function BackendSyncPlugin({ storageKey }: BackendSyncPluginProps) {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        const syncInterval = setInterval(async () => {
            const editorState = editor.getEditorState();
            
            try {
                // Check localStorage first to ensure we're syncing the latest state
                const localData = localStorage.getItem(`editor-${storageKey}`);
                if (localData) {
                    try {
                        const parsedData = JSON.parse(localData) as StorageData;
                        // Only sync if the local state matches the current editor state
                        // This prevents syncing outdated states
                        if (JSON.stringify(parsedData.state) !== JSON.stringify(editorState)) {
                            console.warn('Local state mismatch - skipping sync');
                            return;
                        }
                    } catch (e) {
                        console.warn('Invalid localStorage data during sync:', e);
                    }
                }

                const response = await fetch(SAVE_ENDPOINT, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        version: '1.0',
                        timestamp: Date.now(),
                        state: editorState
                    }),
                });
                
                if (!response.ok) {
                    console.warn('Backend sync failed');
                }
            } catch (error) {
                console.warn('Backend sync error:', error);
            }
        }, 30000); // Sync every 30 seconds

        return () => clearInterval(syncInterval);
    }, [editor, storageKey]);

    return null;
}
