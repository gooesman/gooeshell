const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const url = process.env.GOOESHELL_EXPLORER_PERFORMANCE_URL, report = process.env.GOOESHELL_EXPLORER_PERFORMANCE_REPORT;
if (!url || new URL(url).hostname !== '127.0.0.1' || !report || !process.env.GOOESHELL_EXPLORER_PERFORMANCE_DATA) throw new Error('An isolated loopback fixture and data directory are required');
app.setPath('userData', process.env.GOOESHELL_EXPLORER_PERFORMANCE_DATA);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const result = { checks: {}, metrics: {}, errors: [] };
let window, phase = 'startup';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = script => window.webContents.executeJavaScript(script);
const fixture = 'window.appExplorerFixture', pane = '.file-pane[data-side="remote"]', wrap = `${pane} .file-table-wrap`;
const settle = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))';
async function until(predicate, label) { const end = Date.now() + 20_000; while (!(await predicate())) { if (Date.now() > end) throw new Error('Timed out: ' + label); await delay(30); } }
async function click(label, scope = 'body') {
  const match = `(() => [...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(button => !button.disabled && button.getClientRects().length && (button.getAttribute('aria-label') === ${JSON.stringify(label)} || button.title === ${JSON.stringify(label)})))()`;
  await until(() => evaluate(`Boolean(${match})`), label); await evaluate(`${match}.click()`); await evaluate(settle);
}
async function measure(script) { return evaluate(`(async () => { const start = performance.now(), before = ${fixture}.renderSamples.length; ${script}; for (let attempt = 0; attempt < 100 && ${fixture}.renderSamples.length === before; attempt++) await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)); document.querySelector(${JSON.stringify(wrap)}).getBoundingClientRect(); return { elapsedMs: performance.now() - start, reactMs: ${fixture}.renderSamples.slice(before).reduce((a, b) => a + b, 0) }; })()`); }
async function scrollToIndex(index) {
  await evaluate(`(() => { const wrap = document.querySelector(${JSON.stringify(wrap)}); wrap.scrollTop = ${index} * 29; wrap.dispatchEvent(new Event('scroll', { bubbles: true })); })()`);
  await evaluate(settle);
}
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 1510, height: 1050, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', (...args) => { const details = args[0], message = typeof args[2] === 'string' ? args[2] : details.message, level = typeof args[1] === 'number' ? args[1] : details.level; if (level >= 3 || level === 'error') result.errors.push(message); });
  window.webContents.on('render-process-gone', (_event, detail) => result.errors.push(JSON.stringify(detail)));
  await window.loadURL(url);
  await until(() => evaluate(`document.querySelectorAll('.host').length === 2`), 'fixture hosts');
  await evaluate(`document.querySelector('.host').click()`);
  await until(() => evaluate(`Boolean(document.querySelector('[data-terminal-session][data-active="true"]'))`), 'session connected');
  const sessionId = await evaluate(`document.querySelector('[data-terminal-session][data-active="true"]').dataset.terminalSession`);
  await click('展开文件管理');
  await until(() => evaluate(`document.querySelector(${JSON.stringify(pane + ' [data-file-path]')})`), 'initial directory');
  await evaluate(`document.getElementById('file-manager').style.height = '550px'`);
  await evaluate(settle);
  phase = '10,000 item baseline and render timing';
  await evaluate(`${fixture}.populateDirectory(${JSON.stringify(sessionId)}, 10000)`);
  result.metrics.loadMs = await measure(`document.querySelector(${JSON.stringify(pane + ' [aria-label="刷新目录"]')}).click()`);
  await until(() => evaluate(`document.querySelector(${JSON.stringify(pane + ' .file-pane-footer')}).textContent.includes('10000 项')`), 'large directory');
  await evaluate(settle);
  result.metrics.domRows = await evaluate(`document.querySelectorAll(${JSON.stringify(pane + ' [data-file-path]')}).length`);
  result.metrics.domElements = await evaluate(`document.querySelector(${JSON.stringify(pane)}).querySelectorAll('*').length`);
  result.metrics.rowHeight = await evaluate(`document.querySelector(${JSON.stringify(pane + ' [data-file-path]')}).getBoundingClientRect().height`);
  result.metrics.selectionMs = [];
  for (let index = 0; index < 4; index++) result.metrics.selectionMs.push(await measure(`document.querySelector(${JSON.stringify(pane)}).querySelectorAll('[data-file-path]')[${index}].click()`));
  result.metrics.transferUpdateMs = [];
  for (let index = 0; index < 6; index++) result.metrics.transferUpdateMs.push(await measure(`${fixture}.emit({ type: 'transfer', transfer: { id: 'perf-transfer', sessionId: ${JSON.stringify(sessionId)}, name: 'perf.bin', direction: 'upload', mode: 'direct', source: 'C:\\Fixture\\perf.bin', destination: '/tmp/perf.bin', state: 'transferring', done: ${index + 1} * 1024, total: 1000000, bytesPerSecond: 50000 } })`));
  result.metrics.sortMs = await measure(`document.querySelector('[aria-label="远程按大小排序"]').click()`);
  await click('远程按名称排序');
  if (process.env.GOOESHELL_EXPLORER_BASELINE === '1') { result.success = true; return; }
  const largeImage = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await fs.writeFile(report + '.large.png', largeImage.toPNG());
  assert.ok(result.metrics.domRows < 100, `bounded rows: ${result.metrics.domRows}`); result.checks.boundedRows = true;
  phase = 'narrow window column layout';
  window.setSize(1000, 1000); await evaluate(settle);
  const columns = await evaluate(`(() => { const table = document.querySelector('${pane} table'), headers = [...table.querySelectorAll('th')].filter(cell => cell.getClientRects().length); return { count: headers.length, right: headers.at(-1).getBoundingClientRect().right, tableRight: table.getBoundingClientRect().right, rowHeight: table.querySelector('[data-file-path]').getBoundingClientRect().height }; })()`);
  assert.equal(columns.count, 3); assert.ok(Math.abs(columns.right - columns.tableRight) < 2, 'hidden date column leaves no phantom table column'); assert.equal(columns.rowHeight, 29);
  result.checks.responsiveColumnsRemainAligned = true;
  window.setSize(1510, 1050); await evaluate(settle);
  phase = 'selection across virtual pages';
  await scrollToIndex(0);
  await evaluate(`document.querySelector('${pane} [data-file-path="/home/a/file-00002.txt"]').click()`); await evaluate(settle);
  await scrollToIndex(5000);
  const chosen = await evaluate(`document.querySelector('${pane} [data-file-path="/home/a/file-05000.txt"]').dataset.filePath`);
  await evaluate(`document.querySelector('${pane} [data-file-path="/home/a/file-05000.txt"]').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))`); await evaluate(settle);
  const dragPayload = await evaluate(`(() => { const transfer = new DataTransfer(); document.querySelector('${pane} [data-file-path="${chosen}"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer })); return JSON.parse(transfer.getData('application/x-gooeshell-files')); })()`);
  assert.equal(dragPayload.paths.length, 4999); assert.equal(dragPayload.paths[0], '/home/a/file-00002.txt'); assert.equal(dragPayload.paths.at(-1), '/home/a/file-05000.txt');
  assert.equal(dragPayload.sessionId, sessionId); assert.equal(dragPayload.side, 'remote'); result.checks.offscreenShiftSelection = true; result.checks.offscreenDragSelection = true;
  result.metrics.multiSelectContextMs = await measure(`document.querySelector('${pane} [data-file-path="${chosen}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 500, clientY: 600 }))`);
  assert.match(await evaluate(`document.querySelector('.context-menu').textContent`), /4999/); result.checks.offscreenContextMenu = true;
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await evaluate(settle);
  await click('远程按大小排序'); await scrollToIndex(4999);
  const afterSort = await evaluate(`(() => { const transfer = new DataTransfer(); document.querySelector('${pane} [data-file-path="${chosen}"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer })); return JSON.parse(transfer.getData('application/x-gooeshell-files')); })()`);
  assert.deepEqual(afterSort.paths, dragPayload.paths); result.checks.sortPreservesSelection = true;
  phase = 'scroll and pane visibility';
  await click('远程按名称排序');
  await evaluate(`document.querySelector(${JSON.stringify(wrap)}).scrollTop = 1e9`); await evaluate(settle);
  assert.equal(await evaluate(`Boolean(document.querySelector('${pane} [data-file-path="/home/a/file-09999.txt"]'))`), true); result.checks.lastRowReachable = true;
  result.metrics.endDomRows = await evaluate(`document.querySelectorAll(${JSON.stringify(pane + ' [data-file-path]')}).length`);
  await click('收起远程文件栏'); await click('展开本地文件栏');
  assert.equal(await evaluate(`document.querySelector('${pane}').dataset.collapsed`), 'true');
  await click('展开远程文件栏'); await evaluate(settle);
  assert.equal(await evaluate(`document.querySelector('.file-pane[data-side="local"]').dataset.collapsed`), 'false');
  assert.equal(await evaluate(`Boolean(document.querySelector('${pane} [data-file-path="/home/a/file-09999.txt"]'))`), true); result.checks.independentCollapse = true;
  phase = 'hidden refresh and blank selection';
  await click('收起文件管理'); await evaluate(`${fixture}.populateDirectory(${JSON.stringify(sessionId)}, 3)`);
  await evaluate(`${fixture}.emit({ type: 'transfer', transfer: { id: 'perf-transfer', sessionId: ${JSON.stringify(sessionId)}, name: 'perf.bin', direction: 'upload', mode: 'direct', source: 'C:\\Fixture\\perf.bin', destination: '/tmp/perf.bin', state: 'completed', done: 1000000, total: 1000000 } })`);
  await evaluate(settle); await click('展开文件管理');
  await until(() => evaluate(`document.querySelectorAll('${pane} [data-file-path]').length === 3`), 'small refreshed directory');
  result.checks.hiddenDirectoryUpdate = true;
  await evaluate(`document.querySelector('${pane} [data-file-path]').click()`); await evaluate(settle);
  await evaluate(`(() => { const target = document.querySelector(${JSON.stringify(wrap)}), rect = target.getBoundingClientRect(); target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.x + 30, clientY: rect.bottom - 5 })); })()`); await evaluate(settle);
  assert.equal(await evaluate(`document.querySelectorAll('${pane} [aria-selected="true"]').length`), 0); result.checks.blankDeselect = true;
  // A different terminal/directory must never inherit a deep scroll position.
  await evaluate(`[...document.querySelectorAll('.host')].find(button => button.textContent.includes('测试服务器 B')).click()`);
  await until(() => evaluate(`document.querySelector('[aria-label="远程目录路径"]').value === '/home/b'`), 'second session directory');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(wrap)}).scrollTop`), 0); result.checks.newDirectoryResetsScroll = true;
  const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }); await fs.writeFile(report + '.png', image.toPNG());
  result.success = true;
}
run().catch(error => { result.success = false; result.failure = { phase, message: error.message, stack: error.stack }; }).finally(async () => { await fs.writeFile(report, JSON.stringify(result, null, 2)); app.exit(result.success ? 0 : 1); });
