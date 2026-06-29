import { ASTFunctionClass } from "./ASTtypes.js";
import { BarNode } from "./bar/index.js";
import { BeamNode } from "./beam/index.js";
import { BoxNode } from "./box/index.js";
import { DashNode } from "./dash/index.js";
import { DivNode } from "./div/index.js";
import { DotNode } from "./dot/index.js";
import { KeyNode } from "./key/index.js";
import { BrNode } from "./br/index.js";
import { NoteNode } from "./note/index.js";
import { OverNode } from "./over/index.js";
import { StackNode } from "./stack/index.js";
import { SetNode } from "./set/index.js";
import { TempoNode } from "./tempo/index.js";
import { TextNode } from "./text/index.js";
import { TieNode } from "./tie/index.js";
import { VoiceNode } from "./voice/index.js";

export const defaultFunctions: ASTFunctionClass[] = [
    NoteNode, DashNode, BarNode, // 有实体
    DivNode, DotNode,   // 装饰性
    VoiceNode,  // 歌词
    BrNode,     // 排版
    StackNode,   // 时间同步
    OverNode,
    TieNode, BeamNode,
    BoxNode,
    SetNode, KeyNode, TempoNode,    // 设置
    TextNode,
];