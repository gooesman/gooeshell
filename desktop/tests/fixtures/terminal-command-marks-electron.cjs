const { app, BrowserWindow, ipcMain } = require('electron');
const { finishRendererFixture } = require('./renderer-fixture-report.cjs');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const url = process.env.GOOESHELL_COMMAND_MARKS_URL, report = process.env.GOOESHELL_COMMAND_MARKS_REPORT;
const userData = process.env.GOOESHELL_COMMAND_MARKS_DATA;
if (!url || new URL(url).hostname !== '127.0.0.1' || !report || !userData) throw new Error('Explicit isolated paths and a loopback URL are required');
app.setPath('userData', userData); app.commandLine.appendSwitch('force-device-scale-factor', '1');
if (process.env.CI) { app.commandLine.appendSwitch('use-angle', 'swiftshader'); app.commandLine.appendSwitch('enable-unsafe-swiftshader'); }
const metrics = { checks: {}, rendererErrors: [], calls: [], expectedAck: {}, console: [] };
let window, phase = 'startup';
const started = Date.now();
let reportedPhase;
const progressTimer = setInterval(() => {
  if (reportedPhase === phase) return;
  reportedPhase = phase;
  void fs.writeFile(report + '.progress.json', JSON.stringify({ phase, elapsedMs: Date.now() - started,
    completedChecks: Object.keys(metrics.checks), stress: metrics.stress }, null, 2)).catch(() => {});
}, 200);
progressTimer.unref();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => window.webContents.executeJavaScript(code);
async function until(predicate, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await delay(20); }
}
async function flush() { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await delay(25); }
const calls = method => metrics.calls.filter(call => call.method === method);
const scope = '[data-fixture-tab="a"]';
const markSelector = id => `${scope} button[data-command-mark=${JSON.stringify(id)}]`;
const osc = (id, value) => `\x1b]${id};${value}\x07`;
const escapedCommand = value => value.replace(/\\/g, '\\x5c').replace(/;/g, '\\x3b').replace(/\n/g, '\\x0a');
const prepareCommand = command => osc(133, 'A') + 'fixture$ ' + osc(133, 'B') + command + osc(633, `E;${escapedCommand(command)}`) + '\r\n';
const startCommand = command => prepareCommand(command) + osc(133, 'C');
const completeCommand = (command, output, code = 0) => startCommand(command) + output + osc(133, `D;${code}`);
const spacer = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}_${index}\r\n`).join('');
function emit(event) { window.webContents.send('command-marks-fixture:event', event); }
function send(id, text, accepted = true) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  if (accepted) metrics.expectedAck[id] = (metrics.expectedAck[id] || 0) + bytes.length;
  emit({ type: 'terminal', sessionId: id, data: bytes.toString('base64'), bytes: bytes.length });
  return bytes.length;
}
function outputAndClose(id, text) {
  const bytes = Buffer.from(text);
  metrics.expectedAck[id] = (metrics.expectedAck[id] || 0) + bytes.length;
  emit([{ type: 'terminal', sessionId: id, data: bytes.toString('base64'), bytes: bytes.length },
    { type: 'sessionClosed', sessionId: id, message: 'Disconnect in the same renderer task as the final output' }]);
}
async function key(keyCode, modifiers = [], focus = true) {
  if (focus) await evaluate('window.__marksTerminals[0].focus()');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(45);
}
async function nativeClick(selector, button = 'left') {
  await until(() => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&e.getClientRects().length>0})()`), `visible click target ${selector}`);
  const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const zoom = window.webContents.getZoomFactor(), native = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) };
  window.webContents.sendInputEvent({ type: 'mouseMove', ...native });
  window.webContents.sendInputEvent({ type: 'mouseDown', ...native, button, clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', ...native, button, clickCount: 1 });
  await flush();
}
async function menuClick(label) {
  const find = `(()=>[...document.querySelectorAll('button,[role="menuitem"]')].find(e=>e.getClientRects().length>0&&!e.disabled&&e.textContent.trim()===${JSON.stringify(label)}))()`;
  await until(() => evaluate(`Boolean(${find})`), `context menu ${label}`);
  const point = await evaluate(`(()=>{const r=${find}.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const zoom = window.webContents.getZoomFactor(), native = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) };
  window.webContents.sendInputEvent({ type: 'mouseMove', ...native });
  window.webContents.sendInputEvent({ type: 'mouseDown', ...native, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', ...native, button: 'left', clickCount: 1 });
  await flush();
}
async function patchSettings(patch) {
  await evaluate(`window.__marksFixture.patchSettings(${JSON.stringify(patch)})`);
  await until(() => evaluate(`Object.entries(${JSON.stringify(patch)}).every(([key,value])=>window.__marksFixture.settings[key]===value)`), 'settings applied');
  await flush();
}
const inspect = () => evaluate(String.raw`(()=>{
  const t=window.__marksTerminals?.[0],root=document.querySelector('[data-fixture-tab="a"]');if(!t||!root)return null;
  const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
  const rectangle=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
  const buffer=t.buffer.normal;
  return {count:window.__marksTerminals.length,sameTerminal:!window.__marksOriginal||window.__marksOriginal===t,
    active:window.__marksFixture.active,connection:window.__marksFixture.connection,position:window.__marksFixture.settings.commandMarks,
    type:t.buffer.active.type,viewport:t.buffer.active.viewportY,base:buffer.baseY,length:buffer.length,cols:t.cols,rows:t.rows,fontSize:t.options.fontSize,
    pendingCallbacks:window.__marksDeferredCallbacks.length,renderCount:window.__marksRenderCount||0,
    keyDecisions:window.__marksKeyDecisions.slice(-12),canvas:root.querySelectorAll('canvas').length,
    terminalRect:rectangle(root.querySelector('.xterm-screen')),
    containers:[...root.querySelectorAll('[data-command-marks-position]')].filter(visible).map(e=>({position:e.dataset.commandMarksPosition,...rectangle(e)})),
    marks:[...root.querySelectorAll('button[data-command-mark]')].filter(visible).map(e=>({id:e.dataset.commandMark,status:e.dataset.status,
      line:Number(e.dataset.commandLine),command:e.dataset.command||'',label:e.getAttribute('aria-label')||e.title,
      color:getComputedStyle(e,'::before').backgroundColor,background:getComputedStyle(e).backgroundColor,...rectangle(e)})),
    reconnect:!!root.querySelector('.terminal-reconnect'),
    head:Array.from({length:Math.min(5,buffer.length)},(_,i)=>buffer.getLine(i)?.translateToString(true)||''),
    tail:Array.from({length:Math.min(5,buffer.length)},(_,i)=>buffer.getLine(Math.max(0,buffer.length-5)+i)?.translateToString(true)||'')};
})()`);
const bufferContains = value => evaluate(`(()=>{const b=window.__marksTerminals[0].buffer.normal;for(let i=0;i<b.length;i++)if(b.getLine(i)?.translateToString(true).includes(${JSON.stringify(value)}))return true;return false})()`);
async function findMark(command) {
  await until(async () => (await inspect()).marks.some(mark => mark.command.includes(command)), `command mark ${command}`);
  return (await inspect()).marks.find(mark => mark.command.includes(command));
}
async function screenshot(name) {
  await flush(); window.webContents.invalidate();
  await fs.writeFile(`${report}.${name}.png`, (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
}

async function run() {
  await app.whenReady();
  ipcMain.on('command-marks-fixture:call', (event, method, args) => { if (event.sender === window.webContents) metrics.calls.push({ method, args, at: Date.now() }); });
  window = new BrowserWindow({ show: false, width: 1050, height: 720, webPreferences: {
    preload: path.join(__dirname, 'terminal-command-marks-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  window.webContents.on('render-process-gone', (_event, details) => metrics.rendererErrors.push(details));
  window.webContents.on('console-message', (_event, details, message) => metrics.console.push(typeof details === 'object' ? details.message : message));
  await window.loadURL(url); window.setMenu(null); window.webContents.focus();
  await until(async () => (await inspect())?.count === 2 && calls('terminalResize').some(call => call.args[0] === 'marks-old'), 'two isolated terminal instances');
  await evaluate('void(window.__marksOriginal=window.__marksTerminals[0])');
  await evaluate('document.fonts.ready'); await flush();

  phase = 'ordinary terminal without integration';
  send('marks-old', 'PLAIN_SHELL_OUTPUT\r\n'); await until(() => bufferContains('PLAIN_SHELL_OUTPUT'), 'plain output');
  assert.equal((await inspect()).marks.length, 0);
  const plainInputs = calls('terminalInput').length;
  await key('Up', ['control']); await until(() => calls('terminalInput').length > plainInputs, 'plain shell Ctrl+Up forwarded');
  assert.equal((await inspect()).keyDecisions.findLast(event => event.type === 'keydown').result, true);
  metrics.checks.plainTerminalPassThrough = true;

  phase = 'success, failure and running commands through split OSC and UTF-8 packets';
  const copyCommand = "printf '中文\\n'; printf 'COPY_OUTPUT_ONE\\nCOPY_OUTPUT_TWO\\n'";
  const copyOutput = 'COPY_OUTPUT_ONE\r\nCOPY_OUTPUT_TWO\r\n';
  const initial = Buffer.from(completeCommand(copyCommand, copyOutput, 0) + spacer('UNTRACKED_A', 90)
    + completeCommand('false # COMMAND_FAILED', 'FAIL_OUTPUT\r\n', 7) + spacer('UNTRACKED_B', 90)
    + startCommand('sleep 10 # COMMAND_RUNNING') + 'RUNNING_OUTPUT\r\n');
  // Fragment both escape sequences and multibyte glyphs across transport packets.
  for (let offset = 0; offset < initial.length; offset += 37) send('marks-old', initial.subarray(offset, offset + 37));
  await until(async () => { const next = await inspect(); return ['success', 'error', 'running'].every(status => next.marks.some(mark => mark.status === status)); }, 'all three mark states');
  let state = await inspect(); assert.equal(state.position, 'right'); assert.equal(state.containers.length, 1);
  assert.equal(state.containers[0].position, 'right');
  assert.ok(state.marks.every(mark => mark.x >= state.terminalRect.x + state.terminalRect.width - 2), 'right overview buttons are outside terminal text');
  const success = state.marks.find(mark => mark.status === 'success'), failed = state.marks.find(mark => mark.status === 'error');
  assert.notDeepEqual([success.color, success.background], [failed.color, failed.background], 'success and failure have distinguishable styling');
  metrics.checks.statusesAndSplitOsc = true;

  phase = 'right overview jumps to an offscreen command';
  const inputsBeforeClick = calls('terminalInput').length, bottom = state.viewport;
  assert.ok(success.line < bottom, 'the successful command is outside the visible scrollback viewport');
  await nativeClick(markSelector(success.id));
  await until(async () => (await inspect()).viewport === success.line, 'overview click reaches the command start');
  assert.equal(calls('terminalInput').length, inputsBeforeClick); metrics.checks.rightOverviewJump = true;

  phase = 'right-click copies exact command and only its output';
  await nativeClick(markSelector(success.id), 'right'); await menuClick('复制命令');
  await until(() => calls('writeClipboard').length === 1, 'command copied to isolated clipboard');
  assert.equal(calls('writeClipboard')[0].args[0], copyCommand);
  await nativeClick(markSelector(success.id), 'right'); await menuClick('复制输出');
  await until(() => calls('writeClipboard').length === 2, 'output copied to isolated clipboard');
  assert.equal(calls('writeClipboard')[1].args[0].replaceAll('\r\n', '\n').trimEnd(), copyOutput.replaceAll('\r\n', '\n').trimEnd());
  assert.equal(calls('terminalInput').length, inputsBeforeClick); metrics.checks.copyCommandAndOutput = true;

  phase = 'native previous and next command navigation';
  await key('Down', ['control']); await until(async () => (await inspect()).viewport > success.line, 'Ctrl+Down reaches a later command');
  const navigated = (await inspect()).viewport;
  await key('Up', ['control']); await until(async () => (await inspect()).viewport < navigated, 'Ctrl+Up reaches an earlier command');
  assert.equal((await inspect()).keyDecisions.findLast(event => event.type === 'keydown').result, false);
  assert.equal(calls('terminalInput').length, inputsBeforeClick); metrics.checks.nativeCommandNavigation = true;

  phase = 'left gutter and hidden marks preserve the terminal and scrollback';
  await patchSettings({ commandMarks: 'left' });
  state = await inspect(); assert.equal(state.containers[0].position, 'left'); assert.ok(state.marks.length > 0);
  assert.ok(state.marks.every(mark => mark.line >= state.viewport && mark.line < state.viewport + state.rows), 'left gutter contains only visible command starts');
  assert.ok(state.marks.every(mark => mark.x + mark.width <= state.terminalRect.x + 2), 'left gutter buttons are outside terminal text');
  await screenshot('left');
  await patchSettings({ commandMarks: 'hidden' }); state = await inspect();
  assert.equal(state.marks.length, 0); assert.equal(state.containers.length, 0); assert.equal(state.sameTerminal, true); assert.equal(state.count, 2);
  assert.equal(await bufferContains('COPY_OUTPUT_ONE'), true);
  await patchSettings({ commandMarks: 'right' });
  await until(async () => (await inspect()).marks.some(mark => mark.id === success.id), 'marks return after hiding');
  assert.equal((await inspect()).sameTerminal, true); metrics.checks.positionChangesPreserveTerminal = true;

  phase = 'hidden tab continues parsing command states';
  send('marks-old', osc(133, 'D;0'));
  await evaluate('window.__marksFixture.setActive("b")');
  await until(() => evaluate('window.__marksFixture.active==="b"'), 'background tab selected');
  send('marks-old', completeCommand('echo HIDDEN_TAB_COMMAND', 'HIDDEN_TAB_OUTPUT\r\n', 0));
  await until(() => bufferContains('HIDDEN_TAB_OUTPUT'), 'hidden output parsed');
  await evaluate('window.__marksFixture.setActive("a")'); await until(async () => (await inspect()).active === 'a', 'original tab selected');
  await findMark('HIDDEN_TAB_COMMAND'); assert.equal((await inspect()).sameTerminal, true); assert.equal((await inspect()).count, 2);
  metrics.checks.hiddenTabOutput = true;

  phase = 'Chinese wrapped commands survive resize and font changes';
  const chineseCommand = 'echo 中文长命令_' + '中文宽字符_abcd'.repeat(30);
  send('marks-old', spacer('BEFORE_WRAP', 35) + completeCommand(chineseCommand, '中文输出：保持原始字符\r\n', 0));
  const chinese = await findMark('中文长命令_'), oldCols = (await inspect()).cols;
  window.setSize(780, 700); await until(async () => (await inspect()).cols < oldCols, 'narrow terminal columns');
  await patchSettings({ fontSize: 21 }); await until(async () => (await inspect()).fontSize === 21, 'font size applied');
  await until(async () => (await inspect()).marks.some(mark => mark.id === chinese.id), 'wrapped marker retained');
  const wrapped = (await inspect()).marks.find(mark => mark.id === chinese.id);
  const wrappedText = await evaluate(`(()=>{const t=window.__marksTerminals[0],b=t.buffer.normal;return Array.from({length:40},(_,i)=>b.getLine(${wrapped.line}+i)?.translateToString(true)||'').join('')})()`);
  assert.ok(wrappedText.includes(chineseCommand), 'marker stays attached to the full logical command after reflow');
  await nativeClick(markSelector(chinese.id));
  // A command near the end cannot be placed on the first viewport row. Verify
  // its start is visible; the older offscreen command above verifies exact jumps.
  await until(async () => { const next = await inspect(), line = next.marks.find(mark => mark.id === chinese.id).line; return line >= next.viewport && line < next.viewport + next.rows; }, 'wrapped command start is visible after navigation');
  state = await inspect(); assert.equal(state.sameTerminal, true);
  metrics.resizeNavigation = { line: wrapped.line, viewport: state.viewport, base: state.base, rows: state.rows };
  assert.equal(await bufferContains('中文输出：保持原始字符'), true); metrics.checks.resizeFontAndChineseWrap = true;

  phase = 'a prompt following unbroken output retains its mark when wrapped rows collapse';
  const narrowCols = (await inspect()).cols;
  send('marks-old', spacer('BEFORE_SOFT_PROMPT', 30)
    + completeCommand('printf SOFT_WRAP_SOURCE', 'W'.repeat(narrowCols * 5 + 9), 0)
    + completeCommand('echo SOFT_PROMPT_KEEP', 'SOFT_PROMPT_RESULT\r\n', 0));
  const softPrompt = await findMark('SOFT_PROMPT_KEEP');
  window.setSize(1200, 720); await until(async () => (await inspect()).cols > narrowCols, 'wrapped rows collapse in a wider terminal');
  await flush();
  const softAfter = await findMark('SOFT_PROMPT_KEEP'); assert.equal(softAfter.id, softPrompt.id);
  const softLines = await evaluate(`(()=>{const b=window.__marksTerminals[0].buffer.normal;return [0,1].map(i=>b.getLine(${softAfter.line}+i)?.translateToString(true)||'').join('')})()`);
  assert.ok(softLines.includes('fixture$ echo SOFT_PROMPT_KEEP'), 'the surviving mark points at the prompt inside its reflowed logical line');
  await nativeClick(markSelector(softAfter.id));
  await until(async () => { const next = await inspect(), line = next.marks.find(mark => mark.id === softAfter.id)?.line; return line >= next.viewport && line < next.viewport + next.rows; }, 'soft-wrapped prompt is navigable after reflow');
  metrics.checks.softWrappedPromptSurvivesReflow = true;

  phase = 'Vim/tmux alternate screen suppresses marks and preserves remote navigation';
  const beforeAlternateIds = (await inspect()).marks.map(mark => mark.id).sort();
  send('marks-old', '\x1b[?1049h\x1b[?1003h\x1b[?1006h' + 'ALTERNATE_SCREEN\r\n' + completeCommand('echo ALT_FAKE_COMMAND', 'ALT_FAKE_OUTPUT\r\n', 9));
  await until(async () => (await inspect()).type === 'alternate', 'alternate buffer'); await flush();
  assert.equal((await inspect()).marks.length, 0); assert.equal((await inspect()).containers.length, 0);
  const altInputs = calls('terminalInput').length; await key('Up', ['control']); await key('Down', ['control']);
  await until(() => calls('terminalInput').length >= altInputs + 2, 'alternate screen navigation forwarded');
  assert.ok((await inspect()).keyDecisions.filter(event => event.type === 'keydown').slice(-2).every(event => event.result === true));
  send('marks-old', '\x1b[?1003l\x1b[?1006l\x1b[?1049l');
  await until(async () => (await inspect()).type === 'normal' && (await inspect()).marks.length > 0, 'normal buffer markers restored');
  assert.deepEqual((await inspect()).marks.map(mark => mark.id).sort(), beforeAlternateIds); metrics.checks.alternateScreenPassThrough = true;

  phase = 'disconnect turns an unfinished command into unknown';
  send('marks-old', spacer('BEFORE_DISCONNECT', 35) + startCommand('sleep 100 # DISCONNECTED_COMMAND') + 'PENDING_COMMAND_OUTPUT\r\n');
  const pending = await findMark('DISCONNECTED_COMMAND'); assert.equal(pending.status, 'running');
  await until(() => calls('terminalAck').reduce((sum, call) => sum + call.args[1], 0) === Object.values(metrics.expectedAck).reduce((sum, bytes) => sum + bytes, 0), 'earlier ACKs flushed');
  await evaluate('window.__marksHoldCallbacks=true'); send('marks-old', 'DEFERRED_OLD_ACK\r\n');
  await until(async () => (await inspect()).pendingCallbacks === 1, 'old transport callback held');
  emit({ type: 'sessionClosed', sessionId: 'marks-old', message: 'Isolated transport interruption' });
  await until(async () => { const next = await inspect(); return next.reconnect && next.marks.some(mark => mark.id === pending.id && mark.status === 'unknown'); }, 'pending command becomes unknown');
  metrics.checks.disconnectPendingUnknown = true;

  phase = 'replacement transport cannot complete a command from the old session';
  await evaluate('window.__marksFixture.setConnection({id:"marks-new",disconnected:false,reconnecting:false})');
  await until(async () => (await inspect()).connection.id === 'marks-new' && !(await inspect()).reconnect, 'new transport installed');
  send('marks-new', osc(133, 'D;0'));
  send('marks-old', completeCommand('echo STALE_OLD_COMMAND', 'STALE_OLD_OUTPUT\r\n', 0), false);
  await flush(); state = await inspect();
  assert.equal(state.marks.find(mark => mark.id === pending.id)?.status, 'unknown');
  assert.equal(await bufferContains('STALE_OLD_OUTPUT'), false); assert.equal(state.sameTerminal, true);
  send('marks-new', spacer('AFTER_RECONNECT', 30) + completeCommand('echo NEW_SESSION_COMMAND', 'NEW_SESSION_OUTPUT\r\n', 0));
  assert.equal((await findMark('NEW_SESSION_COMMAND')).status, 'success');
  const newInputs = calls('terminalInput').length; await key('R', ['control']);
  await until(() => calls('terminalInput').length > newInputs, 'replacement terminal input');
  assert.deepEqual(calls('terminalInput').at(-1).args, ['marks-new', '\x12']); metrics.checks.reconnectIsolation = true;

  phase = 'ACK callbacks retain their original transport after replacement';
  await evaluate('window.__marksHoldCallbacks=false;window.__marksDeferredCallbacks.splice(0).forEach(callback=>callback())');
  const acked = () => Object.fromEntries(Object.keys(metrics.expectedAck).map(id => [id, calls('terminalAck').filter(call => call.args[0] === id).reduce((sum, call) => sum + call.args[1], 0)]));
  await until(() => Object.entries(metrics.expectedAck).every(([id, bytes]) => acked()[id] === bytes), 'all original and new transport bytes acknowledged exactly');
  metrics.ackedBeforeTrim = acked(); metrics.checks.acknowledgements = true;

  phase = 'long output evicts old command markers together with scrollback';
  const oldIds = (await inspect()).marks.map(mark => mark.id);
  send('marks-new', spacer('LONG_SCROLLBACK', 10_400));
  await until(() => bufferContains('LONG_SCROLLBACK_10399'), 'long output parsed', 15_000); await flush();
  state = await inspect(); assert.ok(state.length <= 10_000 + state.rows);
  assert.ok(state.marks.every(mark => !oldIds.includes(mark.id)), 'disposed scrollback markers do not remain in overview');
  assert.equal(state.marks.length, 0); assert.equal(await bufferContains('COPY_OUTPUT_ONE'), false);
  send('marks-new', completeCommand('echo AFTER_TRIM_COMMAND', 'AFTER_TRIM_OUTPUT\r\n', 0));
  assert.equal((await findMark('AFTER_TRIM_COMMAND')).status, 'success'); metrics.checks.scrollbackEvictsMarks = true;

  phase = 'one thousand commands and large output keep the overview and input responsive';
  const stress = Array.from({ length: 1000 }, (_, index) => completeCommand(`echo STRESS_COMMAND_${String(index).padStart(4, '0')}`,
    `STRESS_OUTPUT_${index}\r\n${'x'.repeat(64)}\r\n`, 0)).join('') + spacer('STRESS_TAIL', 3000);
  await evaluate('window.__marksStressGaps=[];window.__marksStressLast=performance.now();window.__marksStressTimer=setInterval(()=>{const now=performance.now();window.__marksStressGaps.push(now-window.__marksStressLast);window.__marksStressLast=now;},16)');
  const stressStarted = Date.now(), stressInputs = calls('terminalInput').length, stressBytes = send('marks-new', stress);
  await key('R', ['control']);
  await until(() => calls('terminalInput').length > stressInputs, 'remote input delivered during command/output load', 15_000);
  const stressInput = calls('terminalInput').at(-1); assert.deepEqual(stressInput.args, ['marks-new', '\x12']);
  await until(() => bufferContains('STRESS_TAIL_2999'), 'stress output parsed', 15_000);
  await until(() => calls('terminalAck').some(call => call.args[0] === 'marks-new' && call.args[1] === stressBytes && call.at >= stressStarted), 'stress output acknowledged', 15_000);
  const stressAck = calls('terminalAck').find(call => call.args[0] === 'marks-new' && call.args[1] === stressBytes && call.at >= stressStarted);
  const lastStress = await findMark('STRESS_COMMAND_0999'); state = await inspect();
  const liveButtons = await evaluate(`document.querySelectorAll(${JSON.stringify(scope + ' button[data-command-mark]')}).length`);
  assert.ok(liveButtons > 0 && liveButtons <= Math.ceil(state.terminalRect.height / 6) + 2, 'overview DOM grows with screen height, not command count');
  const timing = await evaluate('(()=>{clearInterval(window.__marksStressTimer);const gaps=window.__marksStressGaps;return {maxFrameGapMs:Math.max(0,...gaps),samples:gaps.length}})()');
  metrics.stress = { commands: 1000, trailingOutputLines: 3000, bytes: stressBytes, visibleButtons: liveButtons,
    ackMs: stressAck.at - stressStarted, inputMs: stressInput.at - stressStarted, ...timing };
  assert.ok(metrics.stress.inputMs < 5000, 'the terminal still forwards input promptly under load');
  await nativeClick(markSelector(lastStress.id)); await until(async () => (await inspect()).viewport === lastStress.line, 'last stress command can still be located');
  metrics.checks.boundedOverviewUnderLoad = true;

  phase = 'queued command completion is parsed before the same-task disconnect boundary';
  // Separate these commands enough to retain independent overview buckets even
  // with the 10,000-line history from the previous scenario.
  send('marks-new', spacer('BEFORE_QUEUED_COMPLETE', 240) + prepareCommand('echo QUEUED_DONE_COMMAND'));
  await until(() => bufferContains('QUEUED_DONE_COMMAND'), 'queued completion prompt already parsed');
  outputAndClose('marks-new', osc(133, 'C') + 'QUEUED_DONE_OUTPUT\r\n' + osc(133, 'D;0'));
  await until(async () => { const next = await inspect(); return next.reconnect && next.marks.some(mark => mark.command.includes('QUEUED_DONE_COMMAND') && mark.status === 'success'); }, 'queued D retains the successful exit before disconnect');
  const queuedSuccess = (await inspect()).marks.find(mark => mark.command.includes('QUEUED_DONE_COMMAND'));
  metrics.checks.queuedCompletionPreserved = true;

  phase = 'queued command without a completion becomes unknown at the same-task disconnect';
  await evaluate('window.__marksFixture.setConnection({id:"marks-queued",disconnected:false,reconnecting:false})');
  await until(async () => (await inspect()).connection.id === 'marks-queued' && !(await inspect()).reconnect, 'transport for queued running command');
  send('marks-queued', spacer('BEFORE_QUEUED_RUNNING', 240) + prepareCommand('sleep 100 # QUEUED_RUNNING_COMMAND'));
  await until(() => bufferContains('QUEUED_RUNNING_COMMAND'), 'queued running prompt already parsed');
  outputAndClose('marks-queued', osc(133, 'C') + 'QUEUED_RUNNING_OUTPUT\r\n');
  await until(async () => { const next = await inspect(); return next.reconnect && next.marks.some(mark => mark.command.includes('QUEUED_RUNNING_COMMAND') && mark.status === 'unknown'); }, 'queued C without D becomes unknown after disconnect');
  assert.equal((await inspect()).marks.find(mark => mark.id === queuedSuccess.id)?.status, 'success', 'later disconnect does not relabel a completed old command');
  metrics.checks.queuedRunningUnknown = true;

  await until(() => Object.entries(metrics.expectedAck).every(([id, bytes]) => acked()[id] === bytes), 'final byte acknowledgements');
  metrics.acked = acked(); await screenshot('right'); metrics.final = await inspect();
  assert.equal(metrics.final.sameTerminal, true); assert.equal(metrics.final.count, 2); assert.ok(metrics.final.renderCount > 0);
  assert.deepEqual(metrics.rendererErrors, []); metrics.success = true;
}

run().catch(async error => {
  metrics.success = false; metrics.phase = phase; metrics.error = error.stack || String(error);
  if (window && !window.isDestroyed()) try { metrics.screen = await inspect(); await screenshot('failure'); } catch {}
}).finally(async () => {
  clearInterval(progressTimer);
  metrics.elapsedMs = Date.now() - started;
  // Keep reports readable while retaining full byte totals and the most recent calls.
  metrics.callCounts = Object.fromEntries([...new Set(metrics.calls.map(call => call.method))].map(method => [method, calls(method).length]));
  metrics.calls = metrics.calls.slice(-20);
  await finishRendererFixture(app, report, metrics);
});
