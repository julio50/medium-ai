import { createContext, useContext } from "react";
import { DEFAULT_MODEL } from "../constants";

export type ThinkingLevel = "off" | "low" | "medium" | "high";
export const THINKING_LEVELS: { value: ThinkingLevel; label: string; hint: string }[] = [
    { value: "off", label: "Off", hint: "Fast: the -instruct model, no thinking" },
    { value: "low", label: "Low", hint: "Thinks a little (~600 tokens), then answers from its notes" },
    { value: "medium", label: "Med", hint: "Thinks more (~1,500 tokens), then answers from its notes" },
    { value: "high", label: "High", hint: "Thinks as long as it needs (no limit)" },
];

export type AISettings = {
    /** model family (e.g. "spark"); "none" disables autosuggest */
    model: string;
    /** off = the family's "-instruct" variant; low/medium/high = the thinking
     *  variant ("spark"), with a reasoning budget below high */
    thinking: ThinkingLevel;
};

export const AISettingsContext = createContext<AISettings>({
    model: DEFAULT_MODEL,
    thinking: "off",
});
export const useAISettings = () => useContext(AISettingsContext);

/** request fields sent with every AI call */
export const modelParams = (s: AISettings) => ({
    modelName: s.model === "none" ? null : s.model,
    thinkingLevel: s.thinking,
});
