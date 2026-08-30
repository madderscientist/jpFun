export function requiredElement<T extends Element>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (element) return element;
    throw new Error(`Required element not found: ${selector}`);
}

export function readStoredValue(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
}

export function storeValue(key: string, value: string) {
    try { localStorage.setItem(key, value); } catch { /* 存储不可用时静默降级 */ }
}

const classicScripts = new Map<string, Promise<void>>();

/** 按需加载不提供 ESM 入口的远程脚本；失败后允许下一次操作重试。 */
export function loadClassicScript(source: string): Promise<void> {
    const pending = classicScripts.get(source);
    if (pending) return pending;

    const script = document.createElement("script");
    script.src = source;
    script.async = true;
    const loaded = new Promise<void>((resolve, reject) => {
        script.addEventListener("load", () => resolve(), { once: true });
        script.addEventListener("error", () => {
            classicScripts.delete(source);
            script.remove();
            reject(new Error(`无法加载远程脚本：${source}`));
        }, { once: true });
    });
    classicScripts.set(source, loaded);
    document.head.append(script);
    return loaded;
}

/**
 * 下拉菜单的开合：点触发按钮切换，点菜单外或按 Esc 关闭
 * @param initialFocus 打开时聚焦的菜单项选择器
 * @returns 关闭函数，传 true 表示把焦点还给触发按钮
 */
export function createDropdown(
    trigger: HTMLButtonElement,
    menu: HTMLElement,
    initialFocus = "button",
) {
    function close(refocus = false) {
        if (menu.hidden) return;
        menu.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        if (refocus) trigger.focus();
    }
    trigger.addEventListener("click", () => {
        if (!menu.hidden) return close();
        menu.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        menu.querySelector<HTMLElement>(initialFocus)?.focus();
    });
    document.addEventListener("pointerdown", event => {
        const target = event.target as Node;
        if (!menu.contains(target) && !trigger.contains(target)) close();
    });
    document.addEventListener("keydown", event => {
        if (event.key === "Escape") close(true);
    });
    return close;
}