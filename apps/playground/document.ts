import { readStoredValue, storeValue } from "./platform.js";

const DRAFT_STORAGE_KEY = "jpfun-draft-source";

interface FilePickerWindow extends Window {
    showOpenFilePicker?: (options: object) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options: object) => Promise<FileSystemFileHandle>;
}

interface DocumentControllerOptions {
    getSource(): string;
    importFile(file: File): Promise<{ source: string; fileName: string; linked: boolean }>;
    replaceSource(source: string): void;
    onStateChanged(fileName: string, dirty: boolean): void;
    onError(action: "打开" | "保存", error: unknown): void;
}

const openPickerOptions = {
    types: [{
        description: "jpFun 或 MIDI 曲谱",
        accept: {
            "text/plain": [".jpfun"],
            "audio/midi": [".mid", ".midi"],
        },
    }],
    excludeAcceptAllOption: true,
};
const savePickerOptions = {
    types: [{ description: "jpFun 曲谱", accept: { "text/plain": [".jpfun"] } }],
    excludeAcceptAllOption: true,
};
const DRAFT_WRITE_DELAY = 400;

export function loadDraftSource(fallback: string): string {
    const source = readStoredValue(DRAFT_STORAGE_KEY) || fallback;
    storeValue(DRAFT_STORAGE_KEY, source);
    return source;
}

function isCancelled(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

function chooseUploadedFile(): Promise<File | null> {
    return new Promise(resolve => {
        const input = document.createElement("input");
        const controller = new AbortController();
        input.type = "file";
        input.accept = ".jpfun,.mid,.midi";
        function finish(file: File | null) {
            controller.abort();
            resolve(file);
        }

        input.addEventListener("change", () => finish(input.files?.[0] ?? null), { signal: controller.signal });
        input.addEventListener("cancel", () => finish(null), { signal: controller.signal });
        input.click();
    });
}

function downloadSource(source: string, fileName: string) {
    const url = URL.createObjectURL(new Blob([source], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function createDocumentController(options: DocumentControllerOptions) {
    const pickerWindow = window as FilePickerWindow;
    let fileName = "score.jpfun";
    let savedSource: string | null = null;
    let fileHandle: FileSystemFileHandle | null = null;
    let draftTimer: number | undefined;
    let draftPending = false;

    function updateState() {
        options.onStateChanged(fileName, savedSource === null || options.getSource() !== savedSource);
    }

    function flushDraft() {
        window.clearTimeout(draftTimer);
        draftTimer = void 0;
        draftPending = false;
        storeValue(DRAFT_STORAGE_KEY, options.getSource());
    }

    function sourceChanged() {
        updateState();
        window.clearTimeout(draftTimer);
        draftTimer = void 0;
        draftPending = true;
    }

    function rendered() {
        if (!draftPending) return;
        draftTimer = window.setTimeout(flushDraft, DRAFT_WRITE_DELAY);
    }

    function markSaved(source: string) {
        savedSource = source;
        flushDraft();
        updateState();
    }

    async function open() {
        if (savedSource === null || options.getSource() !== savedSource) {
            if (!window.confirm("当前曲谱尚未保存，打开其他文件将替换这些修改。是否继续？")) return;
        }

        try {
            let sourceFile: File | null;
            let nextHandle: FileSystemFileHandle | null = null;
            if (pickerWindow.showOpenFilePicker) {
                [nextHandle] = await pickerWindow.showOpenFilePicker(openPickerOptions);
                sourceFile = await nextHandle.getFile();
            } else {
                sourceFile = await chooseUploadedFile();
            }
            if (!sourceFile) return;

            const imported = await options.importFile(sourceFile);
            fileName = imported.fileName;
            fileHandle = imported.linked ? nextHandle : null;
            savedSource = imported.linked ? imported.source : null;
            options.replaceSource(imported.source);
            if (imported.linked) markSaved(options.getSource());
            else {
                flushDraft();
                updateState();
            }
        } catch (error) {
            if (!isCancelled(error)) options.onError("打开", error);
        }
    }

    async function save() {
        const source = options.getSource();
        try {
            if (!fileHandle && pickerWindow.showSaveFilePicker) {
                fileHandle = await pickerWindow.showSaveFilePicker({
                    ...savePickerOptions,
                    suggestedName: fileName,
                });
                fileName = fileHandle.name;
            }

            if (fileHandle) {
                const writable = await fileHandle.createWritable();
                await writable.write(source);
                await writable.close();
            } else {
                downloadSource(source, fileName);
            }
            markSaved(source);
        } catch (error) {
            if (!isCancelled(error)) options.onError("保存", error);
        }
    }

    updateState();
    return { sourceChanged, rendered, flushDraft, open, save };
}