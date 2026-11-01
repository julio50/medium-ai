# IDEAS: making medium-ai the ultimate brainstorming writing tool

The AI server (`192.168.1.158:8080`, llama-swap) already has speech, embedding,
TTS and vision models, so many of these can run fully local.

## Done
- [x] **Voice brain-dump** (#5): mic button / `Alt+V`, `whisper-1` transcribes, optional "Tidy" turns it into bullets.
- [x] **Streaming AI responses** (#14): autosuggest and AI edit stream in as they're generated; thinking models show live reasoning in an indicator with Cancel.

## Generate
1. **10 variations, not 1** (`Ctrl+Shift+Space`): a side panel of 5–10 suggestions in different directions (contrarian, story, data-driven, emotional). Run them at high temperature on a small model so they're fast and varied.
2. **"What if…" sparks**: one click and the model reads the document and asks 3 provocative questions or angles you haven't covered. A brainstorming partner should challenge you, not just finish your sentences.
3. **Perspective personas**: rewrite or critique a passage as a skeptic, the target customer, a competitor or an editor (e.g. "a chiropractor who's been burned by agencies"). Save personas as presets.
4. **Expand / collapse**: turn a bullet into a paragraph, or a paragraph back into a bullet. Move between outline and draft without retyping.

## Capture
5. **Photo / scan to text**: drop in a photo of a whiteboard or handwritten notes and `ocr` / `lfm3-vl` turns it into editable text.
6. **Quick-capture inbox**: a box (or a tiny API you can hit from your phone) that adds ideas to an "Inbox" document without opening the editor.

## Connect
7. **Find related ideas**: embed every paragraph across all documents with `embedding` and show "related ideas from your other notes" in a sidebar as you type. Over time it becomes a personal idea library.
8. **Cluster my mess**: select a chaotic brainstorm and get it grouped into themes with headings, with duplicates and gaps flagged.
9. **Outline view with drag and drop**: headings become cards you can reorder, so a brainstorm can turn into a structure.

## From idea to finished writing
10. **Writing frameworks as templates**: one-click scaffolds (hook → story → offer, PAS, AIDA, the six-link belief chain from the `story-page` skill), then "fill this section from my notes".
11. **Critique mode**: points out the weakest claim, the vague sentence and the missing proof without rewriting anything.
12. **Read it aloud**: `tts-live` plays the draft back. Hearing copy is one of the best ways to catch clunky lines.

## Foundation (unlocks several of the above)
13. **Real document list**: the backend saves everything to one `editor_state.json`, and the per-document `?key=` links only live in the browser. Saving each document separately in SQLite would give a document list, search and history, and #7 needs it.
14. **Model per feature**: a fast small model for autosuggest and a larger one (`large` / `qwen3.8-27b`) for critique and clustering, set in `.env`.

## Known rough edges
- Autosuggest with **Thinking on** reasons before every suggestion (a few seconds each time with `spark`). It works, but Thinking is best for AI edit / tidy.
- The mic needs `http://localhost` or https. Opening the app via a LAN IP over plain http blocks microphone access in browsers.
- `/save_state` overwrites one shared file, so documents from different `?key=` links overwrite each other on the backend (#13 fixes this).
