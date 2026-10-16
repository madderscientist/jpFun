import assert from "node:assert/strict";
import { test } from "node:test";
import { createVirtualPages } from "../preview-pages.ts";

function environment(context) {
    class Element {
        style = {};
        children = [];
        append(child) { child.parent = this; this.children.push(child); }
        prepend(child) { child.parent = this; this.children.unshift(child); }
        replaceChildren(...children) { this.children = children; }
        remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    }
    class Canvas extends Element { width = 800; height = 1200; }
    const observers = [];
    const frames = new Map();
    let nextFrame = 0;
    class Observer {
        constructor(callback, options) { this.callback = callback; this.options = options; observers.push(this); }
        observe() {}
        disconnect() { this.disconnected = true; }
        notify(pages, indexes, isIntersecting) {
            this.callback(indexes.map(index => ({ target: pages[index], isIntersecting })));
        }
    }
    for (const [key, value] of Object.entries({
        document: { createElement: () => new Element() },
        window: {
            requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
            cancelAnimationFrame(id) { frames.delete(id); },
        },
        IntersectionObserver: Observer,
        HTMLCanvasElement: Canvas,
    })) {
        const previous = globalThis[key];
        globalThis[key] = value;
        context.after(() => { globalThis[key] = previous; });
    }
    const host = new Element();
    const scroll = new Element();
    const rendered = [];
    const errors = [];
    const virtual = createVirtualPages(host, scroll, {
        renderPage(index) { const surface = new Canvas(); rendered.push([index, surface]); return surface; },
        onError(error) { errors.push(error); },
    });
    const flush = () => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach(callback => callback());
    };
    const bounds = Array.from({ length: 100 }, (_, index) => ({ x: 0, y: index * 1200, w: 800, h: 1200 }));
    return { virtual, host, scroll, rendered, errors, flush, frames, observers, bounds };
}

test("only intersecting pages draw; scrolling releases old canvases without changing placeholders", context => {
    const { virtual, host, scroll, rendered, flush, observers, bounds } = environment(context);
    virtual.reset(bounds, 0.5);
    const pages = [...host.children];
    assert.equal(pages.length, 100);
    assert.equal(rendered.length, 0);
    assert.equal(pages[99].style.height, "600px");
    assert.equal(observers[0].options.root, scroll);
    observers[0].notify(pages, [0, 1], true);
    flush();
    assert.deepEqual(rendered.map(([index]) => index), [0, 1]);
    observers[0].notify(pages, [0, 1], false);
    observers[0].notify(pages, [98, 99], true);
    flush();
    assert.deepEqual(host.children, pages);
    assert.equal(pages[0].children.length, 1);
    assert.equal(rendered[0][1].width, 1);
    assert.equal(rendered[0][1].height, 1);
    assert.equal(pages[99].children.length, 2);
    observers[0].notify(pages, [98, 99], false);
    observers[0].notify(pages, [0], true);
    flush();
    assert.deepEqual(rendered.map(([index]) => index), [0, 1, 98, 99, 0]);
});

test("zoom resizes all placeholders and redraws only mounted canvases", context => {
    const { virtual, host, rendered, flush, observers, bounds } = environment(context);
    virtual.reset(bounds, 1);
    observers[0].notify(host.children, [20, 21], true);
    flush();
    virtual.resize(2, true);
    flush();
    assert.deepEqual(rendered.map(([index]) => index), [20, 21, 20, 21]);
    assert.equal(rendered[0][1].width, 1);
    assert.equal(host.children[99].style.width, "1600px");
    assert.equal(rendered[3][1].style.width, "1600px");
    virtual.resize(0.5);
    assert.equal(rendered.length, 4);
    assert.equal(rendered[3][1].style.width, "400px");
});

test("repeated zoom changes share one frame and draw only at the final size", context => {
    const { virtual, host, rendered, flush, frames, observers, bounds } = environment(context);
    virtual.reset(bounds, 1);
    observers[0].notify(host.children, [0], true);
    flush();
    virtual.resize(1.5, true);
    virtual.resize(2, true);
    virtual.resize(3, true);
    assert.equal(frames.size, 1);
    assert.equal(rendered.length, 1);
    flush();
    assert.equal(rendered.length, 2);
    assert.equal(rendered[1][1].style.width, "2400px");
    assert.equal(host.children[99].style.height, "3600px");
    virtual.ensure(0);
    virtual.ensure(0);
    assert.equal(frames.size, 0);
});

test("navigation can mount distant pages; reset ignores stale observers and pending frames", context => {
    const { virtual, host, rendered, flush, observers, bounds } = environment(context);
    virtual.reset(bounds, 1);
    const oldPages = [...host.children];
    const surface = virtual.ensure(99);
    assert.equal(oldPages[99].children[0], surface);
    virtual.reset(bounds.slice(0, 2), 1);
    assert.equal(surface.width, 1);
    assert.equal(observers[0].disconnected, true);
    observers[0].notify(oldPages, [99], true);
    flush();
    assert.equal(rendered.length, 1);
    observers[1].notify(host.children, [0], true);
    flush();
    assert.deepEqual(rendered.map(([index]) => index), [99, 0]);
    virtual.clear();
    assert.equal(host.children.length, 0);
    assert.equal(rendered[1][1].width, 1);
});

test("backend changes redraw only visible pages and reuse their placeholders", context => {
    const { virtual, host, rendered, flush, observers, bounds } = environment(context);
    virtual.reset(bounds, 1);
    const pages = [...host.children];
    observers[0].notify(pages, [40, 41], true);
    flush();
    virtual.redraw();
    assert.equal(rendered[0][1].width, 1);
    flush();
    assert.deepEqual(rendered.map(([index]) => index), [40, 41, 40, 41]);
    assert.deepEqual(host.children, pages);
});

test("asynchronous drawing errors are reported", context => {
    const { host, scroll, errors, flush, observers, bounds } = environment(context);
    const failure = new Error("drawing failed");
    const virtual = createVirtualPages(host, scroll, {
        renderPage() { throw failure; },
        onError(error) { errors.push(error); },
    });
    virtual.reset(bounds, 1);
    observers[0].notify(host.children, [0], true);
    flush();
    assert.deepEqual(errors, [failure]);
});
