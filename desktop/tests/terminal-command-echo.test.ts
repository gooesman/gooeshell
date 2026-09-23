import test from 'node:test';
import assert from 'node:assert/strict';
import {Terminal} from '@xterm/xterm';
import {readCommandEcho} from '../src/renderer/terminal-command-echo';

const write = (terminal: Terminal, text: string) => new Promise<void>(resolve => terminal.write(text, resolve));
const position = (terminal: Terminal) => ({line: terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY, column: terminal.buffer.normal.cursorX});
async function prompt(terminal: Terminal, text = 'user$ ') {
  await write(terminal, text);
  const buffer = terminal.buffer.normal, column = buffer.cursorX;
  return {marker: terminal.registerMarker(0)!, column, columns: terminal.cols,
    prefix: buffer.getLine(buffer.baseY + buffer.cursorY)!.translateToString(false, 0, column)};
}

test('single-line echo keeps pipelines, real spaces and current edits, excluding prompt and output', async t => {
  const terminal = new Terminal({cols: 100, rows: 8}); t.after(() => terminal.dispose());
  const input = await prompt(terminal);
  await write(terminal, 'echo wrnog\x1b[5D\x1b[Kright | sed "s/i/I/"  \r\n');
  const end = position(terminal);
  await write(terminal, 'OUTPUT_WITH_PASSWORD_PROMPT:');
  assert.equal(readCommandEcho(terminal, input, end), 'echo right | sed "s/i/I/"  ');
});

test('long single-line echo concatenates soft wraps without adding newlines or spaces', async t => {
  const terminal = new Terminal({cols: 13, rows: 6, scrollback: 100}); t.after(() => terminal.dispose());
  const input = await prompt(terminal), command = 'printf "' + 'abc def '.repeat(22) + '" | wc -c';
  await write(terminal, command + '\r\n');
  assert.equal(readCommandEcho(terminal, input, position(terminal)), command);
});

test('Chinese wide-character padding and combining characters preserve exact visible text', async t => {
  const terminal = new Terminal({cols: 9, rows: 12}); t.after(() => terminal.dispose());
  const input = await prompt(terminal, '$ '), command = 'echo 中文中文中文 e\u0301 中文中文中文  ';
  await write(terminal, command + '\r\n');
  assert.equal(readCommandEcho(terminal, input, position(terminal)), command);
});

test('a prompt at the final column can wrap before the first echoed command character', async t => {
  const terminal = new Terminal({cols: 10, rows: 8}); t.after(() => terminal.dispose());
  const input = await prompt(terminal, 'PROMPT1234');
  await write(terminal, 'echo ok\r\n');
  assert.equal(readCommandEcho(terminal, input, position(terminal)), 'echo ok');
});

test('old Readline horizontal scrolling cannot turn a clipped tail into a complete command', async t => {
  const terminal = new Terminal({cols: 100, rows: 8}); t.after(() => terminal.dispose());
  const input = await prompt(terminal, 'fixture> ');
  // Captured from Bash 5.0 / old Readline: CR replaces the original prompt with
  // a left-truncation indicator; the missing prefix is absent from the buffer.
  await write(terminal, '\r<ong-long-long-long-long-long-long-long-long-" | cat\r\n');
  assert.equal(readCommandEcho(terminal, input, position(terminal)), undefined);
});

test('empty prompts reject horizontal-scroll indicators but retain ordinary command echo', async t => {
  for (const command of ['<clipped-command-tail', 'echo ok']) {
    const terminal = new Terminal({cols: 40, rows: 8}); t.after(() => terminal.dispose());
    const input = await prompt(terminal, '');
    await write(terminal, command + '\r\n');
    assert.equal(readCommandEcho(terminal, input, position(terminal)), command.startsWith('<') ? undefined : command);
  }
});

test('horizontal scrolling followed by Home rejects a right-clipped command even with an intact prompt', async t => {
  const terminal = new Terminal({cols: 100, rows: 8}); t.after(() => terminal.dispose());
  const input = await prompt(terminal, 'fixture> ');
  // Bash 5.0 and 5.2 both redraw the prompt after Home, but the right indicator
  // means the remaining command is offscreen and cannot be reconstructed here.
  await write(terminal, '\rfixture> printf "%s\\n" "long-long-long-long-long-long->\r' + '\x1b[C'.repeat(9) + '\r\n');
  assert.equal(terminal.buffer.normal.getLine(input.marker.line)!.translateToString(false, 0, input.column), input.prefix);
  assert.equal(readCommandEcho(terminal, input, position(terminal)), undefined);
});

test('empty, non-echoed, leading-space and multiline/PS2 input never produce inferred commands', async t => {
  for (const command of ['', ' hidden-secret', '  ', 'echo "first\r\n> second"', 'cat <<EOF\r\n> secret\r\n> EOF']) {
    const terminal = new Terminal({cols: 80, rows: 12}); t.after(() => terminal.dispose());
    const input = await prompt(terminal);
    await write(terminal, command + '\r\n');
    assert.equal(readCommandEcho(terminal, input, position(terminal)), undefined, JSON.stringify(command));
  }
});

test('hidden password input has no buffer content to extract and later output stays outside its boundary', async t => {
  const terminal = new Terminal({cols: 80, rows: 12}); t.after(() => terminal.dispose());
  const input = await prompt(terminal);
  const end = position(terminal); // Nothing echoed while the user enters a hidden value.
  await write(terminal, '\r\nPassword: this later text is not the command');
  assert.equal(readCommandEcho(terminal, input, end), undefined);
});

test('changed width, disposed markers, alternate buffers and incomplete boundaries reject fallback', async t => {
  const terminal = new Terminal({cols: 20, rows: 12}); t.after(() => terminal.dispose());
  const input = await prompt(terminal);
  await write(terminal, 'echo ok\r\n'); const end = position(terminal);
  assert.equal(readCommandEcho(terminal, input, {...end, column: 1}), undefined);
  terminal.resize(30, 12); assert.equal(readCommandEcho(terminal, input, end), undefined);
  terminal.resize(20, 12);
  await write(terminal, '\x1b[?1049h'); assert.equal(readCommandEcho(terminal, input, end), undefined);
  await write(terminal, '\x1b[?1049l');
  input.marker.dispose(); assert.equal(readCommandEcho(terminal, input, end), undefined);
});

test('the echo fallback is bounded at 8192 characters', async t => {
  for (const length of [8192, 8193]) {
    const terminal = new Terminal({cols: 100, rows: 8, scrollback: 200}); t.after(() => terminal.dispose());
    const input = await prompt(terminal), command = 'a'.repeat(length);
    await write(terminal, command + '\r\n');
    assert.equal(readCommandEcho(terminal, input, position(terminal)), length === 8192 ? command : undefined);
  }
});
