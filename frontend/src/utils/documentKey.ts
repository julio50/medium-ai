import { useEffect, useState } from "react";

/** The open document's id: the `?key=` URL parameter (created if missing). */

function generateKey() {
    return Math.random().toString(36).substring(2, 15);
}

function keyFromUrl(): string {
    const key = new URLSearchParams(window.location.search).get("key");
    if (key) return key;
    const newKey = generateKey();
    const url = new URL(window.location.href);
    url.searchParams.set("key", newKey);
    window.history.pushState({}, "", url);
    return newKey;
}

export function useDocumentKey(): string {
    const [key, setKey] = useState(keyFromUrl);
    useEffect(() => {
        const onPop = () => setKey(keyFromUrl());
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, []);
    return key;
}
