import { useState } from "react";
import { LENS_COLORS, Lens, lensColor } from "../../comments/lenses";
import { useTheme } from "../../theme/theme";

type Props = {
    lens: Lens;
    isNew: boolean;
    onSave: (lens: Lens) => void;
    onDelete?: () => void;
    onCancel: () => void;
};

/** Create / edit a custom lens. Its inputs take focus, unlike the rest of the panel. */
export default function LensEditor({ lens, isNew, onSave, onDelete, onCancel }: Props) {
    const theme = useTheme();
    const [name, setName] = useState(lens.name);
    const [instruction, setInstruction] = useState(lens.instruction);
    const [color, setColor] = useState(lens.color);
    const valid = name.trim() !== "" && instruction.trim() !== "";

    return (
        <form
            className="flex flex-col gap-2 border border-base-300 rounded-lg p-2 bg-base-200/50"
            onSubmit={(e) => {
                e.preventDefault();
                if (valid) onSave({ ...lens, name, instruction, color });
            }}
            onKeyDown={(e) => {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    onCancel();
                }
            }}
        >
            <input
                autoFocus
                className="input input-sm input-bordered w-full bg-surface text-base-content"
                placeholder="Lens name, e.g. Busy clinic owner"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
            />
            <textarea
                className="textarea textarea-bordered textarea-sm w-full bg-surface text-base-content leading-snug"
                rows={4}
                placeholder="What should this lens look for? e.g. Read as a clinic owner with 2 minutes: flag anything that doesn't earn its place."
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && valid) {
                        e.preventDefault();
                        onSave({ ...lens, name, instruction, color });
                    }
                }}
            />
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Lens color">
                {LENS_COLORS.map((c) => (
                    <button
                        type="button"
                        key={c}
                        role="radio"
                        aria-checked={c === color}
                        className={"w-5 h-5 rounded-full border-2 " + (c === color ? "border-base-content" : "border-surface")}
                        style={{ background: lensColor(c, theme) }}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setColor(c)}
                        title={c}
                    />
                ))}
            </div>
            <div className="flex items-center gap-1">
                {onDelete && !isNew && (
                    <button type="button" className="btn btn-ghost btn-xs normal-case text-error" onClick={onDelete}>
                        Delete
                    </button>
                )}
                <button type="button" className="btn btn-ghost btn-xs normal-case ml-auto" onClick={onCancel}>
                    Cancel
                </button>
                <button type="submit" className="btn btn-accent btn-xs normal-case" disabled={!valid}>
                    {isNew ? "Add lens" : "Save"}
                </button>
            </div>
        </form>
    );
}
