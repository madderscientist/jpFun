import { FunctionDef, ASTNodeBase, FunctionArgs, SourceSpan, ParserContext, ASTFunctionNode, ASTFunctionClass } from "../types";
import { Diagnostic, ErrorDiagnostic } from "../../parser/diagnostic";
import { NoteNameMap } from "../../parser/parse-utils/note-utils";
import { parseNoteName } from "./noteNameFSM";
import { GrammarCallNodeTyped } from "../../parser/grammarType";

class NoteFunction extends ASTFunctionNode {
    static def: FunctionDef = {
        name: ["note", "n"],
        description: "创建音符",
        example: `@note(name, acc, octave, color)
参数说明:
- name: [必填]音符名，可以是大写字母或者数字，不允许小写字母（会和降号冲突）。此参数写法有语法糖，见下。
- acc: [可选]的额外升降号字符串，例如 "##" 表示再升两个半音，"b" 表示再降一个半音。
- octave: [可选]八度，类型为数字。如果 name 是字母，则此项代表绝对八度；如果是数字，则此项代表相对八度。

语法糖：[音名][升降号][八度] 音名和升降号可以交换
例：A3# === @note(A3#) === @note(A, #, 3)
也支持 A99##bn 的写法。可以设置 note.octave 改变默认的绝对八度

支持 数字音名, 此时 octave 为相对八度
支持使用数字音名时使用相对八度，如 "1,," 代表在当前基准音（由上下文属性"1=?"决定）的基础上降低两倍八度，"1'" 代表在当前基准音的基础上提高一个八度
例：1#' === @note(1#') === @note(1, #, 1)。此时支持升降号写音名前面，如 #1'
`,
        allowExtraArgs: false,
        args: [
            {
                name: "name",
                type: "string",
                default: null,
            },
            {
                name: "acc",
                type: "string",
                default: "",
            },
            {   // 传递了就使用绝对音高
                name: "octave",
                type: "number",
                default: 4, // 如果是数字则默认值为0 需要代码中区分
            },
            {
                name: "color",
                type: "string",
                default: "#000",
            }
        ]
    };

    static deSugarAtom(source: string, start: number, end: number) {
        const parseResult = parseNoteName(source, start, end);
        if (parseResult instanceof Diagnostic) return null;
        const argMap: FunctionArgs = new Map();
        argMap.set("name", parseResult.name);
        if (parseResult.octave) argMap.set("octave", parseResult.octave);
        if (parseResult.acc) argMap.set("acc", parseResult.acc);
        const node: GrammarCallNodeTyped = {
            kind: "call",
            typed: true,
            name: "note",
            args: argMap,
            span: { start, end: parseResult.next },
        };
        return { next: parseResult.next, node };
    }

    get duration() { return 1; }
    labelable(): boolean { return true; }

    name: string;   // 固化之后的数字 用于渲染
    octave: number; // 固化后相对于基准八度的八度偏移
    acc: string;
    color: string;
    midi: number = NaN; // 绝对的MIDI音高值 用于演奏 为了适应“无需还原号”的需求，此处的midi不管acc acc由演奏时动态确定
    constructor(sourceSpan: SourceSpan, args: FunctionArgs, ctx: ParserContext, parent: ASTNodeBase | null = null) {
        super(sourceSpan, parent);
        [this.name, this.acc, this.octave, this.color] = this.getArgValue(args, ctx) as [string, string, number, string];
        // 创建时就固化参数值
        // 校验 note name
        const parseResult = parseNoteName(this.name);
        if (parseResult instanceof Diagnostic) {
            parseResult.span = sourceSpan;   // 定位到整个函数调用
            throw parseResult;
        }
        this.name = parseResult.name;
        // 校验octave
        const inputOctave = args.get("octave") ?? args.get(2);
        if (inputOctave !== undefined) {
            if (parseResult.octave !== null && parseResult.octave != inputOctave) throw new ErrorDiagnostic(
                "E_NOTE_OCTAVE_CONFLICT",
                `函数 @note 的参数 "octave" 与音符名称中的八度信息冲突: ${inputOctave} != ${parseResult.octave}`,
                sourceSpan
            );
        } else {
            // 没有传入octave 此时this.octave是字母模式下的默认值 仅在数字模式下才需要被覆盖
            if (!parseResult.absOctave) this.octave = parseResult.octave ?? 0;
        }
        // 补充acc
        if (parseResult.acc !== null) this.acc = parseResult.acc + this.acc;

        // 固化note name 为数字; 固化 octave 为相对于基准八度的偏移; 计算 MIDI 音高值（不包含acc信息）
        // 固化操作在之后时间遍历时进行【还没做】
        // const baseMidi = ctx.baseMidi;   // 基于调性的C4的MIDI值
        // if (parseResult.absOctave) {
        //     this.midi = NoteNameMap[this.name] + (this.octave + 1) * 12;
        //     const baseOctave = Math.floor(baseMidi / 12) - 1;   // 基准八度
        //     this.octave -= baseOctave;
        // } else {
        //     this.midi = baseMidi + NoteNameMap[this.name] + this.octave * 12;
        // }
    }

    toString(source: string): string {
        return `@note(${this.name}, ${this.acc}, ${this.octave}, ${this.color})`;
    }
}

export const NoteNode: ASTFunctionClass = NoteFunction;
