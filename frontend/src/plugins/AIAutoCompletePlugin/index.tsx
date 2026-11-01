import {
    $createTextNode,
    $nodesOfType,
    COMMAND_PRIORITY_LOW,
    COMMAND_PRIORITY_NORMAL,
    KEY_TAB_COMMAND,
    LexicalEditor,
    LexicalNode,
    NodeKey,
    RangeSelection,
    SELECTION_CHANGE_COMMAND,
    $isParagraphNode,
    $getNodeByKey,
} from "lexical";

import {
    $getSelection,
    $isTextNode,
    $isRangeSelection,
    RootNode,
} from "lexical";
import { $isListItemNode } from "@lexical/list";
import { mergeRegister } from "@lexical/utils";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect } from "react";
import { $isAtNodeEnd } from "@lexical/selection";
import {
    $createAutoCompleteNode,
    AutoCompleteNode,
} from "../../nodes/AIAutoCompleteNode";
import { $isHeadingNode, $isQuoteNode } from "@lexical/rich-text";
import { AutoCompleteModel } from "../../components/MenuBar";

import { AUTOCOMPLETE_ENDPOINT, MIN_CONTEXT_WORDS, WAIT_TIME } from "../../constants";
import { AISettings, modelParams, useAISettings } from "../../ai/settings";
import { isAbort, streamAI } from "../../ai/stream";

type Context = {
    previousContext: string;
    nextContext: string;
    currentContext: string;
    force?: boolean;
};

const wordCount = (...texts: string[]) =>
    texts.reduce((n, t) => n + (t.match(/\S+/g)?.length ?? 0), 0);

// Only one suggestion is in flight at a time: a new one cancels the last.
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingController: AbortController | null = null;

function cancelPendingSuggestion() {
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingController?.abort();
    pendingController = null;
}

/**
 * After the debounce, stream a suggestion into a ghost AutoCompleteNode after
 * `anchorNode`. Each chunk swaps in a fresh node with the text so far (a fresh,
 * uncommitted node survives the RootNode transform that clears stale ones).
 */
function requestSuggestion(
    editor: LexicalEditor,
    context: Context,
    settings: AISettings,
    anchorNode: LexicalNode,
    selection: RangeSelection
) {
    cancelPendingSuggestion();
    const controller = new AbortController();
    pendingController = controller;
    pendingTimer = setTimeout(() => {
        let ghostKey: NodeKey | null = null;
        streamAI(
            AUTOCOMPLETE_ENDPOINT,
            { ...context, ...modelParams(settings) },
            {
                label: "Autosuggest",
                signal: controller.signal,
                onText: (_chunk, fullText) => {
                    editor.update(
                        () => {
                            // the cursor must still be at the end of the same text node
                            if (!$isSameSelection(selection) || $getNodeByKey(anchorNode.getKey()) === null) {
                                controller.abort(); // the user moved on
                                return;
                            }
                            const ghost = $createAutoCompleteNode(fullText);
                            const existing = ghostKey ? $getNodeByKey(ghostKey) : null;
                            if (existing) {
                                existing.replace(ghost);
                            } else {
                                anchorNode.getLatest().insertAfter(ghost, false);
                            }
                            ghostKey = ghost.getKey();
                            anchorNode.getLatest().select();
                        },
                        // ghost text isn't the user's writing: keep it out of undo history
                        { tag: "historic" }
                    );
                },
            }
        ).catch((e) => {
            if (!isAbort(e)) console.log("Autosuggest failed:", e);
        });
    }, WAIT_TIME);
}

function $isSameSelection(selection: RangeSelection): boolean {
    const currentSelection = $getSelection();
    if (!$isRangeSelection(currentSelection)) {
        return false;
    }

    // same node AND same offset (offset alone matches other paragraphs too)
    return (
        selection.isCollapsed() &&
        currentSelection.isCollapsed() &&
        selection.anchor.key === currentSelection.anchor.key &&
        selection.anchor.offset === currentSelection.anchor.offset
    );
}

function getAdjacentContext(node: LexicalNode) {
    const topLevelParent = node.getTopLevelElement();
    const previousSiblings = topLevelParent.getPreviousSiblings();
    const nextSiblings = topLevelParent.getNextSiblings();

    const previousContext = previousSiblings
        .map((sibling: LexicalNode) => sibling.getTextContent())
        .join("\n");

    const nextContext = nextSiblings
        .map((sibling: LexicalNode) => sibling.getTextContent())
        .join("\n");

    return {
        previousContext,
        nextContext,
    };
}

function acceptSuggestion(editor: LexicalEditor) {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
        return;
    }

    if (!selection.isCollapsed()) {
        return;
    }

    const currentAutoCompleteNodes =
        $nodesOfType<AutoCompleteNode>(AutoCompleteNode);

    if (currentAutoCompleteNodes.length > 0) {
        const currentAutoCompleteNode = currentAutoCompleteNodes[0];
        // check if the node has been committed to the DOM
        const nodeKey: NodeKey = currentAutoCompleteNode.getKey();
        const nodeElement = editor.getElementByKey(nodeKey);
        if (nodeElement !== null) {
            // if the autocomplete node and the selection node aren't
            // in the same paragraph, don't accept the suggestion
            const selectedNode = selection.getNodes()[0];
            if (
                selectedNode.getParent() !== currentAutoCompleteNode.getParent()
            ) {
                return false;
            }

            // replace the autocomplete node with a text node
            const nodeText = currentAutoCompleteNode.getTextContent();
            const textNode = $createTextNode(nodeText);
            currentAutoCompleteNode.replace(textNode);
            textNode.select();
            return true;
        }
    }

    return false;
}

function deleteAutoCompleteNodes(editor: LexicalEditor) {
    const currentAutoCompleteNodes =
        $nodesOfType<AutoCompleteNode>(AutoCompleteNode);

    // delete the nodes that have been committed to the DOM
    currentAutoCompleteNodes.forEach((node) => {
        const nodeKey: NodeKey = node.getKey();
        const nodeElement = editor.getElementByKey(nodeKey);
        if (nodeElement !== null) {
            node.remove();
        }
    });
}

const handleSelectionChange = (editor: LexicalEditor) => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
        return;
    }

    if (selection.isCollapsed()) {
        const selectedNode = selection.getNodes()[0];
        if (selectedNode.getType() === "autocomplete") {
            selectedNode.getPreviousSibling()?.select();
            return;
        }
    } else {
        const selectedNodes = selection.getNodes();
        if (selectedNodes.length > 1) {
            deleteAutoCompleteNodes(editor);
            return;
        } else if (selectedNodes.length === 1) {
            const selectedNode = selectedNodes[0];
            if (selectedNode.getType() !== "autocomplete") {
                deleteAutoCompleteNodes(editor);
                return;
            }
        }
    }

    return false;
};

/** `manual` = the user asked (Ctrl+Space): suggest even with little context */
const insertAIAutoComplete = (editor: LexicalEditor, settings: AISettings, manual = false) => {
    deleteAutoCompleteNodes(editor);

    const selection = $getSelection();
    if (!$isRangeSelection(selection)) {
        return;
    }

    const anchor = selection.anchor;
    const anchorNode = anchor.getNode();
    const anchorParent = anchorNode.getParent();

    if (
        selection.isCollapsed() &&
        $isTextNode(anchorNode) &&
        anchorParent !== null &&
        ($isParagraphNode(anchorParent) ||
            $isListItemNode(anchorParent) ||
            $isQuoteNode(anchorParent) ||
            $isHeadingNode(anchorParent)) &&
        $isAtNodeEnd(anchor) &&
        anchorNode.getNextSibling() === null
    ) {
        // get context
        let { previousContext, nextContext } = getAdjacentContext(anchorNode);
        const currentContext = anchorParent.getTextContent();

        if ($isListItemNode(anchorParent)) {
            previousContext +=
                "\n" +
                anchorParent
                    .getPreviousSiblings()
                    .map((sibling: LexicalNode) => sibling.getTextContent())
                    .join("\n");

            nextContext =
                anchorParent
                    .getNextSiblings()
                    .map((sibling: LexicalNode) => sibling.getTextContent())
                    .join("\n") +
                "\n" +
                nextContext;
        }

        // Don't guess until the page says enough to know what it's about
        const enoughContext =
            wordCount(previousContext, currentContext, nextContext) >= MIN_CONTEXT_WORDS;
        if (currentContext.length > 0 && (manual || enoughContext)) {
            requestSuggestion(
                editor,
                { previousContext, currentContext, nextContext, force: manual },
                settings,
                anchorNode,
                selection
            );
        }
    }
};

const insertAIAutoCompleteTransform = (editor: LexicalEditor, settings: AISettings) => {
    return editor.registerNodeTransform(RootNode, () =>
        insertAIAutoComplete(editor, settings)
    );
};

export default function AIAutoCompletePlugin({
    autoCompleteModel,
}: {
    autoCompleteModel: AutoCompleteModel;
}) {
    const [editor] = useLexicalComposerContext();
    const { thinking } = useAISettings();
    const settings: AISettings = { model: autoCompleteModel, thinking };

    // trigger function when user presses ctrl+space
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.ctrlKey && event.key === " ") {
                event.preventDefault();
                editor.update(() => {
                    insertAIAutoComplete(editor, settings, true);
                });
            }
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [editor, autoCompleteModel, thinking]);

    useEffect(() => cancelPendingSuggestion, [autoCompleteModel, thinking]);

    useEffect(() => {
        return mergeRegister(
            insertAIAutoCompleteTransform(editor, settings),
            editor.registerCommand(
                SELECTION_CHANGE_COMMAND,
                () => {
                    handleSelectionChange(editor);
                    return false;
                },
                COMMAND_PRIORITY_NORMAL
            ),
            editor.registerCommand(
                KEY_TAB_COMMAND,
                (event: KeyboardEvent) => {
                    event.preventDefault();
                    if (acceptSuggestion(editor)) {
                        return true;
                    }
                    return false;
                },
                COMMAND_PRIORITY_LOW
            )
        );
    }, [editor, autoCompleteModel, thinking]);
    return null;
}
