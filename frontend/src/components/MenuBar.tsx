import { useEffect, useState } from "react";
import { MODELS_ENDPOINT } from "../constants";
import { THINKING_LEVELS, ThinkingLevel } from "../ai/settings";
import { FOCUS_MODE_SHORTCUT, toggleFocusMode, useFocusMode } from "../plugins/FocusModePlugin/focusMode";
import { setQuietTyping, useQuietTyping } from "../plugins/QuietTypingPlugin/quietTyping";
import { exportPdf } from "../utils/exportPdf";
import { SEARCH_SHORTCUT, toggleSearch, useSearchOpen } from "../search/searchPanel";
import ThemeToggle from "./ThemeToggle";

// a model family served by the backend, or "none" to disable autosuggest
export type AutoCompleteModel = string;

type ModelInfo = { name: string; canThink: boolean };

type MenuBarProps = {
    currentModel: AutoCompleteModel;
    setCurrentModel: (model: AutoCompleteModel) => void;
    thinking: ThinkingLevel;
    setThinking: (level: ThinkingLevel) => void;
    saveState: () => void;
    isSaveFailed: boolean;
};

const MenuBar = ({
    currentModel,
    setCurrentModel,
    thinking,
    setThinking,
    saveState,
    isSaveFailed,
}: MenuBarProps) => {
    const [showOptions, setShowOptions] = useState(false);
    const [models, setModels] = useState<ModelInfo[]>([]);
    const focusMode = useFocusMode();
    const quietTyping = useQuietTyping();
    const searchOpen = useSearchOpen();

    useEffect(() => {
        fetch(MODELS_ENDPOINT)
            .then((r) => r.json())
            .then((data: { default: string; models: ModelInfo[] }) => {
                setModels(data.models);
                if (currentModel !== "none" && !data.models.some((m) => m.name === currentModel)) {
                    setCurrentModel(data.default);
                }
            })
            .catch(() => console.log("Could not load models: backend not running?"));
    }, []);

    const info = models.find((m) => m.name === currentModel);
    // unknown until the list loads: let the toggle work
    const canThink = info ? info.canThink : models.length === 0;

    return (
        <div className="navbar bg-base-100 flex flex-row justify-end" data-app-chrome="menubar">
            <div className="mx-4 flex items-center">
                <div
                    className="flex items-center gap-1 mr-4 font-poppins"
                    onMouseDown={(e) => e.preventDefault()} // don't steal the editor's cursor
                >
                    <button
                        className={"btn btn-xs normal-case " + (searchOpen ? "btn-accent" : "btn-ghost border-base-300")}
                        onClick={toggleSearch}
                        aria-pressed={searchOpen}
                        title={`Search this document by words or meaning (${SEARCH_SHORTCUT})`}
                    >
                        Search
                    </button>
                    <button
                        className={"btn btn-xs normal-case " + (focusMode ? "btn-accent" : "btn-ghost border-base-300")}
                        onClick={toggleFocusMode}
                        aria-pressed={focusMode}
                        title={`Focus mode: dim everything but the current paragraph (${FOCUS_MODE_SHORTCUT})`}
                    >
                        Focus
                    </button>
                    <button
                        className={"btn btn-xs normal-case " + (quietTyping ? "btn-accent" : "btn-ghost border-base-300")}
                        onClick={() => setQuietTyping(!quietTyping)}
                        aria-pressed={quietTyping}
                        title="Hide the menu, mic and margin while you type; they come back when you move the mouse"
                    >
                        Auto-hide
                    </button>
                    <button
                        className="btn btn-xs btn-ghost border-base-300 normal-case"
                        onClick={exportPdf}
                        title='Export the document as a PDF (choose "Save as PDF" in the print dialog)'
                    >
                        Export PDF
                    </button>
                    <ThemeToggle />
                </div>
                <div
                    className={
                        "flex items-center gap-2 mr-4 font-poppins text-sm text-base-content " +
                        (canThink ? "" : "opacity-40")
                    }
                    title={canThink ? undefined : `"${currentModel}" has no thinking / instruct variants`}
                >
                    Thinking
                    <div className="btn-group">
                        {THINKING_LEVELS.map((l) => {
                            const active = (canThink ? thinking : "off") === l.value;
                            return (
                                <button
                                    key={l.value}
                                    className={
                                        "btn btn-xs normal-case " +
                                        (active ? "btn-accent" : "btn-ghost border-base-300")
                                    }
                                    disabled={!canThink}
                                    title={
                                        l.value === "off"
                                            ? `${l.hint}: "${currentModel}-instruct"`
                                            : `${l.hint}: "${currentModel}"`
                                    }
                                    onClick={() => setThinking(l.value)}
                                >
                                    {l.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
                <div className="dropdown dropdown-end">
                    <label
                        tabIndex={0}
                        onClick={() => setShowOptions(!showOptions)}
                        className="btn btn-ghost btn-sm normal-case"
                    >
                        {currentModel}
                    </label>
                    {showOptions && (
                        <ul
                            tabIndex={0}
                            className="dropdown-content menu-compact menu p-2 shadow rounded-box bg-surface text-base-content font-poppins dark:ring-1 dark:ring-base-300 w-64 max-h-96 overflow-y-auto flex-nowrap"
                        >
                            {[...models, { name: "none", canThink: false }].map((m) => (
                                <li key={m.name}>
                                    <a
                                        href="#"
                                        className="hover:bg-base-200 flex justify-between"
                                        onClick={() => {
                                            setCurrentModel(m.name);
                                            setShowOptions(false);
                                        }}
                                    >
                                        <span>{m.name === "none" ? "none (no autosuggest)" : m.name}</span>
                                        {m.canThink && (
                                            <span className="text-xs text-base-content/50" title="has thinking + instruct variants">
                                                thinks
                                            </span>
                                        )}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                <button
                    className={
                        "btn btn-sm btn-accent ml-4" +
                        (isSaveFailed ? " btn-error" : "")
                    }
                    onClick={saveState}
                >
                    {isSaveFailed ? "Save Failed" : "Save"}
                </button>
            </div>
        </div>
    );
};

export default MenuBar;
