import { createDropdown, readStoredValue, requiredElement, storeValue } from "./platform.js";

type WorkbenchTheme = "2026-light" | "quiet-light";

const STORAGE_KEY = "jpfun-theme";
const themeLabels: Record<WorkbenchTheme, string> = {
    "2026-light": "2026 Light",
    "quiet-light": "Quiet Light",
};

function isWorkbenchTheme(value: string | null): value is WorkbenchTheme {
    return value === "2026-light" || value === "quiet-light";
}

export function initializeTheme() {
    const trigger = requiredElement<HTMLButtonElement>("#themeButton");
    const menu = requiredElement<HTMLElement>("#themeMenu");
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-theme-value]")];
    const closeMenu = createDropdown(trigger, menu, "[aria-checked='true']");

    function apply(theme: WorkbenchTheme) {
        document.documentElement.dataset.theme = theme;
        trigger.textContent = themeLabels[theme];
        for (const button of buttons) {
            button.setAttribute("aria-checked", String(button.dataset.themeValue === theme));
        }
        storeValue(STORAGE_KEY, theme);
    }

    for (const button of buttons) {
        button.addEventListener("click", () => {
            const theme = button.dataset.themeValue ?? null;
            if (!isWorkbenchTheme(theme)) return;
            apply(theme);
            closeMenu(true);
        });
    }

    const stored = readStoredValue(STORAGE_KEY);
    apply(isWorkbenchTheme(stored) ? stored : "2026-light");
}