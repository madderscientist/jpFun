import assert from "node:assert/strict";
import { test } from "node:test";
import { compileScore, paintLayout, RecordingPainter } from "jpfun";
import { createPreviewNavigationMap, playbackRegionAt, previewHitAt } from "../preview-navigation.ts";

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

test("休止普通主体覆盖整条图形的命中和起播，隐藏边界不打断游标", () => {
    const source = "@meter(4,4) | @rest(3) |";
    const compiled = compileScore(source);
    assert.deepEqual(compiled.diagnostics, []);
    const rest = compiled.layout.objects.find(node => node.ast.callName === "rest");
    const navigation = createPreviewNavigationMap(compiled);
    for (const ratio of [0.1, 0.5, 0.9]) {
        const hit = previewHitAt(navigation, rest.box.x + rest.box.w * ratio, rest.box.y + rest.box.visualAxis, 0);
        assert.equal(hit.target.kind, "object");
        assert.deepEqual(hit.target.span, rest.ast.sourceSpan);
        assert.equal(hit.target.scoreTime, 0);
    }
    const region = playbackRegionAt(navigation, 1);
    assert.deepEqual(playbackRegionAt(navigation, 5), region);
    assert.deepEqual(playbackRegionAt(navigation, 9), region);
});
