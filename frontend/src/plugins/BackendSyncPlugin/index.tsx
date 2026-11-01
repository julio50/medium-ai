import { useEffect } from "react";
import { BACKEND_SYNC_INTERVAL } from "../../constants";
import { DocumentSync } from "../../utils/documentSync";

/**
 * Sends the open document to the backend every 30 s if it changed, when the
 * tab is hidden, and when the document is closed (switching documents).
 */
export default function BackendSyncPlugin({ sync }: { sync: DocumentSync }) {
    useEffect(() => {
        const interval = setInterval(() => sync.push(), BACKEND_SYNC_INTERVAL);
        const onHide = () => {
            if (document.visibilityState === "hidden") sync.push();
        };
        document.addEventListener("visibilitychange", onHide);
        return () => {
            clearInterval(interval);
            document.removeEventListener("visibilitychange", onHide);
            sync.push(); // closing this document: don't leave the last edits behind
        };
    }, [sync]);

    return null;
}
