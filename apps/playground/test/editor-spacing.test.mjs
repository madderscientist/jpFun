import assert from "node:assert/strict";
import { test } from "node:test";
import { history, undo, redo } from "@codemirror/commands";
import { EditorSelection, EditorState, StateField } from "@codemirror/state";
import { insertFormattedNewline, jpFunLanguage } from "../jpfun-language.ts";
import { applySourceEdits } from "../editor.ts";

test("source edits form one isolated undo step and map multiple selections", () => {
    const editor = editorFor("1 3", [1, 3]);
    editor.dispatch(editor.state.update({ changes: { from: 3, insert: " 7" }, userEvent: "input.type" }));
    const original = editor.state.doc.toString();
    assert.equal(applySourceEdits(editor, original, [
        { span: { start: 0, end: 1 }, text: "C4" },
        { span: { start: 2, end: 3 }, text: "E4" },
        { span: { start: 4, end: 5 }, text: "B4" },
    ]), true);
    assert.equal(editor.state.doc.toString(), "C4 E4 B4");
    assert.deepEqual(editor.state.selection.ranges.map(range => range.head), [2, 5]);
    editor.dispatch(editor.state.update({ changes: { from: 8, insert: " " }, userEvent: "input.type" }));
    assert.equal(undo(editor), true);
    assert.equal(editor.state.doc.toString(), "C4 E4 B4");
    assert.equal(undo(editor), true);
    assert.equal(editor.state.doc.toString(), original);
    assert.equal(redo(editor), true);
    assert.equal(editor.state.doc.toString(), "C4 E4 B4");
});

test("source edits refuse stale documents, composition and empty changes", () => {
    const editor = editorFor("1");
    const edits = [{ span: { start: 0, end: 1 }, text: "#1" }];
    assert.equal(applySourceEdits(editor, "2", edits), false);
    editor.composing = true;
    assert.equal(applySourceEdits(editor, "1", edits), false);
    editor.composing = false;
    assert.equal(applySourceEdits(editor, "1", []), false);
    assert.equal(editor.state.doc.toString(), "1");
    assert.equal(undo(editor), false);
});

function editorFor(doc, positions = [doc.length]) {
    const editor = {
        state: EditorState.create({
            doc,
            selection: EditorSelection.create(positions.map(position => EditorSelection.cursor(position))),
            extensions: [jpFunLanguage, history(), EditorState.allowMultipleSelections.of(true)],
        }),
        dispatch(transaction) { editor.state = transaction.state; },
    };
    return editor;
}

test("Enter spaces score tokens and argument commas without splitting notes", () => {
    for (const [source, expected] of [
        ["6#3", "6 #3"],
        ["@tempo(120)", "@tempo(120)"],
        ["@up(1,3)", "@up(1, 3)"],
        ["@div(6#3,1)", "@div(6 #3, 1)"],
        ["@voice(1,,abc)", "@voice(1, , abc)"],
        ["@text(a,b)", "@text(a, b)"],
        ["@up(1,)", "@up(1,)"],
        ["1,,2", "1,, 2"],
        ["1/2", "1/ 2"],
        ["1^3", "1 ^ 3"],
        ["1/.2", "1/. 2"],
        ["6  #3", "6  #3"],
        ['"6#3"', '"6#3"'],
        ["% 6#3", "% 6#3"],
        ['@text("a,b",size=2em)', '@text("a,b", size=2em)'],
        ["@up(1,", "@up(1,"],
        ["", ""],
    ]) {
        const editor = editorFor(source);
        assert.equal(insertFormattedNewline(editor), true);
        assert.equal(editor.state.doc.toString(), expected + "\n", source);
        assert.equal(editor.state.selection.main.head, expected.length + 1, source);
        assert.equal(undo(editor), true);
        assert.equal(editor.state.doc.toString(), source);
    }
});

test("Enter preserves indentation and formats only the line just left", () => {
    const editor = editorFor("  6#3\n12", [5]);
    insertFormattedNewline(editor);
    assert.equal(editor.state.doc.toString(), "  6 #3\n  \n12");
    const middle = editorFor("6#312", [3]);
    insertFormattedNewline(middle);
    assert.equal(middle.state.doc.toString(), "6 #3\n12");
});

test("Enter handles multiple cursors in one transaction", () => {
    const editor = editorFor("6#3\n1,,2", [3, 8]);
    insertFormattedNewline(editor);
    assert.equal(editor.state.doc.toString(), "6 #3\n\n1,, 2\n");
    assert.equal(editor.state.selection.ranges.length, 2);
    assert.equal(undo(editor), true);
    assert.equal(editor.state.doc.toString(), "6#3\n1,,2");
});

test("Enter reuses the original transaction when no spacing is needed", () => {
    let updates = 0;
    const counter = StateField.define({
        create: () => 0,
        update: () => ++updates,
    });
    const state = EditorState.create({
        doc: "6 #3",
        selection: { anchor: 4 },
        extensions: [jpFunLanguage, counter],
    });
    insertFormattedNewline({
        state,
        dispatch(transaction) {
            assert.equal(transaction.state.doc.toString(), "6 #3\n");
            assert.equal(transaction.state.field(counter), 1);
        },
    });
    assert.equal(updates, 1);
});