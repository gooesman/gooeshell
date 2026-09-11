import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState, type Transaction } from '@codemirror/state';
import { history, isolateHistory, redo, undo } from '@codemirror/commands';
import { createEditorDocument } from '../src/renderer/editor-document';

function editor(text: string) {
  const document = createEditorDocument(text);
  let state = EditorState.create({ doc: text, extensions: [history(), document.extensions] });
  return {
    get state() { return state; },
    dispatch(transaction: Transaction) { state = transaction.state; },
    text: () => document.getText(state),
    replace(from: number, to: number, insert: string, isolated = true) {
      state = state.update({ changes: { from, to, insert }, userEvent: 'input.type', annotations: isolated ? isolateHistory.of('full') : undefined }).state;
    },
  };
}

test('editor round-trips original LF, CRLF, CR, mixed endings and trailing newlines', () => {
  for (const text of ['', '你好', 'a\nb\n', 'a\r\nb\r\n', 'a\rb\r', '\r\na\nb\rc\r\n', '\ufeff文本\r\n']) {
    assert.equal(editor(text).text(), text);
  }
});

test('editing preserves untouched separators and new lines use the predominant separator', () => {
  const fixture = editor('alpha\r\nbeta\ngamma\r\ndelta\r');
  fixture.replace(6, 10, 'BETA\nextra');
  assert.equal(fixture.text(), 'alpha\r\nBETA\r\nextra\ngamma\r\ndelta\r');
  assert.equal(undo(fixture), true);
  assert.equal(fixture.text(), 'alpha\r\nbeta\ngamma\r\ndelta\r');
  assert.equal(redo(fixture), true);
  assert.equal(fixture.text(), 'alpha\r\nBETA\r\nextra\ngamma\r\ndelta\r');
});

test('undo restores deleted mixed separators rather than normalizing the file', () => {
  const original = 'one\r\ntwo\nthree\rfour\r\nfive';
  const fixture = editor(original);
  fixture.replace(2, 17, 'replacement\n');
  const edited = fixture.text();
  assert.notEqual(edited, original);
  assert.equal(undo(fixture), true);
  assert.equal(fixture.text(), original);
  assert.equal(redo(fixture), true);
  assert.equal(fixture.text(), edited);
  assert.equal(undo(fixture), true);
  assert.equal(fixture.text(), original);
});

test('grouped undo and redo retain mixed line endings', () => {
  const original = 'a\r\nb\nc\rd';
  const fixture = editor(original);
  fixture.replace(1, 3, '', false);
  fixture.replace(1, 3, '', false);
  const edited = fixture.text();
  while (undo(fixture)) { /* Return through every grouped event. */ }
  assert.equal(fixture.text(), original);
  while (redo(fixture)) { /* Reapply every grouped event. */ }
  assert.equal(fixture.text(), edited);
});

test('multiple simultaneous replacements and undo preserve unrelated mixed lines', () => {
  const original = 'one\r\ntwo\nthree\rfour\r\n';
  const fixture = editor(original);
  fixture.dispatch(fixture.state.update({ changes: [
    { from: 0, to: 4, insert: 'ONE\n' },
    { from: 8, to: 14, insert: 'THREE\n' },
  ] }));
  const edited = fixture.text();
  assert.equal(edited, 'ONE\r\ntwo\nTHREE\r\nfour\r\n');
  assert.equal(undo(fixture), true);
  assert.equal(fixture.text(), original);
  assert.equal(redo(fixture), true);
  assert.equal(fixture.text(), edited);
});

test('successive insertions, deletions and replacements round-trip all undo checkpoints', () => {
  const fixture = editor('first\r\nsecond\nthird\rfourth\r\n最后一行\n');
  const checkpoints = [fixture.text()];
  let seed = 771;
  const random = (limit: number) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % limit;
  };
  for (let step = 0; step < 50; step++) {
    const from = random(fixture.state.doc.length + 1);
    const to = from + random(fixture.state.doc.length - from + 1);
    const insert = ['insert\n', '\n\n', '中文', 'a\nb\nc'][random(4)];
    fixture.replace(from, to, insert);
    checkpoints.push(fixture.text());
  }
  for (let step = checkpoints.length - 2; step >= 0; step--) {
    assert.equal(undo(fixture), true);
    assert.equal(fixture.text(), checkpoints[step], `undo checkpoint ${step}`);
  }
  for (let step = 1; step < checkpoints.length; step++) {
    assert.equal(redo(fixture), true);
    assert.equal(fixture.text(), checkpoints[step], `redo checkpoint ${step}`);
  }
});
