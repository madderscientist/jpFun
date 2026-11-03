import assert from "node:assert/strict";
import { test } from "node:test";
import { compileScore, paintLayout, RecordingPainter } from "jpfun";
import { createPreviewNavigationMap, playbackRegionAt, previewHitAt, sourceTargetAt } from "../preview-navigation.ts";

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

test("点击谱面歌词或源码歌词精确定位到对应词元，而非整个 voice", () => {
    for (const [source, expectedTexts] of [
        [`N(主唱): 1 2 3 4\nL(领): {forever@@} friend`, ["{forever@@}", "friend"]],
        [`@voice({1 2 3 4}, 主唱, "{forever@@} friend", 领="la")`, ["{forever@@}", "friend", "la"]],
        [String.raw`N: 1 2` + "\n" + String.raw`L: "\u0061 b"`, [String.raw`\u0061`, "b"]],
        [String.raw`N: 1 2 3` + "\n" + String.raw`L: "\u0061 b \uZZZZ"`, [String.raw`\u0061`, "b", String.raw`\uZZZZ`]],
        [String.raw`N: 1 2` + "\n" + String.raw`L: "\U0061 b"`, [String.raw`\U0061`, "b"]],
    ]) {
        const compiled = compileScore(source);
        const navigation = createPreviewNavigationMap(compiled);
        const regions = compiled.layout.attachments[0].regions.slice(0, expectedTexts.length);
        assert.equal(regions.length, expectedTexts.length);

        for (let i = 0; i < regions.length; i++) {
            const region = regions[i];
            const hit = previewHitAt(navigation, region.x + region.w / 2, region.y + region.h / 2, 0);
            assert.ok(hit);
            assert.equal(source.slice(hit.target.span.start, hit.target.span.end), expectedTexts[i]);
            assert.deepEqual(hit.region, region);

            const fromSource = sourceTargetAt(navigation, hit.target.span.start);
            assert.ok(fromSource);
            assert.deepEqual(fromSource.regions, [region]);
        }
    }
});
