import { test } from "node:test";

import { assert, commandsOfKind, nearly } from "./helpers.js";

test("tempo 忽略音符高度并与同轨文字对齐", () => {
    const commands = commandsOfKind(`@tempo(96) @text("96")`, "text");
    const tempo = commands.find(command => command.text === "= 96");
    const text = commands.find(command => command.text === "96");
    assert(tempo && text && nearly(tempo.y, text.y),
        "tempo equals text and following plain text must share one baseline");
});