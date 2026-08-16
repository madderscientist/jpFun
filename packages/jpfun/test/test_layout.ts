import { ASTBraceNode, ASTFunctionNode } from "../src/functions/ASTtypes.js";
import { DIV_ADDON_KEY, DivNode, divLinePortName } from "../src/functions/div/index.js";
import { defaultFunctions } from "../src/functions/default.js";
import { createLayoutPrepareContext } from "../src/layout/default.js";
import { layoutDocument, paintLayout } from "../src/layout/engine.js";
import { DEFAULT_PAGE_CONFIG, normalizePageConfig } from "../src/layout/page.js";
import { RecordingPainter } from "../src/render/recording.js";
import { LoweringContext } from "../src/lowering/loweringContext.js";
import { ColType, isVisualTemporalNode } from "../src/lowering/types.js";
import type { LayoutAttachment, LayoutBox } from "../src/layout/types.js";
import { ParserContext } from "../src/parser/parserContext.js";
import { ErrorDiagnostic } from "../src/diagnostic.js";
import { preprocessSource } from "../src/parser/preprocess.js";
import { compileScore } from "../src/pipeline.js";

function assert(condition: unknown, message: string): asserts condition {
    if (condition) return;
    throw new Error(message);
}

function attachmentCommands(attachment: LayoutAttachment) {
    const recording = new RecordingPainter();
    attachment.paint(recording);
    return recording.commands;
}

function createParser(source: string) {
    const parser = new ParserContext({ source });
    parser.registerFunctions(defaultFunctions);
    return parser;
}

function parse(source: string) {
    const { maskedSource } = preprocessSource(source);
    const nodes = createParser(maskedSource).parse();
    return new ASTBraceNode({ start: 0, end: source.length }, nodes);
}

function createLowering() {
    const lowering = new LoweringContext();
    lowering.registerFunctions(defaultFunctions);
    return lowering;
}

function lower(source: string) {
    return createLowering().lowerDocument(parse(source));
}

function expectDiagnostic(run: () => unknown, code: string) {
    try {
        run();
    } catch (error) {
        assert(error instanceof ErrorDiagnostic, `Expected ${code} to throw ErrorDiagnostic`);
        assert(error.code === code, `Expected ${code}, got ${error.code}`);
        return error;
    }
    throw new Error(`Expected ${code}`);
}

function assertLoweringError(source: string, code: string) {
    expectDiagnostic(() => lower(source), code);
}

function testContentRecovery(strict: boolean) {
    const source = "@tie()";
    const parser = createParser(source);
    parser.strict = strict;
    if (strict) {
        expectDiagnostic(() => parser.parseArgWithType(0, source.length, "content"), "E_NOT_ENOUGH_ARGS");
        assert(parser.diagnostics.length === 0, "strict content parsing must not record a recovered diagnostic");
        return;
    }

    assert(parser.parseArgWithType(0, source.length, "content") === null,
        "non-strict content parsing must recover with null");
    assert(parser.diagnostics.some(item => item.code === "E_NOT_ENOUGH_ARGS"),
        "non-strict content parsing must record the swallowed error");
    assert(parser.diagnostics.some(item => item.code === "W_INVALID_CONTENT"),
        "non-strict content parsing must report its fallback");
}

function compileDiagnostic(source: string, code: string) {
    return expectDiagnostic(() => compileScore(source), code);
}

function layoutDiagnostic(source: string, code: string) {
    const result = lower(source);
    return expectDiagnostic(() => layoutDocument(result, context), code);
}

const source = `1 #2'./ | - @text("进入")`;
const lowered = lower(source);
const context = createLayoutPrepareContext(defaultFunctions);
assert(context.decorationHandlers.has(DIV_ADDON_KEY), "div layout must derive its handler key from the primary function name");
expectDiagnostic(() => createParser("@tie()").parse(), "E_NOT_ENOUGH_ARGS");
testContentRecovery(false);
testContentRecovery(true);

{
    const noExpansion = lower("1");
    const host = noExpansion.columns[0]?.find(isVisualTemporalNode);
    assert(host, "the contained occupancy test requires one visual host");
    let layoutCalls = 0;
    noExpansion.attachments.push({
        box: { x: 0, y: 0, w: 0, h: 0 },
        layer: "foreground",
        layout(layoutContext) {
            layoutCalls++;
            const axis = layoutContext.getVisualAxis(0, host.track);
            const extent = layoutContext.getHostExtent(0, host.track);
            assert(extent, "the contained occupancy test requires a host extent");
            return [{
                x: 10,
                y: axis + extent.top,
                w: 30,
                h: extent.bottom - extent.top,
                line: 0,
                track: host.track,
            }];
        },
        paint() {},
    });
    const noExpansionResult = layoutDocument(noExpansion, context);
    assert(layoutCalls === 1, "contained track occupancy must not trigger a redundant relayout");
    assert(noExpansionResult.attachments[0].box.h === host.box.h,
        "a single-pass attachment must retain its measured bounds");
}

{
    const withOccupancy = lower("1");
    const host = withOccupancy.columns.flat().find(isVisualTemporalNode);
    assert(host, "the occupancy test requires one visual host");
    let layoutCalls = 0;
    withOccupancy.attachments.push({
        box: { x: 0, y: 0, w: 0, h: 0 },
        layer: "foreground",
        layout(layoutContext) {
            layoutCalls++;
            const axis = layoutContext.getVisualAxis(0, host.track);
            return [{ x: 10, y: axis - 100, w: 30, h: 10, line: 0, track: host.track }];
        },
        paint() {},
    });
    const withOccupancyResult = layoutDocument(withOccupancy, context);
    const finalAxis = host.box.y + host.box.visualAxis;
    assert(layoutCalls === 2, "an attachment with track occupancy must be re-laid out on final axes");
    assert(Math.abs(withOccupancyResult.attachments[0].box.y - (finalAxis - 100)) < 1e-6,
        "a re-laid attachment must expose bounds from its final geometry");
}

const result = layoutDocument(lowered, context, {
    rowGap: 12,
});

assert(result.objects.length === 5, `Expected 5 visible objects, got ${result.objects.length}`);

let previousX = -Infinity;
for (const object of result.objects) {
    const values = [
        object.box.x,
        object.box.y,
        object.box.w,
        object.box.h,
        object.box.anchor,
        object.box.visualAxis,
    ];
    assert(values.every(Number.isFinite), "Every LayoutBox field must be finite");
    assert(object.box.w > 0, "Visible objects must have positive width");
    assert(object.box.h > 0, "Visible objects must have positive height");
    assert(object.box.anchor >= 0 && object.box.anchor <= object.box.w, "anchor must stay inside the box");
    assert(object.box.visualAxis >= 0 && object.box.visualAxis <= object.box.h, "visualAxis must stay inside the box");
    assert(object.box.x >= previousX, "Single-track objects must keep horizontal order");
    previousX = object.box.x;
}

const decoratedNote = result.objects[1];
assert(decoratedNote.decorations.length === 2, "dot and div must create two independent decorations");
assert(decoratedNote.box.w > decoratedNote.ast.size * 0.62, "dot must extend the note width");
assert(decoratedNote.box.h > decoratedNote.ast.size, "div or octave dots must extend the note height");

const outerDiv = lower(`@div(@dot(1, 1), 2)`).columns[0][0];
const outerDot = lower(`@dot(@div(1, 2), 1)`).columns[0][0];
for (const temporal of [outerDiv, outerDot]) {
    assert(temporal.T === 0.375, "dot and div nesting order must not change duration");
    assert(temporal.addon?.["@div"] === 2 && temporal.addon?.["@dot"] === 1,
        "dot and div nesting order must not change modifier addon counts");
}

const nestedDiv = lower(`@div(@div(1, 1), 2)`).columns[0][0];
assert(nestedDiv.T === 0.125 && nestedDiv.addon?.["@div"] === 3,
    "nested modifiers of the same kind must accumulate duration and addon counts");
const nestedDot = lower(`@dot(@dot(1, 1), 1)`).columns[0][0];
assert(nestedDot.T === 1.75 && nestedDot.addon?.["@dot"] === 2,
    "nested dots must use their combined count instead of multiplying independent factors");

const interleavedModifiers = lower(
    `@dot(@div(@dot(@div(A2, 1), 2), 3), 1)`,
).columns[0][0];
assert(interleavedModifiers.addon?.["@div"] === 4 && interleavedModifiers.addon?.["@dot"] === 3,
    "interleaved div and dot scopes must merge counts before applying them");
assert(interleavedModifiers.T === 15 / 128,
    "four divs and three dots must be applied from their merged counts");

const scopedDiv = lower(`@div({1 2}, 1)`);
assert(scopedDiv.columns[0][0].t === 0 && scopedDiv.columns[1][0].t === 0.5 && scopedDiv.duration === 1,
    "a modifier scope must update each event before advancing the time cursor");

const mixedHistoryDiv = lower(`@div({@up(@div(1,1),3) 2},1)`);
const mixedHistoryChord = mixedHistoryDiv.columns[0][0] as typeof upTemporal;
const mixedHistoryNote = mixedHistoryDiv.columns[1][0];
assert(mixedHistoryChord.T === 0.25 && mixedHistoryChord.members[0].addon?.["@div"] === 2,
    "an outer div must extend the count already applied inside up");
assert(mixedHistoryNote.t === 0.25 && mixedHistoryNote.T === 0.5
    && mixedHistoryNote.addon?.["@div"] === 1 && mixedHistoryDiv.duration === 0.75,
    "one group must keep independent modifier history for each event");

const optionFontSizeResult = compileScore(`1`, { fontSize: 18 });
assert(optionFontSizeResult.layout.objects[0].ast.size === 18, "compileScore fontSize must initialize the root parse scope");

const [smallDecoratedNote, smallBar] = compileScore(`1.// |`, { fontSize: 20 }).layout.objects;
const [largeDecoratedNote, largeBar] = compileScore(`2.// |`, { fontSize: 40 }).layout.objects;
assert(Math.abs(largeDecoratedNote.box.w - smallDecoratedNote.box.w * 2) < 1e-6, "dot width must scale with its host font size");
assert(Math.abs(largeDecoratedNote.box.h - smallDecoratedNote.box.h * 2) < 1e-6, "div height must scale with its host font size");
assert(Math.abs(largeBar.box.w - smallBar.box.w * 2) < 1e-6, "bar geometry must use its parse-time font size");
assert(Math.abs(largeBar.box.h - smallBar.box.h * 2) < 1e-6, "bar height must use its parse-time font size");

const barAlignmentSource = `1 | 2/ 3, |`;
const loweredBarAlignment = lower(barAlignmentSource);
const barAlignmentResult = layoutDocument(loweredBarAlignment, context);
const visualAxes = barAlignmentResult.objects.map(object => object.box.y + object.box.visualAxis);
assert(visualAxes.every(axis => Math.abs(axis - visualAxes[0]) < 1e-6), "bar and note-like objects must share one visual center axis");
const [noteBeforeBar, firstBar, noteAfterBar] = barAlignmentResult.objects;
assert(noteBeforeBar.springConfig.mu_R === 64, "the spring facing an anchor from the left must use 4x mu");
assert(firstBar.springConfig.mu_L === 64, "an anchor left spring must use 4x mu");
assert(firstBar.springConfig.mu_R === 64, "an anchor right spring must use 4x mu");
assert(noteAfterBar.springConfig.mu_L === 64, "the spring facing an anchor from the right must use 4x mu");
assert(noteBeforeBar.springConfig.mu_L === 16, "the side away from an anchor must keep its base mu");

console.log(`layout objects=${result.objects.length} width=${result.bounds.w.toFixed(2)} height=${result.bounds.h.toFixed(2)}`);

const loweredUp = lower(`@up(1, #3', @text("上层")) 4`);
const upTemporal = loweredUp.columns[0][0] as typeof loweredUp.columns[0][0] & {
    members: readonly typeof loweredUp.columns[0][0][];
};

assert(loweredUp.columns.length === 2, "up members must not create independent global columns");
assert(upTemporal.members.length === 3, "up must retain exactly one visible temporal per argument");
assert(upTemporal.T === 1, "up duration must come from its first member");
assert(loweredUp.columns[1][0].t === 1, "the event after up must start after the first member duration");
assert(
    upTemporal.members.every(member =>
        member.t === upTemporal.t
        && member.track === upTemporal.track
        && member.layoutLine === upTemporal.layoutLine
    ),
    "up members must share the outer temporal time position, track and layout line",
);

const loweredUpAnchor = lower(`@up(1, @bar()) 2`);
assert(
    loweredUpAnchor.columns[0][0].type === ColType.ANCHOR,
    "up must inherit the strongest column type from its members",
);
assertLoweringError(`@up({1 2}, 3)`, "E_UP_INVALID_CHILD");
assertLoweringError(`@up({@tempo(90) 1}, 3)`, "E_UP_INVALID_CHILD");

// 堆叠在一起的成员共享第一个成员的时值；零时长成员保持 0
function upMemberDurations(source: string) {
    const temporal = lower(source).columns[0][0] as typeof loweredUp.columns[0][0] & {
        members: readonly { T: number }[];
    };
    return { duration: temporal.T, members: temporal.members.map(member => member.T) };
}
const dottedChord = upMemberDurations(`@up(1., 3)`);
assert(dottedChord.duration === 1.5 && dottedChord.members.every(T => T === 1.5),
    "up members must adopt the first member duration");
const flattenedChord = upMemberDurations(`@up(1, 3.)`);
assert(flattenedChord.duration === 1 && flattenedChord.members.every(T => T === 1),
    "a longer later member must be pulled back to the first member duration");
const annotatedChord = upMemberDurations(`@up(1., @text("cresc."))`);
assert(annotatedChord.members[0] === 1.5 && annotatedChord.members[1] === 0,
    "a zero-duration up member must stay at zero");

function loweredModifiedChord(source: string) {
    const lowered = lower(source);
    const temporal = lowered.columns[0][0] as typeof upTemporal;
    return { temporal, lead: temporal.members[0] };
}

const dividedChord = loweredModifiedChord(`@div(@up(@div(1, 1), 3), 1)`);
assert(dividedChord.temporal.T === 0.25 && dividedChord.lead.addon?.["@div"] === 2,
    "modifiers inside and outside up must accumulate on its representative member");

// up 的成员不进入全局列，但必须由 up 自己完成堆叠定位并绘制
const chord = compileScore(`1 @up(3, 5) 2`).layout;
const chordTemporal = chord.objects[1] as typeof chord.objects[1] & {
    members: readonly { box: LayoutBox }[];
};
const [chordLow, chordHigh] = chordTemporal.members;
assert(chord.objects.length === 3, "up members must stay out of the global visible object list");
assert(
    Math.abs(chordLow.box.y + chordLow.box.visualAxis - chord.objects[0].box.y - chord.objects[0].box.visualAxis) < 1e-6,
    "the first up member must sit on the track baseline",
);
assert(chordHigh.box.y + chordHigh.box.h <= chordLow.box.y, "later up members must stack above the previous one");
assert(
    Math.abs(chordLow.box.x + chordLow.box.anchor - chordHigh.box.x - chordHigh.box.anchor) < 1e-6,
    "up members must share one horizontal anchor",
);
const chordRecording = new RecordingPainter();
paintLayout(chord, chordRecording);
assert(
    chordRecording.commands.filter(command => command.kind === "text").length === 4,
    "up must paint every stacked member",
);

// up 嵌套 up：大括号阻断 parse 期展平，内层整体被折叠成外层的一个成员
function chordTextPositions(source: string) {
    const recording = new RecordingPainter();
    paintLayout(compileScore(source).layout, recording);
    return recording.commands
        .filter(command => command.kind === "text")
        .map(command => `${command.text}@${command.y.toFixed(4)}`)
        .join(" ");
}
const nestedChord = compileScore(`@up({@up(1,3)}, 5)`).layout.objects[0] as typeof chord.objects[0] & {
    members: readonly { members?: readonly unknown[] }[];
};
assert(nestedChord.members.length === 2 && nestedChord.members[0].members?.length === 2,
    "a braced inner up must stay one member of the outer up");
assert(chordTextPositions(`@up({@up(1,3)}, 5)`) === chordTextPositions(`@up(1,3,5)`),
    "a nested up must render exactly like the flattened chord");
assert(chordTextPositions(`@up(@up(1,3), 5)`) === chordTextPositions(`1^3^5`),
    "an unbraced inner up must flatten just like the ^ sugar");

console.log(`up members=${upTemporal.members.length} duration=${upTemporal.T}`);

const relationSource = `
@box({1@a 2@b @tie(a,b)}, 2px, 1px)
@box({3/@c 4/@d @beam(c,d)}, 2px, 1px)
`;
const loweredRelations = lower(relationSource);
const relationResult = layoutDocument(loweredRelations, context);
const backgroundObjects = relationResult.attachments.filter(item => item.layer === "background");
const foregroundObjects = relationResult.attachments.filter(item => item.layer === "foreground");

assert(backgroundObjects.length === 2, "each box must create one background attachment");
assert(foregroundObjects.length === 2, "tie and beam must create two foreground attachments");

const tie = foregroundObjects[0];
const beam = foregroundObjects[1];
const firstNote = relationResult.objects[0];
const firstBeamNote = relationResult.objects[2];

assert(tie.box.y < firstNote.box.y, "tie must reserve space above its endpoint notes");
assert(firstNote.box.y > 0, "the track visual axis must move down to include the tie");
assert(beam.box.y >= firstBeamNote.box.y + firstBeamNote.box.visualAxis, "beam must stay below note visual axes");

const tieBox = backgroundObjects[0].box;
assert(tieBox.x < tie.box.x, "box padding must extend left of the enclosed tie");
assert(tieBox.y < tie.box.y, "box padding must extend above the enclosed tie");
assert(tieBox.x + tieBox.w > tie.box.x + tie.box.w, "box must include the full tie width");
assert(tieBox.y + tieBox.h > firstNote.box.y + firstNote.box.h, "box must include its notes and padding");

console.log(`relations attachments=${relationResult.attachments.length} tieTop=${tie.box.y.toFixed(2)} visualAxis=${(firstNote.box.y + firstNote.box.visualAxis).toFixed(2)}`);

const adaptiveBox = compileScore(`@box({1 2 3},padding=0px,stroke=0px)`).layout.attachments[0];
const fixedBoxResult = compileScore(`@box({1 2 3},padding=0px,stroke=0px,width=120px) 4`).layout;
const fixedBox = fixedBoxResult.attachments[0];
assert(adaptiveBox.box.w < 120, "negative default box width must preserve natural global layout");
assert(Math.abs(fixedBox.box.w - 120) < 1e-6, "positive box width must constrain its complete member span");
const fixedBoxMembers = fixedBoxResult.objects.slice(0, 3);
assert(Math.abs(fixedBoxMembers[0].box.x - fixedBox.box.x) < 1e-6, "fixed box content must touch its left wall");
assert(Math.abs(fixedBoxMembers[2].box.x + fixedBoxMembers[2].box.w - fixedBox.box.x - fixedBox.box.w) < 1e-6,
    "fixed box content must touch its right wall");
const fixedGap1 = fixedBoxMembers[1].box.x + fixedBoxMembers[1].box.anchor
    - fixedBoxMembers[0].box.x - fixedBoxMembers[0].box.anchor;
const fixedGap2 = fixedBoxMembers[2].box.x + fixedBoxMembers[2].box.anchor
    - fixedBoxMembers[1].box.x - fixedBoxMembers[1].box.anchor;
assert(Math.abs(fixedGap1 - fixedGap2) < 1e-6, "fixed box must distribute spare width evenly");
assert(fixedBoxResult.objects[3].box.x > fixedBox.box.x + fixedBox.box.w, "objects after a fixed box must remain in the global flow");

const alignedFixedBox = compileScore(`@stack({@box({1 2 3},padding=0px,stroke=0px,width=120px)}, {4 5 6})`).layout;
for (let i = 0; i < 3; i++) {
    const upper = alignedFixedBox.objects[i * 2];
    const lower = alignedFixedBox.objects[i * 2 + 1];
    assert(
        Math.abs(upper.box.x + upper.box.anchor - lower.box.x - lower.box.anchor) < 1e-6,
        "a fixed box must move every track that shares its global time columns",
    );
}

const nestedFixedBoxes = compileScore(
    `@box({1 @box({2 3},padding=0px,stroke=0px,width=60px) 4},padding=0px,stroke=0px,width=140px)`,
).layout.attachments;
assert(Math.abs(nestedFixedBoxes[0].box.w - 60) < 1e-6, "the inner fixed box must keep its exact width");
assert(Math.abs(nestedFixedBoxes[1].box.w - 140) < 1e-6, "the outer fixed box must preserve the nested constraint");

const conflictingBoxSource = `@box(@box({1 2},padding=0px,stroke=0px,width=60px),padding=0px,stroke=0px,width=80px)`;
const conflictingBoxDiagnostic = layoutDiagnostic(conflictingBoxSource, "E_BOX_CONSTRAINT_CONFLICT");
assert(conflictingBoxSource.slice(conflictingBoxDiagnostic.span.start, conflictingBoxDiagnostic.span.end) === conflictingBoxSource,
    "a conflicting box diagnostic must point to the box that owns the rejected width");

const crossingBoxSource = `@stack({@box({1 2 3},width=80px)}, {4 @box({5 6 7},width=80px)})`;
const crossingBoxDiagnostic = layoutDiagnostic(crossingBoxSource, "E_BOX_CONSTRAINT_CROSSING");
assert(crossingBoxSource.slice(crossingBoxDiagnostic.span.start, crossingBoxDiagnostic.span.end).startsWith("@box"),
    "a crossing box diagnostic must point to the box that introduces the crossing constraint");

const narrowBoxSource = `@box({1 2},width=1px)`;
const narrowBoxDiagnostic = layoutDiagnostic(narrowBoxSource, "E_BOX_WIDTH_TOO_SMALL");
assert(narrowBoxSource.slice(narrowBoxDiagnostic.span.start, narrowBoxDiagnostic.span.end) === narrowBoxSource,
    "a narrow box diagnostic must point to its declaration");

const voiceSource = `@voice({1 2 3}, 主, 男="你 好 啊", 女="我 也 是")`;
const loweredVoice = lower(voiceSource);
const voiceResult = layoutDocument(loweredVoice, context);

assert(voiceResult.objects.length === 4, "voice name and three notes must create four visible objects");
assert(voiceResult.objects[0].T === 0, "voice name must not advance musical time");
assert(voiceResult.attachments.length === 1, "all lyric rows must belong to one voice attachment");

const lyrics = voiceResult.attachments[0];
const lastVoiceNote = voiceResult.objects[3];
assert(lyrics.box.y > lastVoiceNote.box.y, "lyrics must be placed below the note row");
assert(lyrics.box.h > voiceResult.objects[0].ast.size * 1.5, "two lyric rows must reserve more than one text line");
assert(voiceResult.bounds.y + voiceResult.bounds.h >= lyrics.box.y + lyrics.box.h, "document bounds must include all lyrics");

console.log(`voice objects=${voiceResult.objects.length} lyricHeight=${lyrics.box.h.toFixed(2)} totalHeight=${voiceResult.bounds.h.toFixed(2)}`);

const breakSource = `1 2 @br() 3 4`;
const loweredBreak = lower(breakSource);
const loweredBreakLines = loweredBreak.columns
    .flat()
    .filter(isVisualTemporalNode)
    .map(node => node.layoutLine);
const loweredBreakControl = loweredBreak.columns
    .flat()
    .find(node => !isVisualTemporalNode(node));
assert(
    loweredBreakLines.join(",") === "0,0,1,1",
    "lowering must solidify visible event line numbers before layout",
);
assert(loweredBreakControl?.layoutLine === 1, "br must receive the new line number of its own merged column");
const breakResult = layoutDocument(loweredBreak, context);

assert(breakResult.lineCount === 2, "br must split the document into two layout systems");
assert(breakResult.objects[0].layoutLine === 0 && breakResult.objects[1].layoutLine === 0, "objects before br must stay on line 0");
assert(breakResult.objects[2].layoutLine === 1 && breakResult.objects[3].layoutLine === 1, "objects after br must move to line 1");
assert(Math.abs(breakResult.objects[0].box.x - breakResult.objects[2].box.x) < 1e-6, "each system must restart horizontal layout at the same origin");
assert(breakResult.objects[2].box.y > breakResult.objects[0].box.y + breakResult.objects[0].box.h, "the second system must be below the first system");

console.log(`break lines=${breakResult.lineCount} firstY=${breakResult.objects[0].box.y.toFixed(2)} secondY=${breakResult.objects[2].box.y.toFixed(2)}`);

const offsetBreakResult = compileScore(`1 @br(2) 2`);
assert(offsetBreakResult.layout.lineCount === 3, "br(2) must preserve one empty intermediate line");
assert(offsetBreakResult.layout.objects[0].layoutLine === 0, "the event before br(2) must stay on line 0");
assert(offsetBreakResult.layout.objects[1].layoutLine === 2, "the event after br(2) must move to line 2");

const zeroBreakResult = compileScore(`1 @br(0) 2`);
assert(zeroBreakResult.parser.diagnostics.some(item => item.code === "W_BR_OFFSET"),
    "br(0) must report that its offset was corrected");
assert(zeroBreakResult.layout.lineCount === 2, "br(0) must be corrected to br(1)");
assert(zeroBreakResult.layout.objects[1].layoutLine === 1, "br(0) must move following events to the next line");

const defaultPageResult = compileScore("1");
assert(defaultPageResult.layout.pages.length === 1, "default infinite-height layout must create one page");
assert(defaultPageResult.layout.pages[0].bounds.w === 794, "default page width must use the A4 approximation");
assert(defaultPageResult.layout.pages[0].bounds.h < Infinity, "an infinite-height page must expose its natural finite height");

const partialPageConfig = normalizePageConfig({ width: 320, marginTop: -5 });
assert(partialPageConfig.width === 320, "page normalization must preserve provided values");
assert(partialPageConfig.marginTop === 0, "page normalization must clamp provided margins");
assert(partialPageConfig.marginBottom === DEFAULT_PAGE_CONFIG.marginBottom,
    "page normalization must fill omitted values from the default config");

const negativeHeightSource = `@page(height=-1px, gap=5px) 1 @br() 2`;
const negativeHeightDiagnostic = compileDiagnostic(negativeHeightSource, "E_INVALID_PAGE_CONFIG");
assert(negativeHeightSource.slice(negativeHeightDiagnostic.span.start, negativeHeightDiagnostic.span.end)
    === "@page(height=-1px, gap=5px)", "an invalid page diagnostic must point to the page declaration");

for (const source of [`@page(top=-1px) 1`, `@page(gap=-1px) 1`]) {
    compileDiagnostic(source, "E_INVALID_PAGE_CONFIG");
}

const nonPositiveHeightResult = compileScore(`@page(height=0px, gap=5px) 1 @br() 2`);
assert(nonPositiveHeightResult.lowering.page?.height === Infinity, "page height 0 must solidify as Infinity");
assert(nonPositiveHeightResult.layout.pages.length === 1, "an infinite-height page must never paginate");

const emPageResult = compileScore(`@set(fontsize=30) @page(gap=1em) 1`);
assert(emPageResult.lowering.page?.lineGap === 30, "page gap em must solidify using the parse-time font size");

const pagedResult = compileScore(`
@page(width=200px, height=80px, top=10px, bottom=10px, left=20px, right=20px, gap=5px)
1 @br() 2 @br() 3 @br() 4
`);
assert(pagedResult.layout.pages.length === 2, "four systems must split into two finite pages");
assert(pagedResult.layout.pages.every(page => page.lineEnd > page.lineStart), "every generated page must contain at least one system");
assert(pagedResult.layout.pages[0].lineStart === 0 && pagedResult.layout.pages[0].lineEnd === 2, "the first page must contain systems 0 and 1");
assert(pagedResult.layout.pages[1].lineStart === 2 && pagedResult.layout.pages[1].lineEnd === 4, "the second page must contain systems 2 and 3");
assert(pagedResult.layout.pages[0].bounds.h === 80 && pagedResult.layout.pages[1].bounds.y === 80, "finite pages must keep exact stacked paper bounds");
assert(pagedResult.layout.bounds.w === 200 && pagedResult.layout.bounds.h === 160, "document bounds must include both complete pages");

const [pageLine0, pageLine1, pageLine2, pageLine3] = pagedResult.layout.objects;
const fullPageGap = pageLine1.box.y - pageLine0.box.y - pageLine0.box.h;
const lastPageGap = pageLine3.box.y - pageLine2.box.y - pageLine2.box.h;
const expectedFullPageGap = 80 - 10 - 10 - pageLine0.box.h - pageLine1.box.h;
assert(Math.abs(fullPageGap - expectedFullPageGap) < 1e-6, "a closed full page must distribute all remaining height into its system gaps");
assert(Math.abs(lastPageGap - 5) < 1e-6, "the final page must retain the configured minimum system gap");

const duplicatePageResult = compileScore(`@page(width=200px) @page(width=-1px) 1`);
assert(duplicatePageResult.parser.diagnostics.some(item => item.code === "W_DUPLICATE_PAGE"), "a repeated page declaration must create a diagnostic");
assert(duplicatePageResult.layout.pages[0].bounds.w === 200, "the first page declaration must win");

const nestedPageResult = compileScore(`{@page(width=-1px) 1}`);
assert(nestedPageResult.parser.diagnostics.some(item => item.code === "W_PAGE_NOT_TOP_LEVEL"), "a nested page declaration must create a diagnostic");
assert(nestedPageResult.layout.pages[0].bounds.w === 794, "a nested page declaration must be ignored");

const pageOverflow = layoutDiagnostic(
    `@page(width=200px, height=40px, top=10px, bottom=10px, left=10px, right=10px) 1`,
    "E_PAGE_OVERFLOW",
);
assert(pageOverflow.span.start === pageOverflow.span.end - 1,
    "page overflow must point to the unplaceable score content");

compileDiagnostic(
    `@page(width=200px, height=20px, top=10px, bottom=10px) 1`,
    "E_INVALID_PAGE_CONFIG",
);

const crossPageTieResult = compileScore(`
@page(width=200px, height=80px, top=10px, bottom=10px, left=20px, right=20px, gap=5px)
1@a @br() 2 @br() 3 @br() 4@b @tie(a,b)
`);
const crossPageTieAttachment = crossPageTieResult.layout.attachments[0];
assert(crossPageTieResult.layout.pages.length > 1, "the cross-page tie sample must span multiple pages");
assert(crossPageTieResult.layout.pages.every(page => page.lineEnd > page.lineStart), "cross-page tie layout must not create empty pages");
assert(attachmentCommands(crossPageTieAttachment).filter(command => command.kind === "path").length === 4,
    "a cross-page tie must retain one segment per logical system");
assert(Object.values(crossPageTieAttachment.box).every(Number.isFinite), "cross-page tie geometry must stay finite");

const crossLineBoxSource = `@box({1 @br() 2}, 2px, 1px)`;
const crossLineBoxDiagnostic = layoutDiagnostic(crossLineBoxSource, "E_BOX_CROSS_LINE");
assert(crossLineBoxSource.slice(crossLineBoxDiagnostic.span.start, crossLineBoxDiagnostic.span.end) === crossLineBoxSource,
    "a cross-line box diagnostic must point to its declaration");

const separateLineBoxes = compileScore(`@box({1}) @br() @box({2})`).layout.attachments;
assert(
    separateLineBoxes[1].box.y >= separateLineBoxes[0].box.y + separateLineBoxes[0].box.h,
    "a later system box must not include empty attachment bounds from the document origin",
);

const parallelBreakSource = `@stack({1 @br() 2}, {3 @br() 4})`;
const loweredParallelBreak = lower(parallelBreakSource);
const parallelBreakResult = layoutDocument(loweredParallelBreak, context);
const parallelBreakColumns = loweredParallelBreak.columns.filter(column =>
    column.some(node => node.breakBefore > 0)
);
assert(parallelBreakColumns.length === 2, "each parallel br must remain an independent SINGLE column");
assert(parallelBreakResult.lineCount === 2, "simultaneous br controls on different tracks must break the score only once");
assert(parallelBreakResult.objects[2].layoutLine === 1 && parallelBreakResult.objects[3].layoutLine === 1, "both parallel tracks must continue on the same new line");

const repeatedBreakResult = compileScore(`1 @br() @br() 2`);
assert(repeatedBreakResult.layout.lineCount === 3, "two br controls on one track must accumulate into two line offsets");

const asymmetricBreakSource = `@stack({1 @br() 2}, {3 4})`;
const loweredAsymmetricBreak = lower(asymmetricBreakSource);
const simultaneousAfterBreak = loweredAsymmetricBreak.columns
    .flat()
    .filter(node => isVisualTemporalNode(node) && Math.abs(node.t - 1) < 1e-6);
assert(simultaneousAfterBreak.length === 2, "the asymmetric break sample must retain both simultaneous events");
assert(
    simultaneousAfterBreak.every(node => node.layoutLine === 1),
    "a pre-column line offset must move every event in the merged column to the next line",
);

const crossLineTieSource = `1@a @br() 2@b @tie(a,b)`;
const loweredCrossLineTie = lower(crossLineTieSource);
const crossLineTieResult = layoutDocument(loweredCrossLineTie, context);
const crossLineTie = crossLineTieResult.attachments[0];

assert(attachmentCommands(crossLineTie).filter(command => command.kind === "path").length === 2,
    "a two-system tie must render one segment in each system");
assert(crossLineTieResult.objects[0].box.y > 0, "the first tie segment must push its note row down");
const crossTrackTieResult = compileScore(`@stack({1@a}, {2@b}) @tie(a,b)`).layout;
assert(crossTrackTieResult.attachments.length === 1, "tie must allow endpoints on different tracks");
assert(crossTrackTieResult.attachments[0].box.h > 0, "a cross-track tie must produce visible geometry");

function horizontalBandBottom(attachment: LayoutAttachment, segment: number) {
    const paths = attachmentCommands(attachment).filter(command => command.kind === "path");
    const path = paths[segment];
    assert(path?.kind === "path", `Expected tie segment ${segment}`);
    return Math.max(...path.commands.flatMap(command => command.op === "L" ? [command.y] : []));
}

const tieIntoUp = compileScore(`1@x

@up(3,4) 5@y @tie(x,y)`).layout;
assert(horizontalBandBottom(tieIntoUp.attachments[0], 1) < tieIntoUp.objects[1].box.y,
    "a closing tie segment must stay above the highest host on its target track");

const tieOutOfUp = compileScore(`@up(3,4) 5@x @br() 1@y @tie(x,y)`).layout;
assert(horizontalBandBottom(tieOutOfUp.attachments[0], 0) < tieOutOfUp.objects[0].box.y,
    "an opening tie segment must stay above the highest host on its source track");

const compactCrossTrackTie = compileScore(`
@page(width=200px,height=150px,top=10px,bottom=10px,left=10px,right=10px)
@stack({1@a 2},{3 4@b}) @tie(a,b,height=60px)
`).layout;
const compactTieBox = compactCrossTrackTie.attachments[0].box;
assert(compactCrossTrackTie.pages.length === 1, "a cross-track tie must not duplicate its height across tracks");
assert(compactTieBox.y >= 10 - 1e-6 && compactTieBox.y + compactTieBox.h <= 140 + 1e-6,
    "a cross-track tie must stay inside the measured page content area");

const crossLineVoiceSource = `@voice({1 2 @br() 3 4}, , "一 二 三 四")`;
const loweredCrossLineVoice = lower(crossLineVoiceSource);
const crossLineVoiceResult = layoutDocument(loweredCrossLineVoice, context);
const crossLineLyrics = crossLineVoiceResult.attachments[0];
const lyricBaselines = new Set(attachmentCommands(crossLineLyrics)
    .filter(command => command.kind === "text")
    .map(command => command.y.toFixed(6)));

assert(lyricBaselines.size === 2, "voice lyrics must use one baseline in each system containing tokens");
assert(crossLineLyrics.box.y > crossLineVoiceResult.objects[0].box.y, "cross-line lyrics must remain below their first note row");
assert(crossLineLyrics.box.y + crossLineLyrics.box.h > crossLineVoiceResult.objects[3].box.y + crossLineVoiceResult.objects[3].box.h, "lyric bounds must include the final system tokens");

console.log(`cross-line tieSegments=2 lyricBaselines=${[...lyricBaselines].join(",")}`);

const autoBeamFlagAst = parse(`1/ @set(autobeam=false) 2/`);
const parsedDivs = autoBeamFlagAst.content.filter(node => node instanceof DivNode);
assert(parsedDivs.length === 2, "two divided notes must create two DivNode instances");
assert(parsedDivs[0].autoBeamEnabled, "autobeam must default to enabled during parsing");
assert(!parsedDivs[1].autoBeamEnabled, "set(autobeam=false) must be frozen on following div nodes");

const adjacentAutoBeamSource = `1/ 2// 3/`;
const loweredAdjacentAutoBeam = lower(adjacentAutoBeamSource);
const adjacentAutoBeamResult = layoutDocument(loweredAdjacentAutoBeam, context);
assert(adjacentAutoBeamResult.attachments.length === 1, "separate divided notes must auto-connect by default");
const [beamFirst, beamMiddle, beamLast] = adjacentAutoBeamResult.objects;
assert(beamFirst.springConfig.alpha_L === 6, "a beam must not shorten the outside left spring");
assert(Math.abs((beamFirst.springConfig.alpha_R as number) - 4.8) < 1e-6, "a beam must shorten its first inside spring to 80%");
assert(Math.abs((beamMiddle.springConfig.alpha_L as number) - 4.8) < 1e-6, "a middle beam element must shorten its left spring");
assert(Math.abs((beamMiddle.springConfig.alpha_R as number) - 4.8) < 1e-6, "a middle beam element must shorten its right spring");
assert(Math.abs((beamLast.springConfig.alpha_L as number) - 4.8) < 1e-6, "a beam must shorten its final inside spring");
assert(beamLast.springConfig.alpha_R === 6, "a beam must not shorten the outside right spring");
assert(Math.abs((beamMiddle.springConfig.beta_L as number) - 1 / 6) < 1e-6, "beam alpha changes must not implicitly recompute completed beta");

const visibleBarrierBeamResult = layoutDocument(
    lower(`1// @text("barrier") 2//`),
    context,
);
assert(visibleBarrierBeamResult.attachments.length === 0, "a visible zero-duration element must break automatic beam adjacency");

const autoBeamSource = `@div({1 2 -}, 2)`;
const loweredAutoBeam = lower(autoBeamSource);
const autoBeamResult = layoutDocument(loweredAutoBeam, context);

assert(autoBeamResult.attachments.length === 1, "one multi-object div scope must always create one beam");
assert(autoBeamResult.attachments[0].box.w > 0, "scope beam must connect at least two divided objects");
assert(attachmentCommands(autoBeamResult.attachments[0]).filter(command => command.kind === "line").length === 2,
    "two div levels must create two scope beam lines");

const disabledAutoBeamSource = `@set(autobeam=false) 1/ 2// 3/`;
const loweredDisabledAutoBeam = lower(disabledAutoBeamSource);
const disabledAutoBeamResult = layoutDocument(loweredDisabledAutoBeam, context);
assert(disabledAutoBeamResult.attachments.length === 0, "autobeam=false must keep separately written divs independent");
assert(
    disabledAutoBeamResult.objects.every(object => object.springConfig.alpha_L === 6 && object.springConfig.alpha_R === 6),
    "independent divs must keep their base spring lengths when autobeam is disabled",
);

const disabledScopeBeamSource = `@set(autobeam=false) @div({1 2}, 1)`;
const disabledScopeBeamResult = layoutDocument(
    lower(disabledScopeBeamSource),
    context,
);
assert(disabledScopeBeamResult.attachments.length === 1, "autobeam=false must not disable connections inside one div");
assert(Math.abs((disabledScopeBeamResult.objects[0].springConfig.alpha_R as number) - 4.8) < 1e-6, "one div scope must shorten its inside right spring");
assert(Math.abs((disabledScopeBeamResult.objects[1].springConfig.alpha_L as number) - 4.8) < 1e-6, "one div scope must shorten its inside left spring");

const beatGroupedSource = `1/ 2/ 3/ 4/`;
const beatGroupedResult = layoutDocument(lower(beatGroupedSource), context);
assert(beatGroupedResult.attachments.length === 2, "automatic beams must split at quarter-note beat boundaries");

const lineGroupedSource = `1/ 2// @br() 1/2/`;
const lineGroupedResult = layoutDocument(lower(lineGroupedSource), context);
assert(lineGroupedResult.attachments.length === 2, "a new layout line must reset the automatic beam beat phase");

const barGroupedSource = `1// 2// | 3// 4// 5// 6//`;
const barGroupedResult = layoutDocument(lower(barGroupedSource), context);
assert(
    barGroupedResult.attachments.length === 2,
    "bar lines must end the current beam and reset the following beat phase",
);

const parallelBeamSource = `@stack({1// 2//}, {3// 4//})`;
const parallelBeamResult = layoutDocument(lower(parallelBeamSource), context);
assert(parallelBeamResult.attachments.length === 2, "automatic beams must group parallel tracks independently");

const nestedScopeBeamSource = `@div({@div({1 2}, 1) 3}, 1)`;
const nestedScopeBeamResult = layoutDocument(
    lower(nestedScopeBeamSource),
    context,
);
assert(nestedScopeBeamResult.attachments.length === 1, "nested div scopes must share one non-overlapping beam attachment");

const explicitBeamSource = `@set(autobeam=false) 1/@a 2/@b @beam(a,b)`;
const loweredExplicitBeam = lower(explicitBeamSource);
const explicitBeamResult = layoutDocument(loweredExplicitBeam, context);
assert(explicitBeamResult.attachments.length === 1, "explicit beam must connect separate divs while autobeam is disabled");

assertLoweringError(
    `@set(autobeam=false) 1/@a 2/ 3/@b @beam(a,b)`,
    "E_NON_ADJACENT_BEAM",
);
assertLoweringError(
    `@set(autobeam=false) 1/@a @br() 2/@b @beam(a,b)`,
    "E_NON_ADJACENT_BEAM",
);
assertLoweringError(
    `@set(autobeam=false) @stack({1/@a}, {2/@b}) @beam(a,b)`,
    "E_NON_ADJACENT_BEAM",
);
assertLoweringError(
    `@set(autobeam=false) 1/@a 2/@b @beam(b,a)`,
    "E_NON_ADJACENT_BEAM",
);

const parallelExplicitBeamSource = `@set(autobeam=false) @stack({1/@a 2/@b @beam(a,b)}, {3})`;
const parallelExplicitBeamResult = layoutDocument(
    lower(parallelExplicitBeamSource),
    context,
);
assert(parallelExplicitBeamResult.attachments.length === 1, "events on another track must not break explicit beam adjacency");

// up 成员不进入全局列，对外由和弦代表，因此写在成员上的标签是合法的 beam 端点
for (const source of [
    `@set(autobeam=false) @up(1/@a, 3) 2/@b @beam(a,b)`,
    `@set(autobeam=false) @up(1, 3/@a) 2/@b @beam(a,b)`,
    `@set(autobeam=false) @up(@up(1/@a, 3), 5) 2/@b @beam(a,b)`,
]) {
    const result = layoutDocument(lower(source), context);
    assert(result.attachments.length === 1, `label on an up member must beam through its chord: ${source}`);
}
assertLoweringError(
    `@up({1/@a 2/@b}, 3)`,
    "E_UP_INVALID_CHILD",
);

console.log(`auto-beam adjacent=${adjacentAutoBeamResult.attachments.length} beats=${beatGroupedResult.attachments.length} disabled=${disabledAutoBeamResult.attachments.length} explicit=${explicitBeamResult.attachments.length}`);

const lowerOctaveBeamSource = `@div({1 2,}, 1)`;
const loweredLowerOctaveBeam = lower(lowerOctaveBeamSource);
const lowerOctaveBeamResult = layoutDocument(loweredLowerOctaveBeam, context);
const normalBeamPort = lowerOctaveBeamResult.objects[0].ports[divLinePortName(0, "left")];
const lowerOctaveBeamPort = lowerOctaveBeamResult.objects[1].ports[divLinePortName(0, "left")];
const normalBeamY = lowerOctaveBeamResult.objects[0].box.y + normalBeamPort.y;
const lowerOctaveBeamY = lowerOctaveBeamResult.objects[1].box.y + lowerOctaveBeamPort.y;

assert(Math.abs(normalBeamY - lowerOctaveBeamY) < 1e-6, "same-level div lines must stay horizontal across lower-octave notes");
assert(lowerOctaveBeamPort.y < lowerOctaveBeamResult.objects[1].box.h, "lower octave dots must reserve space after the div line");

const stackSource = `@stack({1 2}, {3 4})`;
const loweredStack = lower(stackSource);
const stackResult = layoutDocument(loweredStack, context, { rowGap: 12 });

assert(stackResult.objects.length === 4, "two stack branches with two notes must create four visible objects");
assert(stackResult.objects[0].track === loweredStack.rootTrack, "the first stack member must stay on the host track");
assert(stackResult.objects[0].track !== stackResult.objects[1].track, "later stack branches must use their own tracks");
assert(Math.abs(
    stackResult.objects[0].box.x + stackResult.objects[0].box.anchor
    - stackResult.objects[1].box.x - stackResult.objects[1].box.anchor
) < 1e-6, "simultaneous stack notes must share one horizontal anchor");
assert(stackResult.objects[1].box.y < stackResult.objects[0].box.y, "later stack branches must be placed above the host track");

// ---- 纵向音轨模型 ----
// axis 取事件的视觉轴；宿主轨的音符可以直接当作宿主基线的探针
const axisOf = (object: { box: { y: number; visualAxis: number } }) => object.box.y + object.box.visualAxis;
const nearly = (a: number, b: number) => Math.abs(a - b) < 1e-6;
/** 无名声部的名称占位盒只为括线预留横向空间，高度为 0；纵向断言只关心真正可见的对象 */
const drawn = (source: string) => compileScore(source).layout.objects.filter(object => object.box.h > 0);

// 两声部：首末基线的中点必须落在宿主轴上
const twoVoices = drawn(`1 @voices(@voice({2}), @voice({3})) 4`);
assert(nearly((axisOf(twoVoices[1]) + axisOf(twoVoices[2])) / 2, axisOf(twoVoices[0])),
    "a voices block must center the first and last voice baselines on the host axis");
assert(twoVoices[1].track !== twoVoices[0].track && twoVoices[2].track !== twoVoices[0].track,
    "no voice may reuse the host track");

// 三声部对称时中间声部恰好落在宿主轴上
const threeVoices = drawn(`1 @voices(@voice({2}), @voice({3}), @voice({4})) 5`);
assert(nearly((axisOf(threeVoices[1]) + axisOf(threeVoices[3])) / 2, axisOf(threeVoices[0])),
    "an odd voices block must still center on the first and last baselines");
assert(nearly(axisOf(threeVoices[2]), axisOf(threeVoices[0])),
    "a symmetric three-voice block must put the middle voice on the host axis");

// 嵌套 stack 只撑开相邻基线的间距，不移动 voices 的语义中心
const nestedVoices = drawn(`1 @voices(@voice({2}), @voice({@stack({3},{9})}), @voice({4})) 5`);
const [nestedHost, nestedFirst, nestedMiddle, nestedBranch, nestedLast] = nestedVoices;
assert(nearly((axisOf(nestedFirst) + axisOf(nestedLast)) / 2, axisOf(nestedHost)),
    "a nested stack must not move the semantic center of its voices block");
assert(axisOf(nestedBranch) < axisOf(nestedMiddle), "a stack nested in a voice must stay above that voice");
assert(axisOf(nestedMiddle) - axisOf(nestedFirst) > axisOf(nestedLast) - axisOf(nestedMiddle),
    "a nested stack must widen the gap towards the previous voice");

// 空声部保留一个默认高度的槽位并参与居中
const emptyVoice = compileScore(`1 @voices(@voice({}), @voice({3})) 4`);
const emptyVoiceDrawn = emptyVoice.layout.objects.filter(object => object.box.h > 0);
assert(axisOf(emptyVoiceDrawn[1]) > axisOf(emptyVoiceDrawn[0]),
    "an empty first voice must still occupy a slot and push the remaining voice below the host axis");

// 同一行内成员数不同的两个块各自围绕宿主居中，并使用不同的音轨
const mixedArity = drawn(
    `1 @voices(@voice({2}), @voice({3})) 4 @voices(@voice({5}), @voice({6}), @voice({7})) 8`,
);
assert(nearly((axisOf(mixedArity[1]) + axisOf(mixedArity[2])) / 2, axisOf(mixedArity[0]))
    && nearly((axisOf(mixedArity[4]) + axisOf(mixedArity[6])) / 2, axisOf(mixedArity[0])),
    "voices blocks with different arities must each center on the host axis");
assert(mixedArity[1].track !== mixedArity[4].track,
    "voices blocks with different arities must not share lanes");

// 成员数相同的两个块共用音轨，第一声部在整行只有一条基线
const sameArity = drawn(
    `1 @voices(@voice({2}), @voice({3})) 4 @voices(@voice({5}), @voice({6})) 7`,
);
assert(sameArity[1].track === sameArity[4].track && sameArity[2].track === sameArity[5].track,
    "voices blocks with the same arity must reuse the same lanes");
assert(nearly(axisOf(sameArity[1]), axisOf(sameArity[4])), "reused lanes must keep one baseline per line");

// 同一宿主上的多个 stack 共用分支音轨，伴奏基线不会上下抖动
const twoStacks = drawn(`@stack({1},{2}) 3 @stack({4},{5})`);
assert(twoStacks[1].track === twoStacks[4].track, "stacks on one host must reuse their branch lanes");
assert(nearly(axisOf(twoStacks[1]), axisOf(twoStacks[4])), "reused stack lanes must share one baseline");

// stack 与 voices 不能串轨：voices(A, stack(B,C)) 共 4 条语义轨（含无内容的宿主）
const mixedTopology = compileScore(`@voices(@voice({1}), @voice({@stack({2},{3})}))`);
const mixedTracks = new Set(
    mixedTopology.layout.objects.filter(object => object.box.h > 0).map(object => object.track),
);
assert(mixedTracks.size === 3 && !mixedTracks.has(mixedTopology.lowering.rootTrack),
    "voices(A, stack(B, C)) must create three content tracks plus an empty host track");

// 多声部括线画在声部名与音符之间，纵向跨足首末两个声部
const bracketed = compileScore(`@voices(@voice({1}, 上), @voice({2}, 中), @voice({3}, 下))`).layout;
const bracket = bracketed.attachments.find(item => item.layer === "background");
assert(bracket !== undefined && bracket.box.h > 0, "a multi-voice block must draw one bracket");
const bracketVoices = bracketed.objects.filter(object => object.T > 0);
assert(bracket.box.y < axisOf(bracketVoices[0]) && bracket.box.y + bracket.box.h > axisOf(bracketVoices[2]),
    "the bracket must span from the first voice to the last voice");
const bracketName = bracketed.objects.find(object => object.T === 0);
assert(bracketName !== undefined
    && bracket.box.x > bracketName.box.x + bracketName.box.anchor
    && bracket.box.x + bracket.box.w < bracketVoices[0].box.x,
    "the bracket must sit between the voice names and the notes");
assert(compileScore(`@voices(@voice({1}, 上))`).layout.attachments.every(item => item.box.h === 0),
    "a single-voice block must not draw a bracket");

// 关系语法糖只能吞并左侧那一个操作数，更早解析出的节点必须原样保留
const sugarKeepsLeft = compileScore(`1/ 2/ 3 4 | 5 & 6 1 2`).layout.objects;
assert(sugarKeepsLeft.length === 9, "the & sugar must keep every node parsed before its left operand");
assert(sugarKeepsLeft[5].track !== sugarKeepsLeft[6].track, "the & sugar must still create a branch lane");
const upSugarKeepsLeft = compileScore(`1/ 2/ 3 4 | 5 ^ 6 1 2`).layout.objects;
assert(upSugarKeepsLeft.length === 8, "the ^ sugar must keep every node parsed before its left operand");

// 换行会切开所有轨道，跨越换行点的持续事件必须报错
assertLoweringError(`@stack({1.},{2 @br() 3})`, "E_BREAK_INSIDE_EVENT");

console.log(`vertical hostAxis=${axisOf(twoVoices[0]).toFixed(2)} voices=${axisOf(twoVoices[1]).toFixed(2)}/${axisOf(twoVoices[2]).toFixed(2)}`);

const accidentalAnchorSource = `@stack({1}, {#1})`;
const loweredAccidentalAnchor = lower(accidentalAnchorSource);
const accidentalAnchorResult = layoutDocument(loweredAccidentalAnchor, context);
const plainNumber = accidentalAnchorResult.objects[0];
const accidentalNumber = accidentalAnchorResult.objects[1];
const plainAnchorX = plainNumber.box.x + plainNumber.box.anchor;
const accidentalAnchorX = accidentalNumber.box.x + accidentalNumber.box.anchor;
const plainRightExtent = plainNumber.box.w - plainNumber.box.anchor;
const accidentalRightExtent = accidentalNumber.box.w - accidentalNumber.box.anchor;
const plainCoreLeft = plainNumber.box.anchor - (plainNumber.ports["body.left"]?.x ?? 0);
const plainCoreRight = (plainNumber.ports["body.right"]?.x ?? plainNumber.box.w) - plainNumber.box.anchor;
const accidentalCoreLeft = accidentalNumber.box.anchor - (accidentalNumber.ports["body.left"]?.x ?? 0);
const accidentalCoreRight = (accidentalNumber.ports["body.right"]?.x ?? accidentalNumber.box.w) - accidentalNumber.box.anchor;

assert(Math.abs(plainAnchorX - accidentalAnchorX) < 1e-6, "accidentals must not move the aligned number center");
assert(Math.abs(plainRightExtent - accidentalRightExtent) < 1e-6, "accidentals must only extend the box to the left of the number anchor");
assert(accidentalNumber.box.w > plainNumber.box.w, "accidentals must be included in the complete LayoutBox width");
assert(Math.abs(plainCoreLeft - accidentalCoreLeft) < 1e-6, "accidentals must not change the core left extent");
assert(Math.abs(plainCoreRight - accidentalCoreRight) < 1e-6, "accidentals must not change the core right extent");

const stateSource = `@tempo(90) @1(D4) @set(note.color=#f00) 1`;
const loweredState = lower(stateSource);
const stateResult = layoutDocument(loweredState, context);
const invisibleStateEvents = loweredState.columns
    .flat()
    .filter(event => !isVisualTemporalNode(event));
const stateNote = stateResult.objects[0] as typeof stateResult.objects[number] & {
    activeBpm: number;
    resolvedMidi: number;
    ast: ASTFunctionNode & { color: string };
};

assert(stateResult.objects.length === 1, "key, tempo and set must not create visible score objects");
assert(stateNote.activeBpm === 90, "tempo must be frozen into following notes");
assert(stateNote.resolvedMidi === 62, "key D4 must resolve jianpu 1 to MIDI 62");
assert(stateNote.ast.color === "#f00", "set must solidify the note color during parsing");
assert(invisibleStateEvents.every(event => event.box === undefined), "invisible state events must not allocate LayoutBox");
assert(invisibleStateEvents.every(event => event.springConfig === undefined), "invisible state events must not allocate HorizontalSpringConfig");
assert(invisibleStateEvents.every(event => event.ports === undefined), "invisible state events must not allocate layout ports");
assert(invisibleStateEvents.every(event => event.decorations === undefined), "invisible state events must not allocate decorations");
assert(invisibleStateEvents.every(event => event.addon === undefined), "undecorated state events must not allocate addon");

console.log(`stack tracks=${new Set(stackResult.objects.map(item => item.track)).size} bpm=${stateNote.activeBpm} midi=${stateNote.resolvedMidi}`);

const threeLineTieSource = `1@a @br() 2 @br() 3@b @tie(a,b)`;
const loweredThreeLineTie = lower(threeLineTieSource);
const threeLineTieResult = layoutDocument(loweredThreeLineTie, context);
const threeLineTieSegments = attachmentCommands(threeLineTieResult.attachments[0])
    .filter(command => command.kind === "path").length;
assert(threeLineTieSegments === 3, "a three-system tie must create first, middle and final segments");

const emptyMiddleTieSource = `1@a @br(2) 2@b @tie(a,b)`;
const emptyMiddleTieResult = layoutDocument(
    lower(emptyMiddleTieSource),
    context,
);
assert(emptyMiddleTieResult.lineCount === 3, "a tie spanning br(2) must preserve its empty middle system");
assert(attachmentCommands(emptyMiddleTieResult.attachments[0]).filter(command => command.kind === "path").length === 3,
    "an attachment must render a segment on an otherwise empty system");

function layoutGrace(source: string) {
    const result = layoutDocument(lower(source), context);
    const painter = new RecordingPainter();
    paintLayout(result, painter);
    return { result, commands: painter.commands };
}

const plainNote = layoutGrace(`1`).result.objects[0];
const preGrace = layoutGrace(`2>1`);
const preGraceNode = preGrace.result.objects[0] as typeof preGrace.result.objects[number] & {
    host: { box: LayoutBox };
    graces: readonly { T: number }[];
    stealTime: number;
};

assert(preGrace.result.objects.length === 1, "a grace note must fold into a single visible object");
assert(preGraceNode.T === plainNote.T, "the composite must keep the host duration");
assert(preGraceNode.box.w > plainNote.box.w, "a grace note must reserve intrinsic horizontal space");
assert(preGraceNode.box.anchor > plainNote.box.anchor, "a pre-grace must push the host anchor to the right");
assert(Math.abs(preGraceNode.ports["lyric"].x - preGraceNode.box.anchor) < 1e-6,
    "the composite must forward the host lyric anchor instead of the grace one");

const graceTexts = preGrace.commands.filter(command => command.kind === "text");
assert(graceTexts.length === 2, "a grace composite must draw both the grace and the host");
const [hostText, graceText] = graceTexts[0].style.fontSize > graceTexts[1].style.fontSize
    ? [graceTexts[0], graceTexts[1]]
    : [graceTexts[1], graceTexts[0]];
assert(Math.abs(graceText.style.fontSize / hostText.style.fontSize - 0.7) < 1e-6,
    "a grace note must be exactly one scale step smaller than its host");
assert(graceText.y < hostText.y, "a grace note must sit above the host baseline");
assert(graceText.x < hostText.x, "a pre-grace must sit left of the host");

// 倚音默认就是八分音符，因此裸写也会有一条减时线；再写一个 '/' 变成十六分
assert(preGrace.commands.filter(command => command.kind === "line").length === 1,
    "a bare grace note must render its default eighth-note beam line");
assert(layoutGrace(`2/>1`).commands.filter(command => command.kind === "line").length === 2,
    "an explicit div inside the grace must add a second line");
assert(preGraceNode.graces[0].T === 0.5, "the grace member must keep its written duration for playback");
assert(Math.abs(preGraceNode.stealTime - 0.5) < 1e-6, "a bare grace steals half of the host duration");
assert(Math.abs((layoutGrace(`2/>1`).result.objects[0] as typeof preGraceNode).stealTime - 0.25) < 1e-6,
    "a sixteenth grace steals a quarter of the host duration");

// 宿主的修饰在 lowering 中被提升到复合体，loweringFinalize 必须还给宿主
const hostDiv = layoutGrace(`2>1/`);
const hostDivNode = hostDiv.result.objects[0];
const hostAnchorX = hostDivNode.box.x + hostDivNode.box.anchor;
const hostDivLine = hostDiv.commands
    .filter(command => command.kind === "line")
    .sort((a, b) => (b.x2 - b.x1) - (a.x2 - a.x1))[0];
assert(hostDivNode.ports[divLinePortName(0, "left")] !== undefined,
    "the composite must expose the host div ports so beam and tie keep working");
assert(hostDivLine.x1 < hostAnchorX && hostDivLine.x2 > hostAnchorX,
    "the host div line must be centred on the host anchor, not on the whole composite");
assert(hostDivLine.x1 > hostDivNode.box.x,
    "the host div line must stay under the host digit instead of spanning the composite");

// 折叠成员不进入全局时间列，自动连梁看不到它们，必须由复合体自己连成整线
const twoGraces = layoutGrace(`{3 2}>1`);
const twoGraceLines = twoGraces.commands.filter(command => command.kind === "line");
assert(twoGraceLines.length === 1, "consecutive grace notes must share one merged beam line");
assert(twoGraceLines[0].x2 - twoGraceLines[0].x1 > preGrace.commands
    .filter(command => command.kind === "line")[0].x2 - preGrace.commands
    .filter(command => command.kind === "line")[0].x1,
    "the merged line must span both grace notes");

// 倚音之间按视觉轴对齐：低八度点只向下悬挂，不能把旁边的数字顶高
const unevenGraces = layoutGrace(`{3,, 4}>4`);
const unevenTexts = unevenGraces.commands
    .filter(command => command.kind === "text")
    .filter(command => command.style.fontSize < 22);
assert(unevenTexts.length === 2 && Math.abs(unevenTexts[0].y - unevenTexts[1].y) < 1e-6,
    "grace notes must align on their visual axis even when one carries octave dots");
assert(unevenGraces.commands.filter(command => command.kind === "line").length === 1,
    "octave dots must not break the merged grace beam line");

const postGrace = layoutGrace(`1<2`);
const postGraceNode = postGrace.result.objects[0];
assert(Math.abs(postGraceNode.box.anchor - plainNote.box.anchor) < 1e-6,
    "a post-grace must leave the host anchor untouched");
const postTexts = postGrace.commands.filter(command => command.kind === "text");
assert(postTexts[1].x > postTexts[0].x, "a post-grace must sit right of the host");

// 两侧都有倡音时，外层要贴内层的肩线而不是内层盒顶，否则会层层叠高
const bothSides = layoutGrace(`6>4<3`);
assert(Math.abs(bothSides.result.objects[0].box.h - postGraceNode.box.h) < 1e-6,
    "a host carrying graces on both sides must not grow taller than a single-sided one");
const bothGraceTexts = bothSides.commands
    .filter(command => command.kind === "text")
    .filter(command => command.style.fontSize < 22);
assert(bothGraceTexts.length === 2 && Math.abs(bothGraceTexts[0].y - bothGraceTexts[1].y) < 1e-6,
    "the pre-grace and the post-grace of one note must share the same shoulder line");

// 嵌套：1 是 2 的倚音，2 是 3 的倚音，字号逐层缩小
const nestedGrace = layoutGrace(`1>2>3`);
const nestedSizes = nestedGrace.commands
    .filter(command => command.kind === "text")
    .map(command => command.style.fontSize)
    .sort((a, b) => b - a);
assert(nestedSizes.length === 3, "nested grace notes must all be rendered");
assert(Math.abs(nestedSizes[1] / nestedSizes[0] - 0.7) < 1e-6
    && Math.abs(nestedSizes[2] / nestedSizes[1] - 0.7) < 1e-6,
    "nesting must scale the font size once per level");

// 写在成员上的标签由 foldedInto 上溯到复合体，因此仍是合法的关系端点
const graceTie = layoutGrace(`2>1@a 3@b @tie(a,b)`);
assert(graceTie.result.attachments.length === 1
    && attachmentCommands(graceTie.result.attachments[0]).some(command => command.kind === "path"),
    "a label written inside a grace composite must still work as a tie endpoint");

assertLoweringError(`3>{1 2}`, "E_GRACE_INVALID_HOST");

console.log(`grace w=${preGraceNode.box.w.toFixed(2)} anchor=${preGraceNode.box.anchor.toFixed(2)}`
    + ` steal=${preGraceNode.stealTime} nested=${nestedSizes.map(size => size.toFixed(1)).join("/")}`);

const emptyBoxSource = `@box({})`;
const loweredEmptyBox = lower(emptyBoxSource);
const emptyBoxResult = layoutDocument(loweredEmptyBox, context);
assert(emptyBoxResult.objects.length === 0, "empty box must not create a fake temporal object");
assert(Object.values(emptyBoxResult.bounds).every(Number.isFinite), "empty box bounds must stay finite");

const repeatSource = `@div({1 2}, 1)`;
const repeatAst = parse(repeatSource);
for (let i = 0; i < 2; i++) {
    const repeatLowering = createLowering();
    const repeatResult = layoutDocument(repeatLowering.lowerDocument(repeatAst), context);
    assert(repeatResult.objects.length === 2, "repeated lowering must not retain temporal objects on AST nodes");
    assert(repeatResult.attachments.length === 1, "repeated lowering must create exactly one fresh auto beam");
}

console.log(`threeLineTieSegments=${threeLineTieSegments} emptyBox=${emptyBoxResult.bounds.w}`);