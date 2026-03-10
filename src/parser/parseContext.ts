import { Diagnostic } from "./diagnostic";
import { ASTFunctionClass, ASTFunctionNode, ASTNodeBase, deSugarFunction } from "../functions/types";
import { tonality2Midi } from "./parse-utils/note-utils";

const DEFAULT_FONT_SIZE = 22;
const DEFAULT_STRICT_MODE = false;
const DEFAULT_TONALITY = "C";
export const DEFAULT_OCTAVE = 4;

// 解析上下文
export class ParserContext {
    source: string; // 源代码
    diagnostics: Diagnostic[];  // 诊断信息
    variables: Map<string, any>;    // `@set` 定义的变量
    functions: Map<string, ASTFunctionClass>; // 函数定义查找表
    deSugarFns: deSugarFunction[]; // 去糖函数列表

    // .labelable() 为 true 的节点会被加入到 labelableNodes 中，供标签绑定使用
    labelableNodes: ASTFunctionNode[];
    toConsume: ASTNodeBase[]; // 待消费的节点列表

    constructor(ctx: ParserContext | {
        source: string;
        diagnostics?: Diagnostic[];
        variables?: Map<string, any>;
        functions?: Map<string, ASTFunctionClass>;
        deSugarFns?: deSugarFunction[];
        labelableNodes?: ASTFunctionNode[];
        toConsume?: ASTNodeBase[];
    }) {
        if (ctx instanceof ParserContext) {
            // 构建子上下文
            this.source = ctx.source;
            this.diagnostics = ctx.diagnostics; // 诊断信息全局共享
            this.variables = new Map(ctx.variables);    // 继承但不修改父上下文的变量
            this.functions = ctx.functions; // 函数定义全局共享
            this.deSugarFns = ctx.deSugarFns; // 去糖方法全局共享
            this.labelableNodes = ctx.labelableNodes;   // 标签是全局属性
            this.toConsume = [];    // 待消费节点不共享，每个上下文单独维护
        } else {
            this.source = ctx.source;
            this.diagnostics = ctx.diagnostics ?? [];
            this.variables = ctx.variables ?? new Map();
            this.functions = ctx.functions ?? new Map();
            this.labelableNodes = ctx.labelableNodes ?? [];
            this.toConsume = ctx.toConsume ?? [];
            if (ctx.deSugarFns) {
                this.deSugarFns = ctx.deSugarFns;
            } else {
                this.deSugarFns = ParserContext.partialOrderDeSugarCls(this.functions.values());
            }
        }
        this.baseMidi = tonality2Midi(this.tonality, DEFAULT_OCTAVE);
    }

    // 如果 A 可以消费 B，则 A 的去糖函数在 B 之后
    static partialOrderDeSugarCls(classes: Iterable<ASTFunctionClass>): deSugarFunction[] {
        // 去重 因为一个函数有多个别名
        const deSugarFns: Set<deSugarFunction> = new Set();
        for (const fnClass of classes) {
            const deSugar = (fnClass as unknown as typeof ASTFunctionNode).deSugar;
            if (deSugar && deSugar !== ASTFunctionNode.deSugar) deSugarFns.add(deSugar);
        }
        return [...deSugarFns];
    }

    pushNewNode(node: ASTNodeBase) {
        this.toConsume.push(node);
        if (node instanceof ASTFunctionNode && node.labelable()) {
            this.labelableNodes.push(node);
        }
    }

    get fontSize(): number {
        return this.variables.get("fontsize") ?? DEFAULT_FONT_SIZE;
    }
    set fontSize(size: number) {
        this.variables.set("fontsize", size);
    }

    get strict(): boolean {
        return this.variables.get("strict") ?? DEFAULT_STRICT_MODE;
    }
    set strict(value: boolean) {
        this.variables.set("strict", value);
    }

    get tonality(): string {
        return this.variables.get("tonality") ?? DEFAULT_TONALITY;
    }
    set tonality(value: string) {
        const oldOctave = Math.floor(this.baseMidi / 12) - 1;
        this.baseMidi = tonality2Midi(value, oldOctave);
        this.variables.set("tonality", value);
    }
    baseMidi: number;   // C4 的 MIDI 音高为 60

    registerFunctions(functionClasses: ASTFunctionClass[]) {
        const map = this.functions;
        for (const funcClass of functionClasses) {
            const def = (funcClass as unknown as typeof ASTFunctionNode).def;
            if (!def) continue; // 没有定义的函数不注册
            const names = Array.isArray(def.name) ? def.name : [def.name];
            for (const name of names) {
                if (map.has(name.toLowerCase())) {
                    throw new Error(`Duplicate function name detected: ${name}`);
                }
                map.set(name.toLowerCase(), funcClass);
            }
        }
        this.deSugarFns = ParserContext.partialOrderDeSugarCls(map.values());
    }
}

