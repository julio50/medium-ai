/** @type {import('tailwindcss').Config} */
export default {
    content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
    // `data-theme` on <html> is the one switch (set by index.html before the
    // first paint, then by src/theme/theme.ts): daisyUI themes, the CSS
    // variables in index.css and `dark:` utilities all follow it.
    darkMode: ["class", '[data-theme="dark"]'],
    theme: {
        extend: {
            fontFamily: {
                merriweather: ["merriweather", "sans-serif"],
                robotomono: ["roboto-mono", "monospace"],
                title: ["dm-serif-display", "serif"],
                lato: ["lato", "sans-serif"],
                poppins: ["poppins", "sans-serif"],
            },
            // app tokens daisyUI has no name for (values in index.css)
            colors: {
                // raised UI: cards, popovers, pills, menus
                surface: "rgb(var(--color-surface) / <alpha-value>)",
                // error notices: text and border
                danger: "rgb(var(--color-danger) / <alpha-value>)",
                "danger-edge": "rgb(var(--color-danger-edge) / <alpha-value>)",
            },
        },
    },
    plugins: [require("daisyui")],
    daisyui: {
        themes: [
            "light",
            {
                dark: {
                    ...require("daisyui/src/colors/themes")["[data-theme=dark]"],
                    // same accent as light, so buttons and toggles keep their look
                    accent: "#37cdbe",
                    "accent-focus": "#2ba69a",
                    "accent-content": "#163835",
                    // default `btn`s (text toolbar) must stand out from the page
                    neutral: "#41444d",
                    "neutral-focus": "#2c2e34",
                    "neutral-content": "#e4e4e7",
                    // neutral greys for a writing surface; like light, base-200 is a
                    // subtle fill and base-300 a border / stronger fill
                    "base-100": "#1b1c1f",
                    "base-200": "#2c2d33",
                    "base-300": "#3b3d44",
                    "base-content": "#d4d4d8",
                },
            },
        ],
        // no prefers-color-scheme media rule: the System setting is resolved in
        // JS so every theme-dependent style switches together
        darkTheme: false,
    },
};
