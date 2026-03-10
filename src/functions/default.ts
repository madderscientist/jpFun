import { ASTFunctionClass } from "./types";
import { SetNode } from "./set";
import { DivNode } from "./div";
import { NoteNode } from "./note";
import { DotNode } from "./dot";
import { BarNode } from "./bar";
import { VoiceNode } from "./voice";

export const defaultFunctions: ASTFunctionClass[] = [
    SetNode,
    NoteNode,
    DivNode,
    DotNode,
    BarNode,
    VoiceNode,
];