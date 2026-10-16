import assert from "node:assert/strict";
import { test } from "node:test";
import { compileScore, renderLayoutPagesToSvg } from "jpfun";
import { downloadBitmapPages, recordLayoutPages, recordedPageToSvg } from "../preview.ts";

function environment(context) {
    const pending = [];
    const events = [];
    const canvases = [];
    const drawing = new Proxy({}, { get: (_, method) => (...args) => events.push([method, ...args]) });
    context.mock.method(URL, "createObjectURL", () => "blob:test");
    context.mock.method(URL, "revokeObjectURL", () => {});
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    globalThis.window = { setTimeout: callback => callback() };
    globalThis.document = {
        createElement(tag) {
            if (tag === "a") return { click() { events.push(["download", this.download]); } };
            assert.equal(tag, "canvas");
            const canvas = {
                width: 0, height: 0,
                getContext: () => drawing,
                toBlob(callback, mime, quality) {
                    events.push(["encode", canvas.width, canvas.height, mime, quality]);
                    pending.push(callback);
                },
            };
            canvases.push(canvas);
            return canvas;
        },
    };
    context.after(() => { globalThis.document = previousDocument; globalThis.window = previousWindow; });
    return { pending, events, canvases };
}

const source = '@page(width=200px,height=100px,top=10px,bottom=20px,left=20px,right=20px,numbering="1/1") 1 @br() 2 @br() 3 @br() 4';

test("bitmap export downloads each completed page before encoding the next", async context => {
    const { pending, events, canvases } = environment(context);
    const layout = compileScore(source).layout;
    assert.ok(layout.pages.length > 1);
    let paints = 0;
    for (const node of layout.objects) {
        const paint = node.paint.bind(node);
        node.paint = painter => { paints++; paint(painter); };
    }
    const pages = recordLayoutPages(layout);
    const commands = pages.map(page => structuredClone(page.recording.commands));
    const operation = downloadBitmapPages(pages, "png", 192);
    assert.equal(paints, layout.objects.length);
    assert.equal(canvases.length, 1);
    assert.equal(pending.length, 1);
    assert.equal(events.filter(event => event[0] === "download").length, 0);
    for (let index = 0; index < layout.pages.length; index++) {
        assert.equal(pending.length, 1);
        pending.shift()(new Blob(["page"]));
        await Promise.resolve();
        assert.deepEqual(events.filter(event => event[0] === "download").at(-1), ["download", `score-${index + 1}.png`]);
        const sequence = events.filter(event => ["encode", "download"].includes(event[0])).map(event => event[0]);
        assert.deepEqual(sequence.slice(0, (index + 1) * 2), Array.from({ length: index + 1 }, () => ["encode", "download"]).flat());
    }
    await operation;
    assert.equal(canvases.length, 1);
    assert.equal(canvases[0].width, 1);
    assert.equal(canvases[0].height, 1);
    assert.equal(paints, layout.objects.length);
    assert.deepEqual(pages.map(page => page.recording.commands), commands);
    assert.ok(!events.some(event => event[0] === "fillRect"));
    assert.deepEqual(events.filter(event => event[0] === "translate"), layout.pages.map(page => ["translate", -page.bounds.x, -page.bounds.y]));
    assert.ok(events.filter(event => event[0] === "encode").every(event => event[1] === 400 && event[2] === 200 && event[3] === "image/png"));
});

test("JPEG encoding failure releases the canvas and stops later pages", async context => {
    const { pending, events, canvases } = environment(context);
    const pages = recordLayoutPages(compileScore(source).layout);
    const commands = pages.map(page => structuredClone(page.recording.commands));
    const operation = downloadBitmapPages(pages, "jpeg", 96);
    assert.ok(events.some(event => event[0] === "fillRect"));
    assert.deepEqual(events.find(event => event[0] === "encode").slice(3), ["image/jpeg", 0.95]);
    pending.shift()(null);
    await assert.rejects(operation);
    assert.equal(pending.length, 0);
    assert.ok(!events.some(event => event[0] === "download"));
    assert.equal(canvases[0].width, 1);
    assert.equal(canvases[0].height, 1);
    assert.deepEqual(pages.map(page => page.recording.commands), commands);
});

test("SVG export and print reuse the preview instructions without repainting the layout", () => {
    const layout = compileScore(source + ' @text(A) 1/ ^ $tr').layout;
    const transparent = renderLayoutPagesToSvg(layout);
    const white = renderLayoutPagesToSvg(layout, { background: "#ffffff" });
    const pages = recordLayoutPages(layout);
    for (const node of layout.objects) {
        node.paint = () => { throw new Error("Layout must not be painted again"); };
    }
    for (const attachment of layout.attachments) {
        attachment.paint = () => { throw new Error("Attachment must not be painted again"); };
    }
    assert.deepEqual(pages.map(page => recordedPageToSvg(page)), transparent);
    assert.deepEqual(pages.map(page => recordedPageToSvg(page, "#ffffff")), white);
    assert.deepEqual(pages.map(page => recordedPageToSvg(page)), transparent);
});
