import type { EditorView } from "@codemirror/view";
import { Diagnostic, ErrorDiagnostic } from "jpfun";
import { revealSourceRange, setSourceDiagnostics, type SourceRange } from "./editor.js";
import { requiredElement } from "./platform.js";

interface DiagnosticsControllerOptions {
    editor: EditorView;
    showSource: () => void;
}

export interface DiagnosticsController {
    /** fatal 是打断了排版、又没有 span 可跳转的错误 */
    render(items: readonly Diagnostic[], fatal?: string): void;
}

function appendText(parent: HTMLElement, className: string, text: string) {
    const element = document.createElement("span");
    element.className = className;
    element.textContent = text;
    parent.append(element);
}

export function createDiagnosticsController(options: DiagnosticsControllerOptions): DiagnosticsController {
    const list = requiredElement<HTMLElement>("#diagnostics");
    const panel = requiredElement<HTMLElement>("#diagnosticsPanel");
    const count = requiredElement<HTMLElement>("#diagnosticCount");
    const summary = requiredElement<HTMLElement>("#diagnosticSummary");
    const tab = requiredElement<HTMLButtonElement>("#problemsTab");

    function addRow(severity: "error" | "warning", code: string, message: string, range?: SourceRange) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "diagnostic-row";
        row.dataset.severity = severity;
        appendText(row, "diagnostic-code", code);
        appendText(row, "diagnostic-message", message);
        if (range) {
            const line = options.editor.state.doc.lineAt(range.from);
            appendText(row, "diagnostic-position", `${line.number}:${range.from - line.from + 1}`);
            row.addEventListener("click", () => {
                options.showSource();
                revealSourceRange(options.editor, range);
            });
        }
        list.append(row);
    }

    return {
        render(items, fatal) {
            const ranges = setSourceDiagnostics(options.editor, items);
            const warningCount = items.filter(item => !(item instanceof ErrorDiagnostic)).length;
            const errorCount = items.length - warningCount + (fatal ? 1 : 0);
            const total = errorCount + warningCount;

            list.replaceChildren();
            panel.dataset.empty = String(total === 0);
            count.textContent = String(total);
            summary.textContent = total === 0
                ? "未发现诊断"
                : `${errorCount} 个错误 · ${warningCount} 个警告`;
            tab.dataset.severity = errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "";

            if (fatal) addRow("error", "排版中断", fatal);
            for (const [index, item] of items.entries()) {
                addRow(
                    item instanceof ErrorDiagnostic ? "error" : "warning",
                    item.code,
                    item.message,
                    ranges[index],
                );
            }
        },
    };
}