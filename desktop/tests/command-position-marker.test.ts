import test from 'node:test';
import assert from 'node:assert/strict';
import {Terminal} from '@xterm/xterm';
import {registerCommandPositionMarker} from '../src/renderer/command-position-marker';

const write = (terminal: Terminal, text: string) => new Promise<void>(resolve => terminal.write(text, resolve));
function find(terminal: Terminal, text: string) {
  for (let row = 0; row < terminal.buffer.normal.length; row++) {
    if (terminal.buffer.normal.getLine(row)?.translateToString(true).includes(text)) return row;
  }
  throw new Error(`Text missing: ${text}`);
}

test('a command starting in a wrapped row keeps its successful record when rows merge', async t => {
  const terminal = new Terminal({cols: 10, rows: 4}); t.after(() => terminal.dispose());
  await write(terminal, 'A'.repeat(25));
  const marker = registerCommandPositionMarker(terminal)!;
  const record = {marker, status: 'success'};
  let removed = false; marker.onDispose(() => { removed = true; });
  await write(terminal, '$ true\r\noutput\r\n\r\n');
  assert.equal(marker.line, 2);
  terminal.resize(40, 4);
  assert.equal(removed, false); assert.equal(record.status, 'success');
  assert.equal(marker.line, find(terminal, '$ true'));
  terminal.resize(8, 4);
  assert.equal(marker.line, find(terminal, '$ true'));
  terminal.resize(60, 4);
  assert.equal(marker.line, find(terminal, '$ true'));
});

test('wide-character padding is excluded when locating a prompt after repeated reflow', async t => {
  const terminal = new Terminal({cols: 5, rows: 12}); t.after(() => terminal.dispose());
  await write(terminal, '中文中文中文中');
  const marker = registerCommandPositionMarker(terminal)!;
  await write(terminal, '$\r\noutput\r\n');
  assert.equal(marker.line, find(terminal, '$'));
  for (const columns of [7, 16, 5, 9, 6, 30]) {
    terminal.resize(columns, 12);
    assert.equal(marker.isDisposed, false);
    assert.equal(marker.line, find(terminal, '$'), `columns ${columns}`);
  }
});

test('real blank cells and explicit spaces are not mistaken for wide-character wrap padding', async t => {
  const terminal = new Terminal({cols: 5, rows: 12}); t.after(() => terminal.dispose());
  await write(terminal, '\x1b[4C中文');
  const marker = registerCommandPositionMarker(terminal)!;
  await write(terminal, '$\r\noutput\r\n');
  for (const columns of [6, 12, 5, 20]) {
    terminal.resize(columns, 12);
    assert.equal(marker.line, find(terminal, '$'), `columns ${columns}`);
  }
});

test('a pending wrap follows prompt text even when buffer length stays unchanged', async t => {
  const terminal = new Terminal({cols: 10, rows: 12}); t.after(() => terminal.dispose());
  await write(terminal, 'A'.repeat(10));
  const marker = registerCommandPositionMarker(terminal)!;
  assert.equal(marker.line, 0);
  const length = terminal.buffer.normal.length;
  await write(terminal, '$ true\r\n');
  assert.equal(terminal.buffer.normal.length, length);
  assert.equal(marker.line, find(terminal, '$ true'));
  terminal.resize(30, 12);
  assert.equal(marker.line, find(terminal, '$ true'));
});

test('the current prompt remains on its actual row when xterm skips cursor-line reflow', async t => {
  const terminal = new Terminal({cols: 10, rows: 12}); t.after(() => terminal.dispose());
  await write(terminal, 'A'.repeat(25));
  const marker = registerCommandPositionMarker(terminal)!;
  await write(terminal, '$ true');
  assert.equal(marker.line, find(terminal, '$ tru'));
  terminal.resize(40, 12);
  assert.equal(marker.line, find(terminal, '$ tru'));
  await write(terminal, '\r\noutput\r\n');
  terminal.resize(60, 12);
  assert.equal(marker.line, find(terminal, '$ tru'));
});

test('scrollback disposal and manual disposal each notify once and release the logical anchor', async t => {
  const terminal = new Terminal({cols: 10, rows: 4, scrollback: 4}); t.after(() => terminal.dispose());
  await write(terminal, 'A'.repeat(25));
  const marker = registerCommandPositionMarker(terminal)!;
  let disposed = 0; marker.onDispose(() => disposed++);
  await write(terminal, '$ true\r\n' + 'output\r\n'.repeat(15));
  assert.equal(marker.isDisposed, true); assert.equal(marker.line, -1); assert.equal(disposed, 1);
  marker.dispose(); assert.equal(disposed, 1);
  const another = registerCommandPositionMarker(terminal)!;
  let manual = 0; another.onDispose(() => manual++); another.dispose(); another.dispose();
  assert.equal(another.line, -1); assert.equal(manual, 1);
  await write(terminal, '\x1b[?1049h');
  assert.equal(registerCommandPositionMarker(terminal), undefined);
});
