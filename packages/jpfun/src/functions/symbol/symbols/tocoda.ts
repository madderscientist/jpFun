import type { SymbolDefinition } from "../index.js";
import { CODA_MARK } from "./coda.js";
import { JUMP_MARK } from "./dc.js";

export const tocodaSymbol: SymbolDefinition = {
    name: "tocoda",
    description: "跳至尾声：回跳之后经过这里就跳向最近的 $coda",
    weight: 1.4,
    text: { content: "To Coda", fontFamily: '"Times New Roman", serif', fontStyle: "italic" },
    // 判据是后方回跳已经发生，不是“第二次经过”；否则写在 |: :| 里会被反复线提前触发
    onVisit: (cursor, at) => {
        const jump = cursor.seek(JUMP_MARK, at, 1);
        const coda = cursor.seek(CODA_MARK, at, 1);
        return jump !== undefined && cursor.visits(jump) > 0 && coda !== undefined
            ? { kind: "jump", column: coda }
            : undefined;
    },
};
