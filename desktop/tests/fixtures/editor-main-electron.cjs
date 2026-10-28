const { app, BrowserWindow, dialog } = require('electron');
const { Worker } = require('node:worker_threads');
const { promises: fs, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');

const artifacts = process.env.GOOESHELL_EDITOR_MAIN_ARTIFACTS;
if (!artifacts || !path.isAbsolute(artifacts) || !path.basename(artifacts).startsWith('editor-main-')) throw new Error('Explicit isolated editor fixture directory required');
const userData = path.join(artifacts, 'user-data');
const downloads = path.join(artifacts, 'downloads');
mkdirSync(userData, { recursive: true });
mkdirSync(downloads, { recursive: true });
app.setPath('userData', userData);
app.setPath('downloads', downloads);
const syncedText = '# Synced external draft';
const seeded = ['A', 'B'].map(name => {
  const id = randomUUID(), folder = path.join(userData, 'external-editor', id), fileName = 'edit-notes.md';
  const checksum = createHash('sha256').update(syncedText).digest('hex');
  mkdirSync(folder, { recursive: true }); writeFileSync(path.join(folder, fileName), syncedText);
  writeFileSync(path.join(folder, 'session.json'), JSON.stringify({ id, name: 'notes.md', path: '/server-' + name + '/notes.md', fileName, connectionName: 'Server ' + name, connectionKey: 'fixture-' + name, baseRevision: 'v1:' + checksum, syncedDigest: checksum }));
  return { path: path.join(folder, fileName), folder };
});


const report = { success: false, checks: {}, dialogs: [], workerShutdowns: 0, errors: [] };
const reportPath = path.join(artifacts, 'result.json');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let window, expectedDiscard = false, closeChoice = 0;
let saveChoice = { canceled: true };
let finalDialogCount = 0;
const postMessage = Worker.prototype.postMessage;
Worker.prototype.postMessage = function(message, ...args) {
  if (message?.method === 'shutdown') report.workerShutdowns++;
  return postMessage.call(this, message, ...args);
};
dialog.showMessageBoxSync = (_window, options) => {
  report.dialogs.push({ title: options.title, type: options.type, buttons: options.buttons, detail: options.detail });
  return closeChoice;
};
dialog.showSaveDialog = async (_window, options) => {
  assert.ok(options.properties.includes('showOverwriteConfirmation'));
  assert.equal(path.dirname(options.defaultPath), downloads);
  return saveChoice;
};
function saveReport() { writeFileSync(reportPath, JSON.stringify(report, null, 2)); }
function fail(error) {
  report.errors.push(error?.stack || String(error));
  saveReport();
  app.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
const call = (method, value) => window.webContents.executeJavaScript(`window.gooeshell[${JSON.stringify(method)}](${JSON.stringify(value)})`);
async function editorState(state) {
  await call('editorState', state);
  // Invoke messages sent after editor-state form an IPC round trip, ensuring the
  // actual main state update was received before a native close is requested.
  await call('initial');
}
async function assertStillRunning() {
  await delay(450);
  assert.equal(window.isDestroyed(), false);
  assert.equal(report.workerShutdowns, 0, 'Cancel must not begin worker shutdown');
  assert.equal((await call('initial')).profiles.length, 0);
}

app.on('browser-window-created', (_event, created) => {
  window = created;
  window.on('show', () => window.hide());
  window.webContents.once('did-finish-load', () => { void run().catch(fail); });
});
app.on('window-all-closed', () => {
  if (!expectedDiscard) return fail(new Error('Window closed before discard approval'));
  setImmediate(() => {
    try {
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      assert.equal(report.workerShutdowns, 1);
      assert.equal(report.dialogs.length, finalDialogCount + 1, 'Discard confirmation should not be shown twice for beforeunload');
      report.checks.discardCloses = true;
      report.checks.workerShutdownOnlyAfterDiscard = true;
      report.success = true;
      saveReport();
      // The real main shutdown timer exits the process, not the test harness.
    } catch (error) { fail(error); }
  });
});

async function run() {
  await delay(350);
  const initialState = await call('initial');
  assert.equal(initialState.profiles.length, 0);
  assert.equal(initialState.connectionHistory.length, 0);

  assert.equal((await call('externalEdits')).length, 2, 'restored synchronized drafts exist');
  await fs.writeFile(seeded[0].path, '# Unsent local edit');
  closeChoice = 1; const externalDialogs = report.dialogs.length;
  window.close(); await assertStillRunning();
  assert.equal(report.dialogs.length, externalDialogs + 1);
  const warning = report.dialogs.at(-1);
  assert.equal(warning.title, '外部文件尚未完成回传');
  assert.ok(warning.detail.includes('Server A · /server-A/notes.md'));
  assert.ok(!warning.detail.includes('Server B'), 'clean restored file is excluded');
  closeChoice = 0; window.close(); await assertStillRunning();
  const listDeadline = Date.now() + 10000;
  while (!await window.webContents.executeJavaScript('Boolean(document.querySelector(".external-editors"))')) {
    assert.ok(Date.now() < listDeadline, 'view files must finish loading the actual list');
    await delay(25);
  }
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector(".external-editors"))'), true, 'view files opens the actual list');
  assert.ok(await window.webContents.executeJavaScript('document.querySelector(".external-editors").textContent.includes("/server-A/notes.md")'));
  await window.webContents.executeJavaScript(`document.querySelector('[role="dialog"][aria-label="外部编辑"] [aria-label="关闭"]').click()`);
  await fs.writeFile(seeded[0].path, syncedText); closeChoice = 0;
  report.checks.externalExitIdentifiesFiles = true;
  report.checks.externalExitViewList = true;
  const file = path.join(artifacts, 'original.txt');
  const initialBytes = Buffer.from('\ufeff原始\r\ncontent\n', 'utf8');
  await fs.writeFile(file, initialBytes);
  const request = { side: 'local', sessionId: '', path: file };
  const opened = await call('readTextFile', request);
  assert.equal(opened.text, '原始\r\ncontent\n');
  assert.equal(opened.encoding, 'utf8-bom');
  assert.equal(opened.bom, true);
  const saved = await call('writeTextFile', { ...request, ...opened, text: '修改\r\ncontent\n', expectedRevision: opened.revision });
  assert.equal(await fs.readFile(file, 'utf8'), '\ufeff修改\r\ncontent\n');
  assert.equal((await call('readTextFile', request)).revision, saved.revision);
  report.checks.localReadWrite = true;
  await fs.writeFile(file, 'external edit');
  await assert.rejects(call('writeTextFile', { ...request, ...opened, text: 'stale edit', expectedRevision: saved.revision }), /TEXT_CONFLICT/);
  assert.equal(await fs.readFile(file, 'utf8'), 'external edit');
  report.checks.conflictThroughIpc = true;

  const copy = path.join(downloads, 'copy.txt');
  saveChoice = { canceled: false, filePath: copy };
  assert.equal(await call('saveTextCopy', { name: 'copy.txt', text: '本地副本\r\n', encoding: 'utf16le', bom: true }), copy);
  assert.deepEqual(await fs.readFile(copy), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('本地副本\r\n', 'utf16le')]));
  report.checks.localCopy = true;
  saveChoice = { canceled: true };
  assert.equal(await call('saveTextCopy', { name: 'cancel.txt', text: 'cancelled', encoding: 'utf8' }), null);
  assert.deepEqual(await fs.readdir(downloads), ['copy.txt']);
  report.checks.cancelSaveDialog = true;
  const existing = path.join(downloads, 'existing.txt');
  await fs.writeFile(existing, 'old copy');
  saveChoice = { canceled: false, filePath: existing };
  assert.equal(await call('saveTextCopy', { name: 'existing.txt', text: 'new copy', encoding: 'utf8' }), existing);
  assert.equal(await fs.readFile(existing, 'utf8'), 'new copy');
  report.checks.overwriteCopy = true;
  await fs.writeFile(existing, 'existing UTF-8 content');
  assert.equal(await call('saveTextCopy', { name: 'existing.txt', text: '改用 UTF-16\r\n', encoding: 'utf16le', bom: true }), existing);
  assert.deepEqual(await fs.readFile(existing), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('改用 UTF-16\r\n', 'utf16le')]));
  report.checks.overwriteDifferentEncoding = true;

  await window.webContents.executeJavaScript(`window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = false; });`);
  await editorState({ dirty: true, busy: false });
  closeChoice = 0;
  window.close();
  await assertStillRunning();
  assert.equal(report.dialogs.at(-1).title, '未保存的修改');
  report.checks.closeCancelled = true;
  app.quit();
  await assertStillRunning();
  report.checks.quitCancelled = true;
  await editorState({ dirty: false, busy: true });
  closeChoice = 1;
  window.close();
  await assertStillRunning();
  assert.equal(report.dialogs.at(-1).title, '文件操作尚未完成');
  report.checks.busyBlocksClose = true;
  await editorState({ dirty: true, busy: false });
  finalDialogCount = report.dialogs.length;
  expectedDiscard = true;
  app.quit();
}

require('../../dist-main/main/main.js');
