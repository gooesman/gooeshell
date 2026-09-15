const { app, BrowserWindow, ipcMain } = require('electron');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const url = process.env.GOOESHELL_PASTE_URL, reportFile = process.env.GOOESHELL_PASTE_REPORT, userData = process.env.GOOESHELL_PASTE_DATA;
if (!url || new URL(url).hostname !== '127.0.0.1' || !reportFile || !userData) throw new Error('Explicit isolated fixture paths and a loopback URL are required');
app.setPath('userData', userData); app.commandLine.appendSwitch('force-device-scale-factor', '1');
const metrics = { checks: {}, calls: [], rendererErrors: [], console: [] }; let window, phase = 'initialization', clipboard = '', heldClipboard, holdClipboard = false;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => window.webContents.executeJavaScript(code);
async function until(predicate, label, timeout = 8_000) { const deadline = Date.now() + timeout; while (!(await predicate())) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await delay(20); } }
const inputs = () => metrics.calls.filter(call => call.method === 'terminalInput');
const selector = index => `[data-terminal-fixture="${index}"]`;
const inspect = () => evaluate(`(() => ({ state: window.__pasteState, count: window.__pasteTerminals?.length || 0, dialogs: [...document.querySelectorAll('.terminal-paste-dialog')].map(el => ({ target: el.closest('section').dataset.terminalFixture, text: el.textContent })), queues: [...document.querySelectorAll('.terminal-paste-queue')].map(el => ({ target: el.closest('section').dataset.terminalFixture, line: el.dataset.pasteLine, nextDisabled: el.querySelector('button').disabled })), focus: document.activeElement?.outerHTML }))()`);
// Behavioral checks wait for their DOM/state condition explicitly. Waiting for
// every hidden-window animation frame can turn this suite into a 1 Hz test.
const flush = async () => { await evaluate('Promise.resolve()'); await delay(60); };
async function key(index, keyCode, modifiers = [], focus = true) {
  if (focus) await evaluate(`window.__pasteTerminals[${index}].focus()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay(60);
}
async function click(index, css) { await evaluate(`document.querySelector(${JSON.stringify(selector(index) + ' ' + css)}).click()`); await flush(); }
async function native(index, text) {
  await evaluate(`(() => { const data = new DataTransfer(); data.setData('text/plain', ${JSON.stringify(text)}); document.querySelector(${JSON.stringify(selector(index) + ' .xterm-helper-textarea')}).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); })()`); await flush();
}
async function offer(index, text) { await native(index, text); await until(async () => (await inspect()).dialogs.some(dialog => dialog.target === String(index)), 'paste chooser'); }
async function choose(index, mode) { await click(index, `[data-paste-choice="${mode}"]`); }
async function cancel(index) { await click(index, '.terminal-paste-dialog button'); }
function emit(event) { window.webContents.send('paste-fixture:event', event); }
async function bracketed(index, id, enabled) {
  const data = enabled ? '\x1b[?2004h' : '\x1b[?2004l'; emit({ type: 'terminal', sessionId: id, data: Buffer.from(data).toString('base64'), bytes: Buffer.byteLength(data) });
  await until(() => evaluate(`window.__pasteTerminals[${index}].modes.bracketedPasteMode === ${enabled}`), 'bracketed paste mode');
}
async function setState(code, predicate) { await evaluate(code); await until(async () => predicate((await inspect()).state), 'fixture state'); await flush(); }

async function run() {
  await app.whenReady();
  ipcMain.on('paste-fixture:call', (event, method, args) => { if (event.sender === window.webContents) metrics.calls.push({ method, args }); });
  ipcMain.handle('paste-fixture:clipboard', event => { assert.equal(event.sender, window.webContents); if (holdClipboard) return new Promise(resolve => { heldClipboard = resolve; }); return clipboard; });
  window = new BrowserWindow({ show: false, width: 1080, height: 760, webPreferences: { preload: path.resolve('tests/fixtures/terminal-paste-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('render-process-gone', (_event, details) => metrics.rendererErrors.push(details));
  window.webContents.on('console-message', (_event, details, message) => metrics.console.push(typeof details === 'object' ? details.message : message));
  await window.loadURL(url); window.setMenu(null); window.webContents.focus();
  await until(async () => (await inspect()).count === 2 && (await inspect()).state?.ids[0] === 'paste-a', 'two terminals');
  await until(() => metrics.calls.some(call => call.method === 'terminalResize' && call.args[0] === 'paste-a'), 'terminal initialized');
  phase = 'single-line native paste'; await native(0, 'single line');
  assert.deepEqual(inputs().at(-1).args, ['paste-a', 'single line']); assert.equal((await inspect()).dialogs.length, 0); metrics.checks.singleLineImmediate = true;

  phase = 'native multi-line chooser'; let before = inputs().length; await offer(0, 'echo one\r\necho two\n');
  assert.equal(inputs().length, before); assert.match((await inspect()).dialogs[0].text, /Fixture 1/);
  assert.match((await inspect()).focus, /data-paste-choice="lines"/); await cancel(0); assert.equal(inputs().length, before); metrics.checks.nativeChooser = true;

  phase = 'keyboard shortcut uses the same chooser'; clipboard = 'keyboard first\nkeyboard second'; before = inputs().length; await key(0, 'V', ['control', 'shift']);
  await until(async () => (await inspect()).dialogs.length === 1, 'keyboard chooser'); assert.equal(inputs().length, before); await cancel(0); metrics.checks.keyboardChooser = true;

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

  phase = 'line mode never sends Enter or advances automatically'; await offer(0, 'first\r\nsecond\nthird\n'); before = inputs().length; await choose(0, 'lines');
  assert.deepEqual(inputs().slice(before).map(call => call.args), [['paste-a', 'first']]);
  assert.deepEqual((await inspect()).queues, [{ target: '0', line: '1', nextDisabled: true }]);
  await key(0, 'Enter'); await until(async () => (await inspect()).queues[0]?.nextDisabled === false, 'line submitted');
  assert.deepEqual(inputs().slice(before).map(call => call.args), [['paste-a', 'first'], ['paste-a', '\r']]);
  await delay(200); assert.equal(inputs().length, before + 2);
  await click(0, '.terminal-paste-queue button'); assert.deepEqual(inputs().at(-1).args, ['paste-a', 'second']);
  assert.deepEqual((await inspect()).queues, [{ target: '0', line: '2', nextDisabled: true }]); metrics.checks.manualAdvance = true;

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

  phase = 'returning to a pending chooser keeps focus out of terminal input'; await offer(0, 'protected\nchooser'); before = inputs().length;
  await setState('window.__pasteFixture.setActive(1)', state => state.active === 1);
  await setState('window.__pasteFixture.setActive(0)', state => state.active === 0);
  await until(async () => /data-paste-choice="lines"/.test((await inspect()).focus), 'choice regains focus after tab return');
  assert.match((await inspect()).focus, /data-paste-choice="lines"/);
  await key(0, 'X', [], false); assert.equal(inputs().length, before);
  await key(0, 'Enter'); assert.equal(inputs().length, before);
  await cancel(0); metrics.checks.chooserFocusIsolation = true;

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
run().catch(async error => { metrics.success = false; metrics.error = error.stack || String(error); metrics.phase = phase; if (window && !window.isDestroyed()) { try { metrics.screen = await inspect(); await fs.writeFile(reportFile + '.failure.png', (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); } catch {} } }).finally(async () => { if (window && !window.isDestroyed()) window.destroy(); await fs.writeFile(reportFile, JSON.stringify(metrics, null, 2)); app.exit(metrics.success ? 0 : 1); });
