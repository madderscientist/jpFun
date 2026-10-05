import assert from "node:assert/strict";
import { test } from "node:test";
import { compileScore, paintLayout, RecordingPainter } from "jpfun";
import { createPreviewNavigationMap, previewHitAt } from "../preview-navigation.ts";

test("上八度点迁入 decoration 后仍命中所属音符", () => {
    let count = 0;
    for (const source of ["1'''", "@up(1,3''')", "{2'''}>1"]) {
        const compiled = compileScore(source);
        assert.deepEqual(compiled.diagnostics, []);
        const painter = new RecordingPainter();
        paintLayout(compiled.layout, painter);
        const navigation = createPreviewNavigationMap(compiled);
        for (const command of painter.commands.filter(command => command.kind === "circle")) {
            const hit = previewHitAt(navigation, command.cx, command.cy, 0);
            assert.ok(hit);
            assert.equal(hit.target.kind, "object");
            assert.ok(source.slice(hit.target.span.start, hit.target.span.end).includes("'''"));
            count++;
        }
    }
    assert.equal(count, 9);
});
