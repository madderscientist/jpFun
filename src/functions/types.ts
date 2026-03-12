import type { SourceSpan } from "../parser/types";
import type { ParserContext, deSugarAtomFunction, deSugarRelationFunction } from "../parser/parserContext";
import { Diagnostic } from "../parser/diagnostic";

export type { SourceSpan, ParserContext };
export type paramType = "string" | "number" | "boolean" | "content" | "label";
export type paramValue = string | number | boolean | ASTBraceNode | ASTNodeBase;

// 以后考虑增加一个id字符串 但保留parent的引用
export class ASTNodeBase {
    sourceSpan: SourceSpan; // 和源码的映射
    parent: ASTNodeBase | null;
    // 空数组表示可以有 null表示自己就是叶子
    get children(): ASTNodeBase[] | null { return null; }

    constructor(
        sourceSpan: SourceSpan,
        parent: ASTNodeBase | null = null
    ) {
        this.sourceSpan = sourceSpan;
        this.parent = parent;
    }

    // 关于时间修饰
    get duration(): number { return 0; }    // 默认时间为0 时间为0的不可以被dot等修饰

    // 去糖后文本输出
    toString(source: string): string {
        return source.slice(this.sourceSpan.start, this.sourceSpan.end);
    }
}

export class ASTTextNode extends ASTNodeBase {}

// label节点只负责语义标记，不参与渲染和其他逻辑
// 绑定也在解析后完成 和本节点无关
// 主要用途是高亮等编辑器功能
export class ASTLabelNode extends ASTNodeBase {
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

// 表示`{}`
// span.start 是 `{` 的位置; (span.end-1) 是 `}` 的位置
// 判断是否是创建的节点：
export class ASTBraceNode extends ASTNodeBase {
    content: ASTNodeBase[];
    get children() { return this.content; }

    constructor(sourceSpan: SourceSpan, content: ASTNodeBase[], parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        this.content = content;
        this.content.forEach(item => item.parent = this);
    }

    get duration(): number {
        let total = 0;
        for (const item of this.content) {
            total += item.duration;
        } return total;
    }
    positiveDurationNumber(): number {
        return this.duration > 0 ? 1 : 0;
    }

    innerSpan(): SourceSpan {
        return ASTBraceNode.getContentSpan(this.content);
    }

    // 是复制的
    static getContentSpan(content: ASTNodeBase[] | ASTNodeBase): SourceSpan {
        if (Array.isArray(content)) {
            if (content.length === 0) return { start: 0, end: 0 };
            const firstSpan = ASTBraceNode.getContentSpan(content[0]);
            const lastSpan = ASTBraceNode.getContentSpan(content[content.length - 1]);
            return { start: firstSpan.start, end: lastSpan.end };
        } else return { start: content.sourceSpan.start, end: content.sourceSpan.end };
    }

    toString(source: string): string {
        return `{${this.content.map(item => item.toString(source)).join("")}}`;
    }
}

export interface FunctionArgDef {
    name?: string;  // 参数名 (可选，位置参数可以没有)
    type: paramType;// 参数类型
    /** 参数默认值 null表示必填 否则该函数跳过 */
    default: paramValue | null;
}

export interface FunctionDef {
    name: string | string[]; // 函数名或别名列表
    description: string; // 函数描述
    example: string; // 使用示例
    allowExtraArgs: boolean; // 是否允许传入定义中未声明的额外参数 额外参数都会得到 SourceSpan
    args: FunctionArgDef[]; // 参数定义列表
}

// allowExtraArgs = true 时未知参数将保留 SourceSpan
export type FunctionArgs = Map<string | number, paramValue | SourceSpan>; // 参数值映射，key可以是位置索引（0,1,2...）或命名参数名

// 所有函数节点的基类，提供通用的参数提取方法和标签功能
// 非正常函数则实例化该函数 特征是getDef为undefined
export class ASTFunctionNode extends ASTNodeBase {
    // 默认不可被标签引用，具体函数可重写
    labelable(): boolean { return false; }
    label?: string; // 可选的标签名，只有当 labelable() 返回 true 时才有效; 或者是label节点

    // 获取函数定义 对于未知函数，不定义def
    static def?: FunctionDef;
    get def(): FunctionDef | undefined {
        return (this.constructor as typeof ASTFunctionNode).def;
    }   // 默认让实例返回静态属性def 后面的类应该只重写static def
    // 实例访问: new ().def 或 new ().constructor.def
    // 静态访问: 类名.def 或 类名.prototype.def

    // 判断函数定义是否有效（即是否为已注册的函数）
    isValidFunc(): boolean { return !!this.def; }
    get callName(): string {
        const names = this.def?.name;
        if (!names) return "";
        return Array.isArray(names) ? names[0] : names;
    }

    // 去糖函数
    static deSugarAtom: deSugarAtomFunction = () => null; // 默认没有去糖，子类只需要定义static deSugarAtom方法即可
    get deSugarAtom(): deSugarAtomFunction { return (this.constructor as typeof ASTFunctionNode).deSugarAtom; }

    static deSugarRelation: deSugarRelationFunction = () => null;
    get deSugarRelation(): deSugarRelationFunction { return (this.constructor as typeof ASTFunctionNode).deSugarRelation; }

    // 通用的参数提取方法 从定义找传参
    getArgValue(args: FunctionArgs, ctx: ParserContext): (paramValue | null)[] {
        const def = this.def;
        if (!def) return [];
        const defArgs: FunctionArgDef[] = def.args;
        // 使用第一个名称作为前缀
        const prefix = Array.isArray(def.name) ? def.name[0] : def.name;
        return defArgs.map((argDef, index) => {
            // 优先使用命名参数，否则使用位置参数
            const argValue = (argDef.name ? args.get(argDef.name) : null) ?? args.get(index) ?? ctx.variables.get(`${prefix}.${argDef.name}`) ?? argDef.default;
            if (argValue === null) throw Diagnostic.error.MissingArg(prefix, argDef.name || index);
            return argValue; // 假设解析器已经保证了类型正确
        });
    }

    toString(source: string): string {
        const name = this.callName;
        if (!name) return super.toString(source);
        return `@${name} `;
    }

    /**
     * 用于语法糖向前结合
     * 一般向前结合都是寻找brace或者function
     * 文本节点会打断连接 注意解析时已经跳过了空格 因此允许语法糖之间有空格
     */
    static findLastFuncContentNode(nodes: ASTNodeBase[], i: number): ASTNodeBase | null {
        for (; i >= 0; i--) {
            const n = nodes[i];
            if (n instanceof ASTTextNode) return null;
            if (n instanceof ASTFunctionNode || n instanceof ASTBraceNode) return n;
        } return null;
    }
}

// 有实际含义的函数类的构造都应该长这样
export type ASTFunctionClass = new (
    sourceSpan: SourceSpan,
    args: FunctionArgs,
    ctx: ParserContext,
    parent: ASTNodeBase | null
) => ASTFunctionNode;
