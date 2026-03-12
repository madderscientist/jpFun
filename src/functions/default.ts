import { ASTFunctionClass } from "./types";
import { SetNode } from "./set";
import { DivNode } from "./div";
import { DashNode } from "./dash";
import { NoteNode } from "./note";
import { DotNode } from "./dot";
import { BarNode } from "./bar";
import { VoiceNode } from "./voice";
import { OverNode } from "./over";
import { LineNode } from "./line";
import { TieNode } from "./tie";

export const defaultFunctions: ASTFunctionClass[] = [
    SetNode,
    NoteNode,
    DashNode,
    DivNode,
    DotNode,
    BarNode,
    VoiceNode,
    OverNode,
    LineNode,
    TieNode,
];