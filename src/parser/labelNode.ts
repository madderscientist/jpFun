import { SourceSpan, ASTNodeBase } from "../functions/types";

// label节点只负责语义标记，不参与渲染和其他逻辑
// 绑定也在解析后完成 和本节点无关
// 主要用途是高亮等编辑器功能
export class LabelNode extends ASTNodeBase {
    label: string;
    // parent 就是指向的节点
    constructor(sourceSpan: SourceSpan, label: string, parent: ASTNodeBase) {
        super(sourceSpan, parent);
        this.label = label;
    }

    toString(source: string): string {
        return `@${this.label} `;
    }
}