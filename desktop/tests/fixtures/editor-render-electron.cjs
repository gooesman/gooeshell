const { app, BrowserWindow, ipcMain } = require('electron');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const url = process.env.GOOESHELL_EDITOR_RENDER_URL;
const reportFile = process.env.GOOESHELL_EDITOR_RENDER_REPORT;
const userData = process.env.GOOESHELL_EDITOR_RENDER_DATA;
if (!url || new URL(url).hostname !== '127.0.0.1' || !reportFile || !userData) {
  throw new Error('Explicit isolated fixture paths and a loopback URL are required');
}
app.setPath('userData', userData);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const revision = number => `v1:${String(number).padStart(64, '0')}`;
const backend = { text: 'alpha one\nbeta two\n', revision: revision(1), reads: [], writes: [], copies: [], editorStates: [], conflict: false, delayWrite: false, pendingWrite: null };
const metrics = { checks: {}, rendererErrors: [], console: [] };
const started = Date.now();
let window, phase = 'initialization';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => window.webContents.executeJavaScript(code);
async function until(predicate, label, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}
const inspect = () => evaluate(`(() => ({
  text: [...document.querySelectorAll('.cm-editor:not(.cm-mergeView-editor) .cm-content .cm-line')].map(node => node.textContent).join('\\n'),
  body: document.body.innerText,
  open: document.getElementById('fixture-state').dataset.open,
  saved: Number(document.getElementById('fixture-state').dataset.saved),
  buttons: [...document.querySelectorAll('button')].map(button => ({text:button.textContent.trim(),title:button.title,label:button.getAttribute('aria-label'),disabled:button.disabled})),
  inputs: [...document.querySelectorAll('input,select')].map(input => ({name:input.name,aria:input.getAttribute('aria-label'),placeholder:input.placeholder,value:input.value})),
}))()`);
async function key(keyCode, modifiers = []) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(25);
}
const modifier = process.platform === 'darwin' ? 'meta' : 'control';
async function replaceEditor(text) {
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await key('A', [modifier]);
  await window.webContents.insertText(text);
  await until(async () => (await inspect()).text.includes(text.trimEnd()), 'editor input');
}
async function button(label) {
  await until(() => evaluate(`Boolean([...document.querySelectorAll('button')].find(button =>
    !button.disabled && (button.getAttribute('aria-label') === ${JSON.stringify(label)} || button.title === ${JSON.stringify(label)} || button.textContent.trim() === ${JSON.stringify(label)})))`), 'button ' + label);
  const point = await evaluate(`(() => {
    const label = ${JSON.stringify(label)};
    const button = [...document.querySelectorAll('button')].find(button =>
      !button.disabled && (button.getAttribute('aria-label') === label || button.title === label || button.textContent.trim() === label));
    if (!button) throw new Error('No enabled button: ' + label);
    const bounds = button.getBoundingClientRect();
    return {x:Math.round(bounds.x + bounds.width / 2),y:Math.round(bounds.y + bounds.height / 2)};
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  await delay(25);
}
async function fill(selector, text) {
  await evaluate(`(() => {const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw new Error('Missing input');input.focus()})()`);
  await key('A', [modifier]);
  await window.webContents.insertText(text);
  // insertText is paste-like and has no keyup. The native search panel commits
  // input on keyup/change; an ordinary navigation key mirrors finishing typing.
  await key('End');
}
async function screenshot(label) {
  window.webContents.invalidate();
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  window.webContents.invalidate();
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const picture = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  const size = picture.getSize();
  const center = [...picture.crop({ x: Math.floor(size.width / 2), y: Math.floor(size.height / 2), width: 1, height: 1 }).toBitmap()];
  metrics.visuals ??= {};
  metrics.visuals[label] = { center, theme: await evaluate('document.documentElement.dataset.theme') };
  await fs.writeFile(reportFile + '.' + label + '.png', picture.toPNG());
  if (label === 'light-disconnected') assert.ok(center.slice(0, 3).every(channel => channel > 235), 'the latest light editor must actually paint a white background');
}

async function run() {
  await app.whenReady();
  ipcMain.handle('editor-fixture:call', (event, method, request) => {
    assert.equal(event.sender, window.webContents);
    if (method === 'editorState') { backend.editorStates.push(request); return; }
    if (method === 'saveTextCopy') { backend.copies.push(request); return '/fixture/local-draft.sh'; }
    assert.equal(request.path, '/home/fixture/deploy.sh', 'the original file remains the target');
    assert.equal(request.sessionId, 'original-session', 'switching terminal tabs must never retarget an editor');
    assert.equal(request.side, 'remote');
    if (method === 'readTextFile') {
      backend.reads.push(request);
      return { text: backend.text, truncated: false, encoding: 'utf8', lineEnding: 'lf', revision: backend.revision, size: Buffer.byteLength(backend.text), bom: false };
    }
    if (method === 'writeTextFile') {
      backend.writes.push(request);
      const commit = () => {
        if (backend.conflict || request.expectedRevision !== backend.revision) {
          throw new Error('TEXT_CONFLICT：远程文件已被其他程序修改，请比较最新版本后重试。');
        }
        backend.text = request.text;
        backend.revision = revision(backend.writes.length + 1);
        return { revision: backend.revision, size: Buffer.byteLength(request.text) };
      };
      if (backend.delayWrite) return new Promise((resolve, reject) => {
        backend.pendingWrite = () => { backend.pendingWrite = null; try { resolve(commit()); } catch (error) { reject(error); } };
      });
      return commit();
    }
    throw new Error('Unexpected fixture method: ' + method);
  });
  window = new BrowserWindow({
    show: false, width: 1200, height: 820,
    webPreferences: { preload: path.resolve('tests/fixtures/editor-render-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  window.webContents.on('render-process-gone', (_event, details) => metrics.rendererErrors.push(details));
  window.webContents.on('console-message', (_event, details, message) => metrics.console.push(typeof details === 'object' ? details.message : message));
  phase = 'mount actual built-in editor';
  await window.loadURL(url);
  await until(async () => (await inspect()).text.includes('alpha one'), phase, 20_000);
  assert.equal(backend.reads.length, 1);
  window.webContents.focus();
  await screenshot('initial');

  phase = 'undo and redo preserve content';
  await replaceEditor('alpha changed\nbeta changed\n');
  await key('Z', [modifier]);
  await until(async () => (await inspect()).text.includes('alpha one'), 'undo');
  await key(process.platform === 'darwin' ? 'Z' : 'Y', process.platform === 'darwin' ? [modifier, 'shift'] : [modifier]);
  await until(async () => (await inspect()).text.includes('alpha changed'), 'redo');
  metrics.checks.undoRedo = true;

  phase = 'save using keyboard';
  await key('S', [modifier]);
  await until(async () => backend.writes.length === 1 && (await inspect()).saved === 1, phase);
  assert.equal(backend.writes[0].expectedRevision, revision(1));
  assert.match(backend.text, /alpha changed/);
  metrics.checks.keyboardSave = true;

  phase = 'find and replace in actual CodeMirror search panel';
  await button('替换');
  await until(() => evaluate(`Boolean(document.querySelector('input[name="search"]'))`), 'search panel');
  await fill('input[name="search"]', 'changed');
  await fill('input[name="replace"]', 'replaced');
  await evaluate(`(() => {const button=document.querySelector('.cm-search button[name="replaceAll"]');if(!button)throw new Error('Replace-all button is missing');button.click()})()`);
  await until(async () => { const { text } = await inspect(); return text.includes('alpha replaced') && text.includes('beta replaced') && !text.includes('changed'); }, 'replace all');
  metrics.checks.findReplace = true;
  await key('Escape');

  phase = 'save after active terminal changes';
  await evaluate(`window.editorFixture.setActiveSession('another-session')`);
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await key('S', [modifier]);
  await until(async () => backend.writes.length === 2 && (await inspect()).saved === 2, phase);
  assert.equal(backend.writes[1].sessionId, 'original-session');
  assert.equal(backend.writes[1].expectedRevision, revision(2));
  metrics.checks.originalConnection = true;

  phase = 'cancel closing an unsaved document';
  const draft = '保持本地修改\nalpha draft\nbeta draft\n';
  await replaceEditor(draft);
  metrics.beforeUnsavedClose = await inspect();
  metrics.beforeUnsavedClose.editorStates = backend.editorStates.slice(-5);
  await button('关闭编辑器');
  await button('继续编辑');
  assert.equal((await inspect()).open, 'true');
  assert.ok((await inspect()).text.includes('保持本地修改'));
  assert.equal(backend.editorStates.at(-1)?.dirty, true, 'the native close guard receives the unsaved document state');
  metrics.checks.unsavedClose = true;

  phase = 'conflict preserves local draft';
  backend.text = 'updated on server\n';
  backend.revision = revision(9);
  backend.conflict = true;
  await evaluate(`document.querySelector('.cm-content').focus()`);
  await key('S', [modifier]);
  await until(() => backend.writes.length === 3, 'conflicting save reaches server');
  await until(async () => /冲突|其他程序|最新版本/.test((await inspect()).body), 'conflict feedback');
  assert.ok((await inspect()).text.includes('保持本地修改'));
  assert.equal((await inspect()).saved, 2);
  assert.equal(backend.text, 'updated on server\n');
  metrics.checks.conflictPreservesDraft = true;
  await screenshot('conflict');

  phase = 'comparison checks again if the server changes a second time';
  await button('查看最新版本');
  await until(async () => (await inspect()).text.includes('updated on server'), 'latest file comparison');
  backend.conflict = false;
  backend.text = 'second update on server\n';
  backend.revision = revision(10);
  await button('以当前内容覆盖此版本');
  await until(() => backend.writes.length === 4, 'comparison save');
  assert.equal(backend.writes[3].expectedRevision, revision(9), 'overwrite still targets only the version reviewed by the user');
  await until(async () => /最新版本/.test((await inspect()).body), 'second conflict feedback');
  assert.equal(backend.text, 'second update on server\n');
  assert.equal((await inspect()).saved, 2);
  await button('查看最新版本');
  await until(async () => (await inspect()).text.includes('second update on server'), 'refresh comparison content');
  assert.ok((await inspect()).text.includes('保持本地修改'));
  await button('取消比较');
  metrics.checks.comparisonRechecksVersion = true;

  phase = 'disconnect preserves draft and prevents remote saves';
  await evaluate(`window.editorFixture.setDisconnected(true)`);
  await until(async () => /断开/.test((await inspect()).body), 'disconnect feedback');
  assert.ok((await inspect()).text.includes('保持本地修改'));
  await key('S', [modifier]);
  assert.equal(backend.writes.length, 4);
  metrics.checks.disconnectPreservesDraft = true;

  phase = 'save a local copy while disconnected';
  await button('另存到本地');
  await until(() => backend.copies.length === 1, phase);
  assert.match(backend.copies[0].text, /保持本地修改/);
  assert.match(backend.copies[0].name, /deploy/);
  assert.equal(backend.writes.length, 4);
  metrics.checks.localCopy = true;

  phase = 'light theme keeps the unsaved document';
  await evaluate(`window.editorFixture.setTheme('light')`);
  await delay(100);
  assert.ok((await inspect()).text.includes('保持本地修改'));
  await screenshot('light-disconnected');

  phase = 'discard closes the document without writing';
  await button('关闭编辑器');
  await button('放弃修改');
  await until(async () => (await inspect()).open === 'false', phase);
  await until(() => backend.editorStates.at(-1)?.dirty === false, 'clear native close guard after closing');
  assert.equal(backend.writes.length, 4);

  phase = 'editing while a slow save is pending retains the newer draft';
  await evaluate(`window.editorFixture.setDisconnected(false);window.editorFixture.setOpen(true)`);
  await until(async () => (await inspect()).text.includes('second update on server'), 'reopen document');
  backend.delayWrite = true;
  await replaceEditor('first pending snapshot\n');
  await key('S', [modifier]);
  await until(() => backend.writes.length === 5 && backend.pendingWrite, 'deferred save');
  await replaceEditor('newer draft during save\n');
  await key('End');
  backend.pendingWrite();
  await until(async () => (await inspect()).saved === 3, 'deferred save completion');
  assert.equal(backend.text, 'first pending snapshot\n');
  assert.ok((await inspect()).text.includes('newer draft during save'));
  await until(() => backend.editorStates.at(-1)?.dirty === true && backend.editorStates.at(-1)?.busy === false, 'newer draft remains unsaved');
  assert.equal((await inspect()).open, 'true');
  metrics.checks.pendingSavePreservesNewEdits = true;

  phase = 'save-and-close never discards edits made during the save';
  await button('关闭编辑器');
  await button('保存并关闭');
  await until(() => backend.writes.length === 6 && backend.pendingWrite, 'deferred save and close');
  await replaceEditor('even newer draft during save and close\n');
  await key('End');
  backend.pendingWrite();
  await until(async () => (await inspect()).saved === 4, 'save and close completion');
  assert.equal(backend.text, 'newer draft during save\n');
  assert.equal((await inspect()).open, 'true');
  assert.ok((await inspect()).text.includes('even newer draft during save and close'));
  await until(() => backend.editorStates.at(-1)?.dirty === true && backend.editorStates.at(-1)?.busy === false, 'save and close preserves newer draft');
  metrics.checks.pendingSaveAndClosePreservesNewEdits = true;

  phase = 'language and indentation changes preserve the document and undo history';
  const json = '{"message":"中文","enabled":true}\n';
  await replaceEditor(json);
  await key('End');
  await evaluate(`(() => {
    for (const [label,value] of [['语法模式','json'],['缩进','4']]) {
      const select=document.querySelector('select[aria-label="'+label+'"]');
      select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));
    }
  })()`);
  await button('格式化 JSON');
  await until(async () => (await inspect()).text.includes('    "message": "中文"'), 'format using four-space indentation');
  await button('撤销');
  await until(async () => (await inspect()).text === json, 'format is a single undo step');
  assert.equal(backend.writes.length, 6);
  await replaceEditor('{"invalid": }\n');
  await button('格式化 JSON');
  await until(async () => (await inspect()).body.includes('JSON 格式有误'), 'invalid JSON feedback');
  assert.equal((await inspect()).text, '{"invalid": }\n');
  metrics.checks.jsonFormattingAndUndo = true;
  await button('关闭编辑器');
  await button('放弃修改');
  await until(async () => (await inspect()).open === 'false', 'finish second document');
  assert.equal(metrics.rendererErrors.length, 0);
  metrics.success = true;
}

run().catch(async error => {
  metrics.success = false; metrics.error = error.stack || String(error); metrics.phase = phase;
  if (window && !window.isDestroyed()) {
    try { metrics.screen = await inspect(); await screenshot('failure'); } catch {}
  }
}).finally(async () => {
  metrics.elapsedMs = Date.now() - started;
  metrics.calls = { reads: backend.reads, writes: backend.writes, copies: backend.copies };
  if (window && !window.isDestroyed()) window.destroy();
  await fs.writeFile(reportFile, JSON.stringify(metrics, null, 2));
  app.exit(metrics.success ? 0 : 1);
});
