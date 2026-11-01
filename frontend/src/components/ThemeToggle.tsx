import BrightnessAutoIcon from "@mui/icons-material/BrightnessAutoOutlined";
import LightModeIcon from "@mui/icons-material/LightModeOutlined";
import DarkModeIcon from "@mui/icons-material/DarkModeOutlined";
import { cycleThemePreference, ThemePreference, useTheme, useThemePreference } from "../theme/theme";

const LABEL: Record<ThemePreference, string> = { system: "System", light: "Light", dark: "Dark" };
const NEXT: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };

/** Menu-bar icon button cycling System -> Light -> Dark. */
export default function ThemeToggle() {
    const preference = useThemePreference();
    const theme = useTheme();
    const Icon = preference === "system" ? BrightnessAutoIcon : preference === "light" ? LightModeIcon : DarkModeIcon;
    const current = preference === "system" ? `System (${theme})` : LABEL[preference];
    return (
        <button
            className="btn btn-xs btn-ghost btn-square border-base-300"
            onClick={cycleThemePreference}
            title={`Theme: ${current}. Click for ${LABEL[NEXT[preference]]}`}
            aria-label={`Theme: ${current}`}
        >
            <Icon sx={{ fontSize: 16 }} />
        </button>
    );
}
