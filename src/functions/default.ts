import { ASTFunctionClass } from "./ASTtypes";
import { BarNode } from "./bar";
import { BeamNode } from "./beam";
import { BoxNode } from "./box";
import { DashNode } from "./dash";
import { DivNode } from "./div";
import { DotNode } from "./dot";
import { KeyNode } from "./key";
import { LineNode } from "./line";
import { NoteNode } from "./note";
import { OverNode } from "./over";
import { SetNode } from "./set";
import { TempoNode } from "./tempo";
import { TextNode } from "./text";
import { TieNode } from "./tie";
import { VoiceNode } from "./voice";

export const defaultFunctions: ASTFunctionClass[] = [
    NoteNode, DashNode, BarNode, // 有实体
    DivNode, DotNode,   // 装饰性
    VoiceNode,  // 歌词
    LineNode, OverNode,   // 时间同步
    TieNode, BeamNode,
    BoxNode,
    SetNode, KeyNode, TempoNode,    // 设置
    TextNode,
];