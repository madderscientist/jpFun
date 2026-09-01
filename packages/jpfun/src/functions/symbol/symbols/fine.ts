import type { SymbolDefinition } from "../index.js";
import { JUMP_MARK } from "./dc.js";

export const fineSymbol: SymbolDefinition = {
    name: "fine",
    description: "终止记号：回跳之后经过这里就结束乐曲",
    // Times New Roman 的大写字母高 0.67em，放大到 0.7em 才与同字号数字齐平
    weight: 1.045,
    text: { content: "Fine.", fontFamily: '"Times New Roman", serif' },
    // 判据是回跳已经发生，不是“第二次经过”；否则写在 |: :| 里会被反复线提前触发
    onVisit: (cursor, at) => {
        const jump = cursor.seek(JUMP_MARK, at, 1);
        return jump !== undefined && cursor.visits(jump) > 0 ? { kind: "stop" } : undefined;
    },
};
