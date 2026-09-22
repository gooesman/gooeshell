const { app, BrowserWindow, ipcMain } = require('electron');
const { finishRendererFixture } = require('./renderer-fixture-report.cjs');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { configureApplicationMenu } = require('../../dist-main/main/application-menu.js');
const url = process.env.GOOESHELL_PASTE_URL, reportFile = process.env.GOOESHELL_PASTE_REPORT, userData = process.env.GOOESHELL_PASTE_DATA;
if (!url || new URL(url).hostname !== '127.0.0.1' || !reportFile || !userData) throw new Error('Explicit isolated fixture paths and a loopback URL are required');
app.setPath('userData', userData); app.commandLine.appendSwitch('force-device-scale-factor', '1');
const metrics = { checks: {}, calls: [], rendererErrors: [], console: [] }; let window, phase = 'initialization', clipboard = '', heldClipboard, holdClipboard = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => window.webContents.executeJavaScript(code);
async function until(predicate, label, timeout = 8_000) { const deadline = Date.now() + timeout; while (!(await predicate())) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await delay(20); } }
const inputs = () => metrics.calls.filter(call => call.method === 'terminalInput');
const selector = index => `[data-terminal-fixture="${index}"]`;
const inspect = () => evaluate(`(() => ({ state: window.__pasteState, count: window.__pasteTerminals?.length || 0, dialogs: [...document.querySelectorAll('.terminal-paste-dialog')].map(el => ({ target: el.closest('section').dataset.terminalFixture, text: el.textContent, editorValue: el.querySelector('[data-paste-editor]')?.value, choicesDisabled: [...el.querySelectorAll('[data-paste-choice]')].map(button => button.disabled) })), queues: [...document.querySelectorAll('.terminal-paste-queue')].map(el => ({ target: el.closest('section').dataset.terminalFixture, line: el.dataset.pasteLine, nextDisabled: el.querySelector('button').disabled })), focus: document.activeElement?.outerHTML }))()`);
// Behavioral checks wait for their DOM/state condition explicitly. Waiting for
// every hidden-window animation frame can turn this suite into a 1 Hz test.
const flush = async () => { await evaluate('Promise.resolve()'); await delay(60); };
async function key(index, keyCode, modifiers = [], focus = true) {
  if (focus) await evaluate(`window.__pasteTerminals[${index}].focus()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  // Chromium editable fields insert a newline on the native char event; xterm
  // sends its Enter byte from keyDown. Emit both only for editor-focused input.
  if (!focus && keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay(60);
}
async function click(index, css) { await evaluate(`document.querySelector(${JSON.stringify(selector(index) + ' ' + css)}).click()`); await flush(); }
async function native(index, text) {
  await evaluate(`(() => { const data = new DataTransfer(); data.setData('text/plain', ${JSON.stringify(text)}); document.querySelector(${JSON.stringify(selector(index) + ' .xterm-helper-textarea')}).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); })()`); await flush();
}
async function offer(index, text) { await native(index, text); await until(async () => (await inspect()).dialogs.some(dialog => dialog.target === String(index)), 'paste chooser'); }
async function choose(index, mode) { await click(index, `[data-paste-choice="${mode}"]`); }
async function cancel(index) { await click(index, '.terminal-paste-dialog button'); }
async function fillEditor(index, text) {
  await evaluate(`(() => { const editor = document.querySelector(${JSON.stringify(selector(index) + ' [data-paste-editor]')}); editor.focus(); editor.select(); })()`);
  if (text) await window.webContents.insertText(text); else await key(index, 'Backspace', [], false);
  await until(async () => (await inspect()).dialogs.find(dialog => dialog.target === String(index))?.editorValue === text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'paste editor value updated');
}
async function editorEnd(index) {
  await evaluate(`(() => { const editor = document.querySelector(${JSON.stringify(selector(index) + ' [data-paste-editor]')}); editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); })()`);
}
async function assertFocused(index, css) {
  assert.equal(await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(selector(index) + ' ' + css)})`), true, 'Expected dialog focus: ' + css);
}
function emit(event) { window.webContents.send('paste-fixture:event', event); }
async function bracketed(index, id, enabled) {
  const data = enabled ? '\x1b[?2004h' : '\x1b[?2004l'; emit({ type: 'terminal', sessionId: id, data: Buffer.from(data).toString('base64'), bytes: Buffer.byteLength(data) });
  await until(() => evaluate(`window.__pasteTerminals[${index}].modes.bracketedPasteMode === ${enabled}`), 'bracketed paste mode');
}
async function setState(code, predicate) { await evaluate(code); await until(async () => predicate((await inspect()).state), 'fixture state'); await flush(); }

async function run() {
  await app.whenReady();
  configureApplicationMenu();
  ipcMain.on('paste-fixture:call', (event, method, args) => { if (event.sender === window.webContents) metrics.calls.push({ method, args }); });
  ipcMain.handle('paste-fixture:clipboard', event => { assert.equal(event.sender, window.webContents); if (holdClipboard) return new Promise(resolve => { heldClipboard = resolve; }); return clipboard; });
  window = new BrowserWindow({ show: false, width: 1080, height: 760, webPreferences: { preload: path.resolve('tests/fixtures/terminal-paste-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('render-process-gone', (_event, details) => metrics.rendererErrors.push(details));
  window.webContents.on('console-message', (_event, details, message) => metrics.console.push(typeof details === 'object' ? details.message : message));
  await window.loadURL(url); window.setMenu(null); window.webContents.focus();
  // The fixture supplies its own clipboard through IPC. Never read or forward
  // the user's native clipboard if an unprevented browser default also fires.
  await evaluate(`window.__nativePasteCount=0;document.addEventListener('paste',event=>{if(event.isTrusted){window.__nativePasteCount++;event.preventDefault();event.stopImmediatePropagation();}},true);true`);
  await until(async () => (await inspect()).count === 2 && (await inspect()).state?.ids[0] === 'paste-a', 'two terminals');
  await until(() => metrics.calls.some(call => call.method === 'terminalResize' && call.args[0] === 'paste-a'), 'terminal initialized');
  phase = 'single-line native paste'; await native(0, 'single line');
  assert.deepEqual(inputs().at(-1).args, ['paste-a', 'single line']); assert.equal((await inspect()).dialogs.length, 0); metrics.checks.singleLineImmediate = true;

  phase = 'native multi-line chooser'; let before = inputs().length; await offer(0, 'echo one\r\necho two\n');
  assert.equal(inputs().length, before); assert.match((await inspect()).dialogs[0].text, /Fixture 1/);
  assert.match((await inspect()).focus, /data-paste-editor/); assert.equal((await inspect()).dialogs[0].editorValue, 'echo one\necho two\n');
  await cancel(0); assert.equal(inputs().length, before); metrics.checks.nativeChooser = true;

  phase = 'keyboard shortcut uses the same chooser'; clipboard = 'keyboard first\nkeyboard second'; before = inputs().length; await key(0, 'V', ['control', 'shift']);
  await until(async () => (await inspect()).dialogs.length === 1, 'keyboard chooser'); assert.equal(inputs().length, before); assert.equal(await evaluate('window.__nativePasteCount'), 0, 'custom shortcut must prevent a second native paste'); await cancel(0); metrics.checks.keyboardChooser = true;

  phase = 'right click and configured middle click use the same chooser'; clipboard = 'mouse first\nmouse second';
  await evaluate(`document.querySelector('${selector(0)} .xterm-helper-textarea').dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true }))`);
  await until(async () => (await inspect()).dialogs.length === 1, 'right click chooser'); await cancel(0);
  await setState('window.__pasteFixture.setMouse(true)', state => state.mouse);
  await evaluate(`document.querySelector('${selector(0)} .xterm-helper-textarea').dispatchEvent(new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true }))`);
  await until(async () => (await inspect()).dialogs.length === 1, 'middle click chooser'); assert.equal(inputs().length, before); await cancel(0);
  await setState('window.__pasteFixture.setMouse(false)', state => !state.mouse); metrics.checks.mouseChooser = true;

  phase = 'whole paste preserves xterm bracket wrappers and normalized bytes'; await bracketed(0, 'paste-a', true);
  await offer(0, 'line one\r\nline two\n'); before = inputs().length; await choose(0, 'all');
  assert.equal(inputs().length, before + 1); assert.deepEqual(inputs().at(-1).args, ['paste-a', '\x1b[200~line one\rline two\r\x1b[201~']); metrics.checks.bracketedWhole = true;
  await bracketed(0, 'paste-a', false); await offer(0, 'plain one\nplain two'); await choose(0, 'all');
  assert.deepEqual(inputs().at(-1).args, ['paste-a', 'plain one\rplain two']); metrics.checks.unbracketedWhole = true;

  phase = 'editor changes and Enter remain local until whole paste is chosen'; await offer(0, 'original one\noriginal two'); before = inputs().length;
  await fillEditor(0, 'edited one\nedited two'); assert.equal(inputs().length, before);
  await editorEnd(0); await key(0, 'Enter', [], false);
  await until(async () => (await inspect()).dialogs[0].editorValue === 'edited one\nedited two\n', 'Enter inserts a newline in editor');
  assert.equal(inputs().length, before); await window.webContents.insertText('edited three');
  await until(async () => (await inspect()).dialogs[0].editorValue === 'edited one\nedited two\nedited three', 'third edited line');
  assert.match((await inspect()).dialogs[0].text, /3 行/); assert.equal(inputs().length, before);
  for (const css of ['.terminal-paste-buttons button:first-child', '[data-paste-choice="all"]', '[data-paste-choice="lines"]', '[data-paste-editor]']) { await key(0, 'Tab', [], false); await assertFocused(0, css); }
  for (const css of ['[data-paste-choice="lines"]', '[data-paste-choice="all"]', '.terminal-paste-buttons button:first-child', '[data-paste-editor]']) { await key(0, 'Tab', ['shift'], false); await assertFocused(0, css); }
  assert.equal(inputs().length, before); metrics.checks.editorFocusCycle = true;
  // A fully hidden WebContents can return its old black frame. Paint this
  // disposable window without taking focus from another application.
  window.showInactive();
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await delay(100);
  await fs.writeFile(reportFile + '.editable.png', (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  window.hide();
  await choose(0, 'all'); assert.deepEqual(inputs().slice(before).map(call => call.args), [['paste-a', 'edited one\redited two\redited three']]);
  metrics.checks.editedWhole = true; metrics.checks.editorEnterIsLocal = true;

  phase = 'empty editor disables both choices and never sends'; await offer(0, 'remove one\nremove two'); before = inputs().length;
  await fillEditor(0, ''); assert.deepEqual((await inspect()).dialogs[0].choicesDisabled, [true, true]);
  for (const modifiers of [[], ['shift']]) {
    await key(0, 'Tab', modifiers, false); await assertFocused(0, '.terminal-paste-buttons button:first-child');
    await key(0, 'Tab', modifiers, false); await assertFocused(0, '[data-paste-editor]');
  }
  metrics.checks.disabledChoicesSkipped = true;
  await choose(0, 'all'); await choose(0, 'lines'); assert.equal(inputs().length, before); assert.equal((await inspect()).dialogs.length, 1);
  await cancel(0); assert.equal(inputs().length, before); metrics.checks.emptyEditorBlocked = true;

  phase = 'text beyond the old preview cutoff can be edited and sent in full';
  const longPrefix = 'x'.repeat(12500) + '\n'; await offer(0, longPrefix + 'old tail'); before = inputs().length;
  assert.equal((await inspect()).dialogs[0].editorValue, longPrefix + 'old tail');
  await evaluate(`(() => { const editor = document.querySelector('${selector(0)} [data-paste-editor]'); editor.focus(); editor.setSelectionRange(${longPrefix.length}, editor.value.length); })()`);
  await window.webContents.insertText('new tail 完整保留');
  await until(async () => (await inspect()).dialogs[0].editorValue === longPrefix + 'new tail 完整保留', 'long text tail edited');
  assert.equal(inputs().length, before); await choose(0, 'all');
  assert.deepEqual(inputs().slice(before).map(call => call.args), [['paste-a', longPrefix.replace(/\n/g, '\r') + 'new tail 完整保留']]); metrics.checks.longEditorComplete = true;

  phase = 'cancel discards local edits'; await offer(0, 'cancel original\nsecond'); before = inputs().length;
  await fillEditor(0, 'cancel edited\nnever send'); await cancel(0);
  assert.equal(inputs().length, before); assert.equal((await inspect()).dialogs.length, 0); metrics.checks.cancelEditedText = true;

  phase = 'line mode uses edited text and never sends Enter or advances automatically'; await offer(0, 'original first\noriginal second'); before = inputs().length;
  await fillEditor(0, 'first\nsecond\nthird\n'); assert.equal(inputs().length, before); assert.match((await inspect()).dialogs[0].text, /3 行/);
  await choose(0, 'lines');
  assert.deepEqual(inputs().slice(before).map(call => call.args), [['paste-a', 'first']]);
  assert.deepEqual((await inspect()).queues, [{ target: '0', line: '1', nextDisabled: true }]);
  await key(0, 'Enter'); await until(async () => (await inspect()).queues[0]?.nextDisabled === false, 'line submitted');
  assert.deepEqual(inputs().slice(before).map(call => call.args), [['paste-a', 'first'], ['paste-a', '\r']]);
  await delay(200); assert.equal(inputs().length, before + 2);
  await click(0, '.terminal-paste-queue button'); assert.deepEqual(inputs().at(-1).args, ['paste-a', 'second']);
  assert.deepEqual((await inspect()).queues, [{ target: '0', line: '2', nextDisabled: true }]); metrics.checks.manualAdvance = true; metrics.checks.editedLines = true;

  phase = 'queue belongs to original terminal across tab switches'; const queueInputs = inputs().length;
  await setState('window.__pasteFixture.setActive(1)', state => state.active === 1);
  await native(1, 'only second terminal'); assert.deepEqual(inputs().at(-1).args, ['paste-b', 'only second terminal']);
  assert.equal(inputs().length, queueInputs + 1); assert.equal((await inspect()).queues[0].line, '2');
  await setState('window.__pasteFixture.setActive(0)', state => state.active === 0); assert.equal(inputs().length, queueInputs + 1);
  await key(0, 'Enter'); await click(0, '.terminal-paste-queue button'); assert.deepEqual(inputs().at(-1).args, ['paste-a', 'third']);
  await key(0, 'Enter'); await until(async () => (await inspect()).queues.length === 0, 'last line clears queue'); metrics.checks.tabIsolation = true;

  phase = 'cancel button and Ctrl+C clear remaining lines'; await offer(0, 'keep\ncancelled'); await choose(0, 'lines'); before = inputs().length;
  await click(0, '.terminal-paste-queue button:last-child'); assert.equal((await inspect()).queues.length, 0); assert.equal(inputs().length, before);
  await offer(0, 'keep\ncancelled'); await choose(0, 'lines'); await key(0, 'C', ['control']);
  await until(async () => (await inspect()).queues.length === 0, 'Ctrl+C cancels'); assert.deepEqual(inputs().at(-1).args, ['paste-a', '\x03']); metrics.checks.cancelAndCtrlC = true;

  phase = 'Escape cancels chooser without writing'; await offer(0, 'cancel\nchooser'); before = inputs().length; await key(0, 'Escape', [], false);
  await until(async () => (await inspect()).dialogs.length === 0, 'Escape chooser'); assert.equal(inputs().length, before); metrics.checks.escapeChooser = true;

  phase = 'returning to a pending chooser preserves edited draft and keeps focus out of terminal input'; await offer(0, 'protected\nchooser'); before = inputs().length;
  await fillEditor(0, 'edited protected\nchooser draft');
  await setState('window.__pasteFixture.setActive(1)', state => state.active === 1);
  await setState('window.__pasteFixture.setActive(0)', state => state.active === 0);
  await until(async () => /data-paste-editor/.test((await inspect()).focus), 'editor regains focus after tab return');
  assert.match((await inspect()).focus, /data-paste-editor/);
  assert.equal((await inspect()).dialogs[0].editorValue, 'edited protected\nchooser draft'); assert.equal(inputs().length, before);
  await editorEnd(0); await window.webContents.insertText(' locally'); await key(0, 'Enter', [], false);
  await until(async () => (await inspect()).dialogs[0].editorValue === 'edited protected\nchooser draft locally\n', 'returned editor stays editable');
  assert.equal(inputs().length, before);
  // Even an unexpected focus jump or native paste on the underlying xterm
  // cannot write to the connection or replace the pending edited draft.
  await key(0, 'Enter'); assert.equal(inputs().length, before);
  await native(0, 'must-not-send'); assert.equal(inputs().length, before);
  assert.equal((await inspect()).dialogs[0].editorValue, 'edited protected\nchooser draft locally\n');
  metrics.checks.chooserBlocksUnderlyingTerminal = true;
  await cancel(0); metrics.checks.chooserFocusIsolation = true; metrics.checks.editedDraftTabIsolation = true;

  phase = 'disconnect clears chooser and line queue'; await offer(0, 'stop\ndisconnect'); await choose(0, 'lines'); before = inputs().length;
  emit({ type: 'sessionClosed', sessionId: 'paste-a', message: 'Fixture disconnect' }); await until(async () => (await inspect()).queues.length === 0, 'close event clears queue');
  await native(0, 'offline\nblocked'); assert.equal((await inspect()).dialogs.length, 0); assert.equal(inputs().length, before);
  await setState('window.__pasteFixture.setIds(["paste-a-new", "paste-b"])', state => state.ids[0] === 'paste-a-new'); metrics.checks.disconnectClears = true;

  phase = 'reconnect props and replacement transport clear pending lines'; await offer(0, 'pending\nsecond'); await choose(0, 'lines');
  await setState('window.__pasteFixture.setReconnecting(true)', state => state.reconnecting); assert.equal((await inspect()).queues.length, 0);
  await setState('window.__pasteFixture.setReconnecting(false)', state => !state.reconnecting);
  await offer(0, 'pending\nsecond'); await setState('window.__pasteFixture.setIds(["paste-a-third", "paste-b"])', state => state.ids[0] === 'paste-a-third');
  assert.equal((await inspect()).dialogs.length, 0); assert.equal((await inspect()).queues.length, 0); metrics.checks.reconnectClears = true;

  phase = 'delayed clipboard never reaches a replacement transport'; holdClipboard = true; before = inputs().length; await key(0, 'V', ['control', 'shift']); await until(() => !!heldClipboard, 'clipboard request held');
  await setState('window.__pasteFixture.setIds(["paste-a-fourth", "paste-b"])', state => state.ids[0] === 'paste-a-fourth'); heldClipboard('must-not-send'); heldClipboard = undefined; holdClipboard = false; await flush();
  assert.equal(inputs().length, before); assert.equal((await inspect()).dialogs.length, 0); metrics.checks.asyncTransportIsolation = true;

  phase = 'delayed clipboard is discarded after switching tabs'; holdClipboard = true; before = inputs().length; await key(0, 'V', ['control', 'shift']); await until(() => !!heldClipboard, 'clipboard request held before switch');
  await setState('window.__pasteFixture.setActive(1)', state => state.active === 1); heldClipboard('must-not-send-hidden'); heldClipboard = undefined; holdClipboard = false; await flush();
  assert.equal(inputs().length, before); assert.equal((await inspect()).dialogs.length, 0); metrics.checks.asyncVisibilityIsolation = true;
  metrics.final = await inspect(); assert.deepEqual(metrics.rendererErrors, []); metrics.success = true;
  await fs.writeFile(reportFile + '.png', (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
}
run().catch(async error => { metrics.success = false; metrics.error = error.stack || String(error); metrics.phase = phase; if (window && !window.isDestroyed()) { try { metrics.screen = await inspect(); await fs.writeFile(reportFile + '.failure.png', (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); } catch {} } }).finally(async () => { await finishRendererFixture(app, reportFile, metrics); });
