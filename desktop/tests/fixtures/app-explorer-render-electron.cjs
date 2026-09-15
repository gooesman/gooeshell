const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const url = process.env.GOOESHELL_APP_EXPLORER_URL, report = process.env.GOOESHELL_APP_EXPLORER_REPORT;
if (!url || new URL(url).hostname !== '127.0.0.1' || !report || !process.env.GOOESHELL_APP_EXPLORER_DATA) throw new Error('An isolated loopback fixture and data directory are required');
app.setPath('userData', process.env.GOOESHELL_APP_EXPLORER_DATA);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const result = { checks: {}, errors: [] };
let window, phase = 'startup';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = script => window.webContents.executeJavaScript(script);
const fixture = 'window.appExplorerFixture';
const pane = side => `.file-pane[data-side="${side}"]`;
const row = (path, side = 'remote') => `${pane(side)} [data-file-path=${JSON.stringify(path)}]`;
const visible = selector => `Boolean([...document.querySelectorAll(${JSON.stringify(selector)})].find(value => value.getClientRects().length > 0))`;
async function until(predicate, label) { const end = Date.now() + 10_000; while (!(await predicate())) { if (Date.now() > end) throw new Error('Timed out: ' + label); await delay(30); } }
async function click(label, scope = 'body') {
  const match = `(() => [...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(button => !button.disabled && button.getClientRects().length && (button.getAttribute('aria-label') === ${JSON.stringify(label)} || button.title === ${JSON.stringify(label)} || button.textContent.trim().replace(/(?:…|\\.{3})$/, '') === ${JSON.stringify(label)} || (${JSON.stringify(label)} === '删除' && button.textContent.trim().startsWith('删除')))))()`;
  await until(() => evaluate(`Boolean(${match})`), label); await evaluate(`${match}.click()`); await delay(40);
}
async function fill(selector, text) { await evaluate(`(() => { const value = document.querySelector(${JSON.stringify(selector)}); value.focus(); value.select(); })()`); await window.webContents.insertText(text); await delay(35); }
async function mouse(selector, button = 'left', modifiers = []) {
  await until(() => evaluate(visible(selector)), selector);
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'nearest' })`);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const point = await evaluate(`(() => { const target = document.querySelector(${JSON.stringify(selector)}), bounds = target.getBoundingClientRect(), x = Math.round(bounds.x + bounds.width / 2), y = Math.round(bounds.y + bounds.height / 2), hit = document.elementFromPoint(x, y); return { x, y, visible: bounds.width > 0 && bounds.height > 0 && (target === hit || target.contains(hit)) }; })()`);
  assert.equal(point.visible, true, 'unobstructed native mouse target: ' + selector);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button, clickCount: 1, modifiers });
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button, clickCount: 1, modifiers });
  await delay(50);
}
async function context(selector) { await mouse(selector, 'right'); await until(() => evaluate(visible('.context-menu')), 'file context menu'); }
async function blankContext(side) {
  // Keep the hit inside the genuinely empty part of the list, below its table.
  const point = await evaluate(`(() => { const wrap = document.querySelector(${JSON.stringify(pane(side) + ' .file-table-wrap')}); wrap.scrollTop = 0; const bounds = wrap.getBoundingClientRect(); return { x: Math.round(bounds.x + bounds.width / 3), y: Math.round(bounds.bottom - 6) }; })()`);
  assert.equal(await evaluate(`Boolean(document.elementFromPoint(${point.x}, ${point.y})?.closest('[data-file-path]'))`), false, 'blank-area fixture must not click a row');
  assert.equal(await evaluate(`Boolean(document.elementFromPoint(${point.x}, ${point.y})?.closest(${JSON.stringify(pane(side) + ' .file-table-wrap')}))`), true, 'blank-area native hit must be inside the file list');
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  await delay(40);
  for (const type of ['mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, ...point, button: 'right', clickCount: 1 });
  await until(() => evaluate(visible('.context-menu')), 'blank context menu');
}
const noDialog = () => until(() => evaluate('!document.querySelector("[role=dialog]")'), 'dialog closed');
const activeSession = () => evaluate(`document.querySelector('[data-terminal-session][data-active="true"]')?.dataset.terminalSession || ''`);
const mutationCalls = method => evaluate(`${fixture}.calls.filter(call => call.method === ${JSON.stringify(method)})`);
async function submitName(value) { await fill('#file-new-name', value); await evaluate(`document.getElementById('file-name-form').requestSubmit()`); await noDialog(); }
async function host(letter) { await evaluate(`(() => { const button = [...document.querySelectorAll('.host')].find(value => value.textContent.includes(${JSON.stringify('测试服务器 ' + letter)})); button.click(); })()`); await until(() => evaluate(`document.querySelector('[data-terminal-session][data-active="true"]')?.dataset.terminalSession.includes(${JSON.stringify('fixture-' + letter.toLowerCase())})`), 'active server ' + letter); }
async function pathIs(path) { await until(() => evaluate(`document.querySelector('[aria-label="远程目录路径"]').value === ${JSON.stringify(path)}`), 'remote path ' + path); }
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 1510, height: 1050, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', (...args) => { const details = args[0], message = typeof args[2] === 'string' ? args[2] : details.message, level = typeof args[1] === 'number' ? args[1] : details.level; if (level >= 3 || level === 'error') result.errors.push(message); });
  window.webContents.on('render-process-gone', (_event, detail) => result.errors.push(JSON.stringify(detail)));
  await window.loadURL(url);
  await until(() => evaluate(`document.querySelectorAll('.host').length === 2`), 'fixture hosts');
  await host('A'); const sessionA = await activeSession(); await click('展开文件管理'); await pathIs('/home/a');
  // More vertical room makes the blank-area native pointer test independent of platform font metrics.
  await evaluate(`document.getElementById('file-manager').style.height = '550px'`);
  phase = 'remote toolbar create';
  await click('远程新建文件'); await submitName('created.txt'); await until(() => evaluate(visible(row('/home/a/created.txt'))), 'created remote file');
  await click('远程新建文件夹'); await submitName('created-dir'); await until(() => evaluate(visible(row('/home/a/created-dir'))), 'created remote folder');
  const created = (await mutationCalls('createFile'))[0].request;
  assert.equal(created.sessionId, sessionA); assert.equal(created.path, '/home/a/created.txt'); assert.equal(created.side, 'remote');
  result.checks.remoteToolbarCreatesFileAndFolder = true;

  phase = 'existing file creation fails without replacement';
  const existing = await evaluate(`${fixture}.entry(${JSON.stringify(sessionA)}, '/home/a/created.txt')`);
  await click('远程新建文件'); await fill('#file-new-name', 'created.txt'); await evaluate(`document.getElementById('file-name-form').requestSubmit()`);
  await until(() => evaluate(`document.querySelector('.file-action-dialog [role=alert]')?.textContent.includes('文件已存在')`), 'existing file error');
  assert.deepEqual(await evaluate(`${fixture}.entry(${JSON.stringify(sessionA)}, '/home/a/created.txt')`), existing);
  await click('取消', '[role=dialog]'); await noDialog(); result.checks.existingFileIsPreserved = true;

  phase = 'blank context creation';
  await blankContext('remote'); await click('新建文件', '.context-menu'); await submitName('blank.txt');
  await until(() => evaluate(visible(row('/home/a/blank.txt'))), 'blank menu creates file');
  result.checks.blankMenuCreatesFile = true;
  phase = 'stable selection and rename';
  const before = await evaluate(`document.querySelector(${JSON.stringify(row('/home/a/alpha.txt'))}).getBoundingClientRect().y`);
  await mouse(row('/home/a/alpha.txt'));
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row('/home/a/alpha.txt'))}).getBoundingClientRect().y`), before);
  result.checks.selectionDoesNotShiftRows = true;
  await context(row('/home/a/created.txt')); await click('重命名', '.context-menu'); await submitName('renamed.txt');
  const rename = (await mutationCalls('rename')).at(-1).request;
  assert.equal(rename.sessionId, sessionA); assert.equal(rename.path, '/home/a/created.txt'); assert.equal(rename.destination, '/home/a/renamed.txt');
  result.checks.renameKeepsParent = true;

  phase = 'delete cancel and multi selection';
  await context(row('/home/a/renamed.txt')); await click('删除', '.context-menu');
  await until(() => evaluate(`document.querySelector('[role=dialog]')?.textContent.includes('/home/a/renamed.txt')`), 'delete exact path');
  await click('取消', '[role=dialog]'); await noDialog(); assert.equal((await mutationCalls('removeFile')).length, 0);
  result.checks.deleteCancellationDoesNotMutate = true;
  await mouse(row('/home/a/docs')); await mouse(row('/home/a/alpha.txt'), 'left', ['control']);
  await context(row('/home/a/docs')); await click('删除', '.context-menu');
  const deletionText = await evaluate(`document.querySelector('[role=dialog]').textContent`);
  assert.match(deletionText, /\/home\/a\/docs/); assert.match(deletionText, /\/home\/a\/alpha\.txt/);
  await click('确认删除', '[role=dialog]'); await noDialog();
  await until(() => evaluate(`!document.querySelector(${JSON.stringify(row('/home/a/docs'))}) && !document.querySelector(${JSON.stringify(row('/home/a/alpha.txt'))})`), 'multi deletion list refreshed');
  const removed = await mutationCalls('removeFile'); assert.equal(removed.length, 2); assert.equal(removed.find(call => call.request.path.endsWith('/docs')).request.recursive, true);
  assert.equal(await evaluate(`${fixture}.entries(${JSON.stringify(sessionA)}).includes('/home/a/docs/nested.txt')`), false);
  result.checks.multiDeleteIncludesFolderContents = true;

  phase = 'local parity';
  await click('展开本地文件栏'); await click('本地新建文件'); await submitName('local.txt'); await until(() => evaluate(visible(row('C:\\Fixture\\local.txt', 'local'))), 'local file created');
  await click('本地新建文件夹'); await submitName('local-dir'); await until(() => evaluate(visible(row('C:\\Fixture\\local-dir', 'local'))), 'local folder created');
  await context(row('C:\\Fixture\\local.txt', 'local')); await click('删除', '.context-menu'); await click('确认删除', '[role=dialog]'); await noDialog();
  assert.equal((await mutationCalls('removeFile')).at(-1).request.side, 'local');
  result.checks.localActionsMatchRemote = true;

  phase = 'sudo retry retains original server and directory';
  await evaluate(`${fixture}.denyNext = 'mkdir'`); await click('远程新建文件夹'); await fill('#file-new-name', 'sudo-dir'); await evaluate(`document.getElementById('file-name-form').requestSubmit()`);
  await until(() => evaluate(`Boolean(document.getElementById('sudo-password'))`), 'sudo prompt');
  // Simulate a tab activation from outside the blocked file dialog; operation targets must remain immutable.
  await host('B'); const sessionB = await activeSession(); await pathIs('/home/b');
  await fill('#sudo-password', 'fixture-only-password'); await click('使用 sudo 执行', '[role=dialog]'); await noDialog();
  const retries = (await mutationCalls('mkdir')).filter(call => call.request.path.endsWith('/sudo-dir'));
  assert.equal(retries.length, 2); assert.ok(retries.every(call => call.request.sessionId === sessionA && call.request.path === '/home/a/sudo-dir')); assert.equal(retries[1].request.elevated, true);
  await pathIs('/home/b'); result.checks.pendingSudoKeepsOriginalTarget = true;

  phase = 'partially completed deletion retries only remaining entries';
  await host('A'); await pathIs('/home/a');
  const deletesBeforePartial = (await mutationCalls('removeFile')).length;
  await evaluate(`${fixture}.denyNext = 'removeFile'; ${fixture}.denyPath = '/home/a/blank.txt'`);
  await mouse(row('/home/a/beta.txt')); await mouse(row('/home/a/blank.txt'), 'left', ['control']);
  await context(row('/home/a/beta.txt')); await click('删除', '.context-menu'); await click('确认删除', '[role=dialog]');
  await until(() => evaluate(`Boolean(document.getElementById('sudo-password'))`), 'partial deletion sudo prompt');
  assert.equal(await evaluate(`${fixture}.entries(${JSON.stringify(sessionA)}).includes('/home/a/beta.txt')`), false);
  assert.equal(await evaluate(`${fixture}.entries(${JSON.stringify(sessionA)}).includes('/home/a/blank.txt')`), true);
  assert.match(await evaluate(`document.querySelector('.file-action-dialog').textContent`), /已删除/);
  await fill('#sudo-password', 'fixture-only-password'); await click('使用 sudo 执行', '[role=dialog]'); await noDialog();
  const partial = (await mutationCalls('removeFile')).slice(deletesBeforePartial);
  assert.equal(partial.filter(call => call.request.path === '/home/a/beta.txt').length, 1);
  assert.equal(partial.filter(call => call.request.path === '/home/a/blank.txt').length, 2);
  assert.equal(partial.at(-1).request.elevated, true); result.checks.partialDeletionSudoSkipsCompleted = true;

  phase = 'per terminal directory tracking';
  await host('A'); await pathIs('/home/a');
  await evaluate(`${fixture}.cwd[${JSON.stringify(sessionA)}] = '/home/a/locked'`); await click('跟随终端目录'); await pathIs('/home/a/locked');
  assert.equal(await evaluate(`document.querySelector('[aria-label="跟随终端目录"]').getAttribute('aria-pressed')`), 'true');
  await host('B'); await pathIs('/home/b');
  assert.equal(await evaluate(`document.querySelector('[aria-label="跟随终端目录"]').getAttribute('aria-pressed')`), 'false');
  await evaluate(`${fixture}.cwd[${JSON.stringify(sessionB)}] = '/home/b/docs'`); await delay(1250); await pathIs('/home/b');
  await click('跟随终端目录'); await pathIs('/home/b/docs'); await host('A'); await pathIs('/home/a/locked');
  assert.equal(await evaluate(`document.querySelector('[aria-label="跟随终端目录"]').getAttribute('aria-pressed')`), 'true');
  result.checks.directoryTrackingIsPerTerminal = true;
  phase = 'manual navigation pauses directory tracking';
  await fill('[aria-label="远程目录路径"]', '/home/a');
  await evaluate(`document.querySelector('[aria-label="远程目录路径"]').form.requestSubmit()`); await pathIs('/home/a');
  assert.equal(await evaluate(`document.querySelector('[aria-label="跟随终端目录"]').getAttribute('aria-pressed')`), 'false');
  await evaluate(`${fixture}.cwd[${JSON.stringify(sessionA)}] = '/home/a/created-dir'`); await delay(2200); await pathIs('/home/a');
  result.checks.manualNavigationPausesFollowing = true;
  phase = 'hidden file manager suspends directory polling';
  await click('跟随终端目录'); await pathIs('/home/a/created-dir'); await click('收起文件管理');
  await until(() => evaluate(`document.getElementById('file-manager').hidden`), 'file manager hidden');
  await delay(100); const polls = (await mutationCalls('terminalCwd')).length; await delay(2200);
  assert.equal((await mutationCalls('terminalCwd')).length, polls); await click('展开文件管理'); await pathIs('/home/a/created-dir');
  result.checks.hiddenExplorerStopsPolling = true;
  phase = 'closed session actions';
  await evaluate(`${fixture}.emit({ type: 'sessionClosed', sessionId: ${JSON.stringify(sessionA)}, message: 'fixture disconnected' })`);
  await until(() => evaluate(`document.querySelector('[aria-label="远程新建文件"]').disabled`), 'disabled remote actions');
  for (const label of ['远程新建文件', '远程新建文件夹', '跟随终端目录']) assert.equal(await evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').disabled`), true);
  result.checks.closedSessionDisablesActions = true;
  await host('B'); await pathIs('/home/b/docs');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await fs.writeFile(report + '.explorer.png', image.toPNG());
  result.success = true;
}
run().catch(error => { result.success = false; result.failure = { phase, message: error.message, stack: error.stack }; }).finally(async () => {
  if (!result.success && window && !window.isDestroyed()) { try { const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await fs.writeFile(report + '.failure.png', image.toPNG()); } catch {} }
  await fs.writeFile(report, JSON.stringify(result, null, 2)); app.exit(result.success ? 0 : 1);
});
