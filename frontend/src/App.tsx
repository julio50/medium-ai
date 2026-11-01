import Editor from "./Editor";
import MenuBar from "./components/MenuBar";
import { useState, useRef, useEffect } from "react";
import { EditorState } from "lexical";
import { SAVE_ENDPOINT, DEFAULT_MODEL } from "./constants";
import { toStoredDocument } from "./utils/editorStorage";
import { AISettingsContext, ThinkingLevel } from "./ai/settings";
import ThinkingIndicator from "./components/ThinkingIndicator";
import { useDebounce } from "./plugins/FloatingElements/CodeActionMenu/utils";

import { AutoCompleteModel } from "./components/MenuBar";

function App() {
    const [currentModel, setCurrentModelState] = useState<AutoCompleteModel>(
        () => localStorage.getItem("ai-model") ?? DEFAULT_MODEL
    );
    const setCurrentModel = (model: AutoCompleteModel) => {
        setCurrentModelState(model);
        localStorage.setItem("ai-model", model);
    };
    const [thinking, setThinkingState] = useState<ThinkingLevel>(() => {
        const saved = localStorage.getItem("ai-thinking");
        if (saved === "true") return "high"; // old on/off setting
        return (["off", "low", "medium", "high"].includes(saved ?? "") ? saved : "off") as ThinkingLevel;
    });
    const setThinking = (level: ThinkingLevel) => {
        setThinkingState(level);
        localStorage.setItem("ai-thinking", level);
    };
    const [isSaveFailed, setIsSaveFailed] = useState(false);
    const editorStateRef = useRef<EditorState | null>(null);

    const saveContent = async () => {
        if (editorStateRef.current === null) {
            return;
        }
        const content = toStoredDocument(editorStateRef.current);
        try {
            const response = await fetch(SAVE_ENDPOINT, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(content),
            });
            if (response.ok) {
                console.log("Saved!");
                setIsSaveFailed(false);
            } else {
                console.log("Error saving");
                setIsSaveFailed(true);
            }
        } catch (e) {
            console.log("Error saving: Backend not running?");
            setIsSaveFailed(true);
        }
    };

    const saveContentDebounced = useDebounce(saveContent, 1000);

    useEffect(() => {
        const saveOnKeyPress = (e: KeyboardEvent) => {
            if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                saveContentDebounced();
            }
        };
        document.addEventListener("keydown", saveOnKeyPress);

        return () => {
            document.removeEventListener("keydown", saveOnKeyPress);
        };
    }, []);

    return (
        <AISettingsContext.Provider value={{ model: currentModel, thinking }}>
            <MenuBar
                currentModel={currentModel}
                setCurrentModel={setCurrentModel}
                thinking={thinking}
                setThinking={setThinking}
                saveState={saveContentDebounced}
                isSaveFailed={isSaveFailed}
            />
            <Editor
                autoCompleteModel={currentModel}
                editorStateRef={editorStateRef}
            />
            <ThinkingIndicator />
        </AISettingsContext.Provider>
    );
}

export default App;
