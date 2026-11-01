// Defaults to port 8080 on whatever host served the page, so the app also
// works when opened from another machine (override with VITE_API_BASE).
export const API_BASE =
    import.meta.env.VITE_API_BASE ??
    `${window.location.protocol}//${window.location.hostname}:8080`;
export const DOCUMENTS_ENDPOINT = `${API_BASE}/documents`;
export const SEARCH_ENDPOINT = `${API_BASE}/search`;
export const INDEX_STATUS_ENDPOINT = `${API_BASE}/index/status`;
export const AUTOCOMPLETE_ENDPOINT = `${API_BASE}/autocomplete/stream`;
export const AI_EDIT_ENDPOINT = `${API_BASE}/ai_edit/stream`;
export const TRANSCRIBE_ENDPOINT = `${API_BASE}/transcribe`;
export const TIDY_ENDPOINT = `${API_BASE}/tidy/stream`;
export const CRITIQUE_ENDPOINT = `${API_BASE}/critique/stream`;
export const MODELS_ENDPOINT = `${API_BASE}/models`;
export const DEFAULT_MODEL = "spark";
export const BACKEND_SYNC_INTERVAL = 30000; // ms between automatic saves to the backend
export const WAIT_TIME = 500; // debounce time in milliseconds
// no automatic suggestions until the document has this many words (Ctrl+Space overrides)
export const MIN_CONTEXT_WORDS = 12;
