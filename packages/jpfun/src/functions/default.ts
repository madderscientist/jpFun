import { ASTFunctionClass } from "./ASTtypes.js";
import { AdjustNode } from "./adjust/index.js";
import { BarNode } from "./bar/index.js";
import { BeamNode } from "./beam/index.js";
import { BoxNode } from "./box/index.js";
import { DashNode } from "./dash/index.js";
import { DivNode } from "./div/index.js";
import { DotNode } from "./dot/index.js";
import { DynNode } from "./dyn/index.js";
import { GraceNode } from "./grace/index.js";
import { HeadNode } from "./head/index.js";
import { KeyNode } from "./key/index.js";
import { MeterNode } from "./meter/index.js";
import { BrNode } from "./br/index.js";
import { NoteNode } from "./note/index.js";
import { UpNode, DownNode } from "./up/index.js";
import { PageNode } from "./page/index.js";
import { StackNode } from "./stack/index.js";
import { SymbolNode } from "./symbol/index.js";
import { SetNode } from "./set/index.js";
import { TempoNode } from "./tempo/index.js";
import { TextNode } from "./text/index.js";
import { VoltaNode } from "./volta/index.js";
import { TieNode } from "./tie/index.js";
import { TupletNode } from "./tuplet/index.js";
import { VoiceNode, VoicesNode } from "./voice/index.js";

export const defaultFunctions: ASTFunctionClass[] = [
    NoteNode, DashNode, BarNode, // 有实体
    DivNode, DotNode, TupletNode,   // 装饰性
    VoiceNode, VoicesNode,  // 歌词和声部
    BrNode,     // 排版
    PageNode, HeadNode,   // 文档页面与谱头
    StackNode,  // 时间同步
    UpNode, DownNode,
    GraceNode,  // 倚音
    TieNode, BeamNode, DynNode,
    BoxNode, VoltaNode,
    AdjustNode,   // 手工微调
    SetNode, KeyNode, MeterNode, TempoNode,    // 设置
    TextNode, SymbolNode,
];