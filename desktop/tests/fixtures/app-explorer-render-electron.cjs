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
// macOS reserves Control-click for the context menu; additive selection uses
// Command-click there, matching Finder and FilePane's metaKey handling.
const selectionModifier = process.platform === 'darwin' ? 'meta' : 'control';
const pane = side => `.file-pane[data-side="${side}"]`;
const row = (path, side = 'remote') => `${pane(side)} [data-file-path=${JSON.stringify(path)}]`;
const visible = selector => `Boolean([...document.querySelectorAll(${JSON.stringify(selector)})].find(value => value.getClientRects().length > 0))`;
const nativePoint = point => { const zoom = window.webContents.getZoomFactor(); return { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) }; };
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
  const inputPoint = nativePoint(point);
  window.webContents.sendInputEvent({ type: 'mouseMove', ...inputPoint });
  window.webContents.sendInputEvent({ type: 'mouseDown', ...inputPoint, button, clickCount: 1, modifiers });
  window.webContents.sendInputEvent({ type: 'mouseUp', ...inputPoint, button, clickCount: 1, modifiers });
  await delay(50);
}
async function context(selector) { await mouse(selector, 'right'); await until(() => evaluate(visible('.context-menu')), 'file context menu'); }
async function blankClick(side, button = 'left') {
  // Keep the hit inside the genuinely empty part of the list, below its table.
  const point = await evaluate(`(() => { const wrap = document.querySelector(${JSON.stringify(pane(side) + ' .file-table-wrap')}); wrap.scrollTop = 0; const bounds = wrap.getBoundingClientRect(); return { x: Math.round(bounds.x + bounds.width / 3), y: Math.round(bounds.bottom - 6) }; })()`);
  assert.equal(await evaluate(`Boolean(document.elementFromPoint(${point.x}, ${point.y})?.closest('[data-file-path]'))`), false, 'blank-area fixture must not click a row');
  assert.equal(await evaluate(`Boolean(document.elementFromPoint(${point.x}, ${point.y})?.closest(${JSON.stringify(pane(side) + ' .file-table-wrap')}))`), true, 'blank-area native hit must be inside the file list');
  const inputPoint = nativePoint(point);
  window.webContents.sendInputEvent({ type: 'mouseMove', ...inputPoint });
  await delay(40);
  for (const type of ['mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, ...inputPoint, button, clickCount: 1 });
  if (button === 'right') await until(() => evaluate(visible('.context-menu')), 'blank context menu');
  else await delay(50);
}
async function blankContext(side) { await blankClick(side, 'right'); }
async function createFromMenu(side, label) { await blankContext(side); await click(label, '.context-menu'); }
const transferRow = id => `.transfer-row[data-transfer-id=${JSON.stringify(id)}]`;
async function addTransfer(id, state = 'transferring') {
  await evaluate(`(() => { const transfer = { ...${fixture}.transfers[0], id: ${JSON.stringify(id)}, name: ${JSON.stringify(id)}, state: ${JSON.stringify(state)}, mode: 'direct', done: 1024, total: 11264, bytesPerSecond: 1024 }; ${fixture}.transfers.push(transfer); ${fixture}.emit({ type: 'transfer', transfer: { ...transfer } }); })()`);
  await until(() => evaluate(visible(transferRow(id))), 'transfer row ' + id);
}
const noDialog = () => until(() => evaluate('!document.querySelector("[role=dialog]")'), 'dialog closed');
const activeSession = () => evaluate(`document.querySelector('[data-terminal-session][data-active="true"]')?.dataset.terminalSession || ''`);
const mutationCalls = method => evaluate(`${fixture}.calls.filter(call => call.method === ${JSON.stringify(method)})`);
async function submitName(value) { await fill('#file-new-name', value); await evaluate(`document.getElementById('file-name-form').requestSubmit()`); await noDialog(); }
async function host(letter) { await evaluate(`(() => { const button = [...document.querySelectorAll('.host')].find(value => value.textContent.includes(${JSON.stringify('测试服务器 ' + letter)})); button.click(); })()`); await until(() => evaluate(`document.querySelector('[data-terminal-session][data-active="true"]')?.dataset.terminalSession.includes(${JSON.stringify('fixture-' + letter.toLowerCase())})`), 'active server ' + letter); }
async function pathIs(path) { await until(() => evaluate(`document.querySelector('[aria-label="远程目录路径"]').value === ${JSON.stringify(path)}`), 'remote path ' + path); }
async function assertSort(side, label, direction, files) {
  const name = side === 'remote' ? '远程' : '本地';
  const state = await evaluate(`(() => { const pane = document.querySelector(${JSON.stringify(pane(side))}); return { names: [...pane.querySelectorAll('tbody .file-name')].map(cell => cell.title), headers: [...pane.querySelectorAll('th')].map(header => ({ label: header.querySelector('button').getAttribute('aria-label'), sort: header.getAttribute('aria-sort'), up: !!header.querySelector('.lucide-arrow-up'), down: !!header.querySelector('.lucide-arrow-down') })) }; })()`);
  assert.deepEqual([...state.names.slice(0, 2)].sort(), ['docs', 'locked'], 'folders stay above files: ' + label + ' ' + direction);
  assert.deepEqual(state.names.slice(2), files, side + ' ' + label + ' ' + direction);
  for (const header of state.headers) {
    const active = header.label === name + '按' + label + '排序';
    assert.equal(header.sort, active ? direction : 'none', header.label + ' aria-sort');
    assert.equal(header.up, active && direction === 'ascending', header.label + ' up arrow');
    assert.equal(header.down, active && direction === 'descending', header.label + ' down arrow');
  }
}
async function run() {
  await app.whenReady();
  const smallDisplay = process.env.GOOESHELL_EXPLORER_SMALL_DISPLAY === '1';
  window = new BrowserWindow({ show: false, width: smallDisplay ? 1024 : 1510, height: smallDisplay ? 768 : 1050, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', (...args) => { const details = args[0], message = typeof args[2] === 'string' ? args[2] : details.message, level = typeof args[1] === 'number' ? args[1] : details.level; if (level >= 3 || level === 'error') result.errors.push(message); });
  window.webContents.on('render-process-gone', (_event, detail) => result.errors.push(JSON.stringify(detail)));
  await window.loadURL(url);
  // Windows hosted runners may clamp the native window to a 1024px display.
  // Keep the intended full-column CSS viewport without overriding app styles;
  // native mouse coordinates above still target the actual scaled controls.
  const viewport = await evaluate('({width:innerWidth,height:innerHeight})');
  window.webContents.setZoomFactor(Math.min(1, viewport.width / 1510, viewport.height / 950));
  await until(() => evaluate('innerWidth >= 1400 && innerHeight >= 900'), 'full explorer test viewport');
  result.viewport = await evaluate('({width:innerWidth,height:innerHeight})');
  await until(() => evaluate(`document.querySelectorAll('.host').length === 2`), 'fixture hosts');
  await host('A'); const sessionA = await activeSession(); await click('展开文件管理'); await pathIs('/home/a');
  // More vertical room makes the blank-area native pointer test independent of platform font metrics.
  await evaluate(`document.getElementById('file-manager').style.height = '550px'`);
  phase = 'column sorting and direction arrows';
  await until(() => evaluate(visible(row('/home/a/alpha.txt'))), 'initial files');
  assert.equal(await evaluate(`Boolean(document.querySelector('.file-actions-toolbar, .file-selection-bar'))`), false);
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(pane('remote') + ' .file-pane-toolbar [aria-label="跟随终端目录"]')}).length`), 1);
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(pane('local') + ' [aria-label="跟随终端目录"]')}).length`), 0);
  result.checks.minimalFileControlsKeepFollow = true;
  await mouse(row('/home/a/alpha.txt'));
  for (const label of ['名称', '大小', '权限', '修改时间']) {
    const ascending = label === '名称' ? ['alpha.txt', 'beta.txt'] : ['beta.txt', 'alpha.txt'];
    if (label !== '名称') await mouse(`[aria-label="远程按${label}排序"]`);
    await assertSort('remote', label, 'ascending', ascending);
    await mouse(`[aria-label="远程按${label}排序"]`);
    await assertSort('remote', label, 'descending', [...ascending].reverse());
    assert.deepEqual(await evaluate(`[...document.querySelectorAll(${JSON.stringify(pane('remote') + ' [aria-selected="true"]')})].map(value => value.dataset.filePath)`), ['/home/a/alpha.txt']);
  }
  result.checks.remoteColumnsSortWithArrows = true;
  phase = 'pane sort independence and persistence';
  await click('展开本地文件栏');
  await until(() => evaluate(visible(row('C:\\Fixture\\alpha.txt', 'local'))), 'initial local files');
  await assertSort('local', '名称', 'ascending', ['alpha.txt', 'beta.txt']);
  await mouse('[aria-label="本地按大小排序"]');
  await assertSort('local', '大小', 'ascending', ['beta.txt', 'alpha.txt']);
  await assertSort('remote', '修改时间', 'descending', ['alpha.txt', 'beta.txt']);
  await click('刷新目录', pane('remote'));
  await assertSort('remote', '修改时间', 'descending', ['alpha.txt', 'beta.txt']);
  await mouse(row('/home/a/alpha.txt'));
  await click('收起远程文件栏'); await click('展开远程文件栏');
  await assertSort('remote', '修改时间', 'descending', ['alpha.txt', 'beta.txt']);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row('/home/a/alpha.txt'))}).getAttribute('aria-selected')`), 'true');
  await assertSort('local', '大小', 'ascending', ['beta.txt', 'alpha.txt']);
  const sortingImage = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await fs.writeFile(report + '.sorting.png', sortingImage.toPNG());
  result.checks.paneSortingIsIndependentAndPersists = true;
  await mouse('[aria-label="远程按名称排序"]'); await mouse('[aria-label="本地按名称排序"]');
  phase = 'blank list clicks deselect without affecting rows or headers';
  assert.equal(await evaluate(`Boolean(document.querySelector('.file-actions-toolbar, .file-selection-bar'))`), false);
  for (const side of ['local', 'remote']) {
    const base = side === 'local' ? 'C:\\Fixture\\' : '/home/a/', name = side === 'local' ? '本地' : '远程';
    const selectedRows = () => evaluate(`document.querySelectorAll(${JSON.stringify(pane(side) + ' [data-file-path][aria-selected="true"]')}).length`);
    await mouse(row(base + 'alpha.txt', side) + ' .file-symbol');
    await mouse(row(base + 'beta.txt', side), 'left', [selectionModifier]);
    assert.equal(await selectedRows(), 2, side + ' row icons and multiselection');
    await mouse(`[aria-label="${name}按名称排序"]`);
    assert.equal(await selectedRows(), 2, side + ' sorting preserves selection');
    const scrollSelection = await evaluate(`(() => { const wrap = document.querySelector(${JSON.stringify(pane(side) + ' .file-table-wrap')}); const oldOverflow = wrap.style.overflowY; wrap.style.overflowY = 'scroll'; const bounds = wrap.getBoundingClientRect(); const gutter = wrap.offsetWidth - wrap.clientWidth; if (gutter > 0) wrap.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: bounds.left + wrap.clientLeft + wrap.clientWidth + gutter / 2, clientY: bounds.top + 40 })); wrap.style.overflowY = oldOverflow; return gutter; })()`);
    if (scrollSelection > 0) assert.equal(await selectedRows(), 2, side + ' scrollbar preserves selection');
    await blankClick(side);
    assert.equal(await selectedRows(), 0, side + ' blank click clears selection');
    await mouse(row(base + 'alpha.txt', side), 'left', ['shift']);
    assert.equal(await selectedRows(), 1, side + ' blank click resets shift selection anchor');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(pane(side))}).textContent.includes('项已选')`), false);
    await blankClick(side);
  }
  result.checks.blankListClickClearsSelection = true;
  await blankClick('remote'); await click('收起本地文件栏');
  phase = 'remote blank context creates files and folders';
  await createFromMenu('remote', '新建文件'); await submitName('created.txt'); await until(() => evaluate(visible(row('/home/a/created.txt'))), 'created remote file');
  await createFromMenu('remote', '新建文件夹'); await submitName('created-dir'); await until(() => evaluate(visible(row('/home/a/created-dir'))), 'created remote folder');
  const created = (await mutationCalls('createFile'))[0].request;
  assert.equal(created.sessionId, sessionA); assert.equal(created.path, '/home/a/created.txt'); assert.equal(created.side, 'remote');
  result.checks.remoteContextCreatesFileAndFolder = true;

  phase = 'existing file creation fails without replacement';
  const existing = await evaluate(`${fixture}.entry(${JSON.stringify(sessionA)}, '/home/a/created.txt')`);
  await createFromMenu('remote', '新建文件'); await fill('#file-new-name', 'created.txt'); await evaluate(`document.getElementById('file-name-form').requestSubmit()`);
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
  assert.equal(await evaluate(`Boolean(document.querySelector('.file-selection-bar'))`), false);
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
  await mouse(row('/home/a/docs')); await mouse(row('/home/a/alpha.txt'), 'left', [selectionModifier]);
  await context(row('/home/a/docs')); await click('删除', '.context-menu');
  const deletionText = await evaluate(`document.querySelector('[role=dialog]').textContent`);
  assert.match(deletionText, /\/home\/a\/docs/); assert.match(deletionText, /\/home\/a\/alpha\.txt/);
  await click('确认删除', '[role=dialog]'); await noDialog();
  await until(() => evaluate(`!document.querySelector(${JSON.stringify(row('/home/a/docs'))}) && !document.querySelector(${JSON.stringify(row('/home/a/alpha.txt'))})`), 'multi deletion list refreshed');
  const removed = await mutationCalls('removeFile'); assert.equal(removed.length, 2); assert.equal(removed.find(call => call.request.path.endsWith('/docs')).request.recursive, true);
  assert.equal(await evaluate(`${fixture}.entries(${JSON.stringify(sessionA)}).includes('/home/a/docs/nested.txt')`), false);
  result.checks.multiDeleteIncludesFolderContents = true;

  phase = 'local parity';
  await click('展开本地文件栏'); await createFromMenu('local', '新建文件'); await submitName('local.txt'); await until(() => evaluate(visible(row('C:\\Fixture\\local.txt', 'local'))), 'local file created');
  await createFromMenu('local', '新建文件夹'); await submitName('local-dir'); await until(() => evaluate(visible(row('C:\\Fixture\\local-dir', 'local'))), 'local folder created');
  await context(row('C:\\Fixture\\local.txt', 'local')); await click('删除', '.context-menu'); await click('确认删除', '[role=dialog]'); await noDialog();
  assert.equal((await mutationCalls('removeFile')).at(-1).request.side, 'local');
  result.checks.localActionsMatchRemote = true;

  phase = 'sudo retry retains original server and directory';
  await evaluate(`${fixture}.denyNext = 'mkdir'`); await createFromMenu('remote', '新建文件夹'); await fill('#file-new-name', 'sudo-dir'); await evaluate(`document.getElementById('file-name-form').requestSubmit()`);
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
  await mouse(row('/home/a/beta.txt')); await mouse(row('/home/a/blank.txt'), 'left', [selectionModifier]);
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

  phase = 'transfer choice cancellation and ordinary download';
  await context(row('C:\\Fixture\\alpha.txt', 'local')); await click('上传到远程目录', '.context-menu');
  await until(() => evaluate(`Boolean(document.querySelector('.transfer-dialog'))`), 'transfer choice');
  assert.equal(await evaluate(`document.querySelector('input[name="transfer-mode"]:checked').value`), 'direct');
  await mouse('input[name="transfer-mode"][value="archive"]'); await click('取消', '.transfer-dialog'); await noDialog();
  assert.equal((await mutationCalls('transfer')).length, 0);
  result.checks.transferChoiceCancellationDoesNotStart = true;
  await context(row('/home/a/renamed.txt')); await click('下载到本地目录', '.context-menu');
  await click('开始下载', '.transfer-dialog'); await noDialog();
  const ordinary = (await mutationCalls('transfer')).at(-1).request;
  assert.deepEqual(ordinary, { sessionId: sessionA, direction: 'download', source: '/home/a/renamed.txt', destinationDir: 'C:\\Fixture', mode: 'direct', resume: true });
  result.checks.ordinaryTransferRemainsAvailable = true;

  phase = 'packed multi-selection retains its original server and destination';
  await mouse(row('C:\\Fixture\\docs', 'local')); await mouse(row('C:\\Fixture\\alpha.txt', 'local'), 'left', [selectionModifier]);
  await context(row('C:\\Fixture\\docs', 'local')); await click('上传到远程目录', '.context-menu'); await mouse('input[name="transfer-mode"][value="archive"]');
  await until(() => evaluate(`document.querySelector('input[name="transfer-mode"]:checked').value === 'archive'`), 'archive option selected');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.transfer-source-list li')].map(item => item.textContent)`), ['C:\\Fixture\\docs', 'C:\\Fixture\\alpha.txt']);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const transferImage = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await fs.writeFile(report + '.transfer.png', transferImage.toPNG());
  await host('B'); await pathIs('/home/b');
  await click('开始上传', '.transfer-dialog'); await noDialog();
  await until(async () => (await mutationCalls('transfer')).length === 3, 'two packed items queued');
  const packed = (await mutationCalls('transfer')).slice(1).map(call => call.request);
  assert.deepEqual(packed.map(request => request.source), ['C:\\Fixture\\docs', 'C:\\Fixture\\alpha.txt']);
  assert.ok(packed.every(request => request.sessionId === sessionA && request.destinationDir === '/home/a' && request.direction === 'upload' && request.mode === 'archive' && request.resume === false));
  result.checks.packedTransferKeepsOriginalTarget = true;

  phase = 'native picker captures target before the picker resolves';
  await host('A'); await pathIs('/home/a');
  await evaluate(`${fixture}.chosenFiles = ['C:\\\\Fixture\\\\picked.txt']; ${fixture}.holdNext = 'chooseFiles'`);
  await click('选择文件上传'); await until(() => evaluate(`${fixture}.held`), 'held native file picker');
  await host('B'); await pathIs('/home/b'); await evaluate(`${fixture}.release()`);
  await until(() => evaluate(`Boolean(document.querySelector('.transfer-dialog'))`), 'picker transfer dialog');
  assert.equal(await evaluate(`document.querySelector('.transfer-dialog .dialog-path').textContent`), '/home/a');
  await mouse('input[name="transfer-mode"][value="archive"]'); await click('开始上传', '.transfer-dialog'); await noDialog();
  const picked = (await mutationCalls('transfer')).at(-1).request;
  assert.equal(picked.sessionId, sessionA); assert.equal(picked.destinationDir, '/home/a'); assert.equal(picked.source, 'C:\\Fixture\\picked.txt'); assert.equal(picked.mode, 'archive');
  result.checks.uploadPickerKeepsOriginalTarget = true;

  phase = 'dragged files can choose packed transfer';
  await evaluate(`(() => { const dataTransfer = new DataTransfer(); dataTransfer.setData('application/x-gooeshell-files', JSON.stringify({ side: 'local', paths: ['C:\\\\Fixture\\\\beta.txt'] })); document.querySelector(${JSON.stringify(pane('remote'))}).dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer })); })()`);
  await until(() => evaluate(`Boolean(document.querySelector('.transfer-dialog'))`), 'drag transfer dialog');
  await mouse('input[name="transfer-mode"][value="archive"]'); await click('开始上传', '.transfer-dialog'); await noDialog();
  const dropped = (await mutationCalls('transfer')).at(-1).request;
  assert.equal(dropped.sessionId, sessionB); assert.equal(dropped.destinationDir, '/home/b'); assert.equal(dropped.source, 'C:\\Fixture\\beta.txt'); assert.equal(dropped.mode, 'archive');
  result.checks.draggedTransferOffersCompression = true;

  phase = 'remote drag retains its source server when another tab becomes active';
  const remoteDrag = await evaluate(`(() => { const dataTransfer = new DataTransfer(); document.querySelector(${JSON.stringify(row('/home/b/alpha.txt'))}).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer })); return dataTransfer.getData('application/x-gooeshell-files'); })()`);
  assert.equal(JSON.parse(remoteDrag).sessionId, sessionB);
  await host('A'); await pathIs('/home/a');
  await evaluate(`(() => { const dataTransfer = new DataTransfer(); dataTransfer.setData('application/x-gooeshell-files', ${JSON.stringify(remoteDrag)}); document.querySelector(${JSON.stringify(pane('local'))}).dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer })); })()`);
  await until(() => evaluate(`Boolean(document.querySelector('.transfer-dialog'))`), 'remote drag transfer dialog');
  await mouse('input[name="transfer-mode"][value="archive"]'); await click('开始下载', '.transfer-dialog'); await noDialog();
  const draggedDownload = (await mutationCalls('transfer')).at(-1).request;
  assert.deepEqual(draggedDownload, { sessionId: sessionB, direction: 'download', source: '/home/b/alpha.txt', destinationDir: 'C:\\Fixture', mode: 'archive', resume: false });
  result.checks.remoteDragKeepsOriginalSession = true;

  phase = 'packing and extraction remain active with cancellation and correct retry mode';
  const queuedIds = await evaluate(`${fixture}.transfers.map(transfer => transfer.id)`);
  for (const id of queuedIds) await evaluate(`${fixture}.transferState(${JSON.stringify(id)}, 'completed', 100, 100)`);
  const archiveId = queuedIds[1];
  await evaluate(`${fixture}.transferState(${JSON.stringify(archiveId)}, 'packing', 25, 100)`);
  await until(() => evaluate(`document.querySelector('.transfer-status.packing')?.textContent === '打包压缩中'`), 'packing state');
  assert.equal(await evaluate(`document.querySelector('.transfer-header .badge').textContent`), '1');
  assert.equal(await evaluate(`document.querySelector('.transfer-status.packing').parentElement.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')`), '25');
  await click('取消传输', '.transfer-row:has(.transfer-status.packing)');
  assert.equal((await mutationCalls('cancelTransfer')).at(-1).request.id, archiveId);
  await click('重新打包传输', '.transfer-row:has(.transfer-status.cancelled)');
  const retried = (await mutationCalls('transfer')).at(-1).request;
  assert.deepEqual(retried, packed[0]);
  const retryId = await evaluate(`${fixture}.transfers.at(-1).id`);
  await evaluate(`${fixture}.transferState(${JSON.stringify(retryId)}, 'extracting')`);
  await until(() => evaluate(`document.querySelector('.transfer-status.extracting')?.textContent === '自动解压中'`), 'extracting state');
  assert.equal(await evaluate(`document.querySelector('.transfer-header .badge').textContent`), '1');
  assert.equal(await evaluate(`document.querySelector('.transfer-status.extracting').parentElement.querySelector('[role="progressbar"]').hasAttribute('aria-valuenow')`), false);
  await click('取消传输', '.transfer-row:has(.transfer-status.extracting)');
  assert.equal((await mutationCalls('cancelTransfer')).at(-1).request.id, retryId);
  result.checks.packedStagesCanCancelAndRetry = true;

  phase = 'transfer speed and remaining time update together';
  const metricsId = 'fixture-metrics-transfer';
  await addTransfer(metricsId);
  const metricText = className => evaluate(`document.querySelector(${JSON.stringify(transferRow(metricsId) + ' .' + className)})?.textContent.trim() || ''`);
  await until(async () => (await metricText('transfer-speed')) === '1.0 KB/s', 'initial live speed');
  assert.match(await metricText('transfer-eta'), /10\s*秒/);
  assert.equal(await evaluate(`(() => { const metrics = document.querySelector(${JSON.stringify(transferRow(metricsId) + ' .transfer-metrics')}); return !!metrics?.querySelector('.transfer-speed') && !!metrics?.querySelector('.transfer-eta'); })()`), true);
  await evaluate(`(() => { const transfer = ${fixture}.transfers.find(item => item.id === ${JSON.stringify(metricsId)}); transfer.bytesPerSecond = 2 * 1024 * 1024; ${fixture}.transferState(transfer.id, 'transferring', 2 * 1024 * 1024, 12 * 1024 * 1024); })()`);
  await until(async () => (await metricText('transfer-speed')) === '2.0 MB/s', 'updated live speed');
  assert.match(await metricText('transfer-eta'), /5\s*秒/);
  await evaluate(`document.querySelector(${JSON.stringify(transferRow(metricsId))}).scrollIntoView({ block: 'nearest' })`);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const metricsImage = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await fs.writeFile(report + '.transfer-metrics.png', metricsImage.toPNG());
  for (const state of ['checking', 'packing', 'extracting', 'completed', 'failed', 'cancelled', 'queued']) {
    // Keep the last rate in the event deliberately: stage changes must hide stale telemetry.
    await evaluate(`${fixture}.transferState(${JSON.stringify(metricsId)}, ${JSON.stringify(state)}, 1024, 11264)`);
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(transferRow(metricsId) + ' .transfer-status.' + state)}))`), 'telemetry stage ' + state);
    await until(async () => !(await metricText('transfer-speed')) && !(await metricText('transfer-eta')), 'no stale speed or remaining time in ' + state);
  }
  await evaluate(`${fixture}.transferState(${JSON.stringify(metricsId)}, 'completed', 11264, 11264)`);
  result.checks.transferSpeedAndEtaStayCurrent = true;

  phase = 'verification progress uses checked bytes instead of completed transfer bytes';
  const setVerification = async (verification, mode = 'direct', state = 'checking') => {
    await evaluate(`(() => { const transfer = ${fixture}.transfers.find(item => item.id === ${JSON.stringify(metricsId)}); transfer.verification = ${JSON.stringify(verification) ?? 'undefined'}; transfer.mode = ${JSON.stringify(mode)}; ${fixture}.transferState(transfer.id, ${JSON.stringify(state)}, 11264, 11264); })()`);
  };
  const verificationProgress = () => evaluate(`(() => { const bar = document.querySelector(${JSON.stringify(transferRow(metricsId) + ' [role="progressbar"]')}); return { value: bar.getAttribute('aria-valuenow'), indeterminate: bar.classList.contains('indeterminate'), width: bar.firstElementChild.style.width }; })()`);
  await setVerification({ stage: 'final', method: 'sha256', done: 256, total: 1024 });
  await until(async () => (await metricText('transfer-status')) === '校验文件', 'final verification state');
  assert.equal(await metricText('transfer-detail'), '已校验 256 B / 1.0 KB');
  assert.equal(await metricText('transfer-verification-percent'), '25%');
  assert.deepEqual(await verificationProgress(), { value: '25', indeterminate: false, width: '25%' });
  assert.equal(await metricText('transfer-speed'), ''); assert.equal(await metricText('transfer-eta'), '');
  await setVerification({ stage: 'resume', method: 'readback', done: 1024, total: 2048 });
  await until(async () => (await metricText('transfer-status')) === '校验已有内容', 'resume verification state');
  assert.equal(await metricText('transfer-detail'), '已校验 1.0 KB / 2.0 KB');
  assert.equal(await metricText('transfer-verification-percent'), '50%');
  assert.deepEqual(await verificationProgress(), { value: '50', indeterminate: false, width: '50%' });
  result.checks.verificationUsesIndependentProgress = true;

  await setVerification(undefined);
  await until(async () => (await metricText('transfer-status')) === '检查文件中', 'check without byte progress');
  assert.equal(await metricText('transfer-detail'), '正在检查文件');
  assert.equal(await metricText('transfer-verification-percent'), '');
  assert.deepEqual(await verificationProgress(), { value: null, indeterminate: true, width: '40%' });
  result.checks.preparingDoesNotShowCompletedTransferProgress = true;

  await setVerification({ stage: 'final', method: 'sha256', done: 3072, total: 4096 }, 'archive');
  await until(async () => (await metricText('transfer-verification-percent')) === '75%', 'archive verification progress');
  assert.equal(await metricText('transfer-detail'), '已校验 3.0 KB / 4.0 KB');
  assert.equal(await metricText('transfer-status'), '校验文件');
  assert.deepEqual(await verificationProgress(), { value: '75', indeterminate: false, width: '75%' });
  for (const state of ['transferring', 'extracting', 'completed', 'failed', 'cancelled']) {
    await evaluate(`${fixture}.transferState(${JSON.stringify(metricsId)}, ${JSON.stringify(state)}, 11264, 11264)`);
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(transferRow(metricsId) + ' .transfer-status.' + state)}))`), 'stale verification in ' + state);
    assert.equal(await metricText('transfer-verification-percent'), '');
    assert.doesNotMatch(await metricText('transfer-detail'), /已校验/);
  }
  await setVerification(undefined, 'direct', 'completed');
  result.checks.archiveVerificationAndStageChangesStayCurrent = true;

  phase = 'task context menu stops work and deletes only queue entries';
  const removesBeforeTaskActions = (await mutationCalls('removeFile')).length;
  await evaluate(`document.querySelectorAll('.toast-stack button').forEach(button => button.click())`);
  const stoppedId = 'fixture-force-stop-transfer';
  await addTransfer(stoppedId);
  await context(transferRow(stoppedId)); await click('强制停止', '.context-menu');
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(transferRow(stoppedId) + ' .transfer-status.cancelled')}))`), 'force stop state');
  assert.equal((await mutationCalls('cancelTransfer')).at(-1).request.id, stoppedId);
  result.checks.transferTaskMenuStopsWork = true;

  const deletedId = 'fixture-delete-active-transfer';
  await addTransfer(deletedId);
  await evaluate(`${fixture}.holdNext = 'cancelTransfer'`);
  await context(transferRow(deletedId)); await click('删除任务', '.context-menu');
  await until(() => evaluate(`${fixture}.held`), 'active task cancellation before deletion');
  assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(transferRow(deletedId))}))`), true, 'row remains until cancellation succeeds');
  assert.equal((await mutationCalls('cancelTransfer')).at(-1).request.id, deletedId);
  await evaluate(`${fixture}.release()`);
  await until(() => evaluate(`!document.querySelector(${JSON.stringify(transferRow(deletedId))})`), 'active task deleted after cancellation');
  await evaluate(`${fixture}.transferState(${JSON.stringify(deletedId)}, 'transferring', 2048, 11264)`);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(transferRow(deletedId))}))`), false, 'late progress cannot restore a deleted task');
  result.checks.deletingActiveTaskWaitsForStop = true;

  await evaluate(`${fixture}.transferState(${JSON.stringify(stoppedId)}, 'failed', 1024, 11264)`);
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(transferRow(stoppedId) + ' .transfer-status.failed')}))`), 'failed task');
  await evaluate(`document.querySelectorAll('.toast-stack button').forEach(button => button.click())`);
  const cancelsBeforeFailedDelete = (await mutationCalls('cancelTransfer')).length;
  await context(transferRow(stoppedId)); await click('删除任务', '.context-menu');
  await until(() => evaluate(`!document.querySelector(${JSON.stringify(transferRow(stoppedId))})`), 'failed task removed');
  assert.equal((await mutationCalls('cancelTransfer')).length, cancelsBeforeFailedDelete);
  assert.equal((await mutationCalls('removeFile')).length, removesBeforeTaskActions, 'task controls must not delete source or destination files');
  result.checks.deletingFailedTaskOnlyRemovesQueueEntry = true;

  phase = 'failed cancellation keeps a task visible and allows retry';
  const rejectedId = 'fixture-delete-rejected-transfer';
  await addTransfer(rejectedId);
  await evaluate(`${fixture}.denyNext = 'cancelTransfer'`);
  await context(transferRow(rejectedId)); await click('删除任务', '.context-menu');
  await until(() => evaluate(`document.querySelector('.toast-stack .toast.error')?.textContent.includes('fixture cancel failed')`), 'cancellation failure is shown');
  assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(transferRow(rejectedId) + ' .transfer-status.transferring')}))`), true, 'failed cancellation must preserve the running row');
  await evaluate(`${fixture}.transferState(${JSON.stringify(rejectedId)}, 'transferring', 4096, 11264)`);
  await until(() => evaluate(`document.querySelector(${JSON.stringify(transferRow(rejectedId) + ' [role="progressbar"]')})?.getAttribute('aria-valuenow') === '36'`), 'failed deletion still accepts progress');
  await evaluate(`document.querySelectorAll('.toast-stack button').forEach(button => button.click())`);
  await context(transferRow(rejectedId)); await click('删除任务', '.context-menu');
  await until(() => evaluate(`!document.querySelector(${JSON.stringify(transferRow(rejectedId))})`), 'retry deletion succeeds');
  assert.equal((await mutationCalls('cancelTransfer')).filter(call => call.request.id === rejectedId).length, 2);
  assert.equal((await mutationCalls('removeFile')).length, removesBeforeTaskActions);
  result.checks.failedTaskCancellationKeepsRow = true;
  await click('收起传输队列');

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
  const transfersBeforeDisconnect = (await mutationCalls('transfer')).length;
  await click('选择文件上传'); await until(() => evaluate(`Boolean(document.querySelector('.transfer-dialog'))`), 'pending transfer before disconnect');
  await evaluate(`${fixture}.emit({ type: 'sessionClosed', sessionId: ${JSON.stringify(sessionA)}, message: 'fixture disconnected' })`);
  await until(() => evaluate(`document.querySelector('[aria-label="跟随终端目录"]').disabled`), 'disabled remote actions');
  assert.equal(await evaluate(`document.querySelector('button[form="transfer-form"]').disabled`), true);
  assert.match(await evaluate(`document.querySelector('.transfer-dialog [role="alert"]').textContent`), /连接已关闭/);
  await click('取消', '.transfer-dialog'); await noDialog();
  assert.equal((await mutationCalls('transfer')).length, transfersBeforeDisconnect);
  result.checks.pendingTransferStopsWhenDisconnected = true;
  for (const label of ['选择文件上传', '跟随终端目录']) assert.equal(await evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').disabled`), true);
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
