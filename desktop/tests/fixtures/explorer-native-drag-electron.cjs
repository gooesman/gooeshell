const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const url = process.env.GOOESHELL_NATIVE_DRAG_URL, report = process.env.GOOESHELL_NATIVE_DRAG_REPORT, data = process.env.GOOESHELL_NATIVE_DRAG_DATA;
if (!url || new URL(url).hostname !== '127.0.0.1' || !report || !data) throw new Error('Isolated paths required');
app.setPath('userData', data); app.commandLine.appendSwitch('force-device-scale-factor', '1');
let window, phase = 'startup', intercepted;
const result = { cases: [], errors: [], method: 'Chromium trusted mouse dragstart, intercepted native payload, CDP dragEnter/dragOver/drop' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => window.webContents.executeJavaScript(code);
const command = (name, params) => window.webContents.debugger.sendCommand(name, params);
async function until(predicate, label) { const end = Date.now() + 6000; while (!await predicate()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await wait(25); } }
async function click(label, scope = 'body') {
  const expression = `(()=>[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(button=>!button.disabled&&button.getClientRects().length&&(button.getAttribute('aria-label')===${JSON.stringify(label)}||button.title===${JSON.stringify(label)}||button.textContent.trim()===${JSON.stringify(label)})))()`;
  await until(() => evaluate(`Boolean(${expression})`), label); await evaluate(`${expression}.click()`); await wait(30);
}
async function point(selector) {
  return evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)}),rect=element.getBoundingClientRect();return{x:rect.left+Math.min(80,rect.width/2),y:rect.top+Math.min(12,rect.height/2)}})()`);
}
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.on('render-process-gone', (_event, value) => result.errors.push(value));
  await window.loadURL(url); window.webContents.debugger.attach('1.3');
  window.webContents.debugger.on('message', (_event, name, params) => { if (name === 'Input.dragIntercepted') intercepted = params.data; });
  await command('Input.setInterceptDrags', { enabled: true });
  await until(() => evaluate('document.querySelectorAll(".host").length===2'), 'fixture connections');
  await evaluate('[...document.querySelectorAll(".host")].find(value=>value.textContent.includes("测试服务器 A")).click()');
  await click('展开文件管理'); await click('展开本地文件栏');
  await evaluate('document.getElementById("file-manager").style.height="450px"');
  const session = await evaluate('document.querySelector("[data-terminal-session][data-active=true]").dataset.terminalSession');
  for (const side of ['local', 'remote']) {
    await evaluate(`window.appExplorerFixture.populateDirectory(${JSON.stringify(session)},2000,${JSON.stringify(side)})`);
    await click('刷新目录', `.file-pane[data-side=${side}]`);
    await until(() => evaluate(`document.querySelector('.file-pane[data-side=${side}] table')?.getAttribute('aria-rowcount')==='2001'`), 'large directory ' + side);
  }
  await evaluate(`window.__nativeDragEvents=[];for(const type of ['dragstart','dragend','drop'])document.addEventListener(type,event=>window.__nativeDragEvents.push({type,trusted:event.isTrusted,path:event.target.closest('[data-file-path]')?.dataset.filePath,side:event.target.closest('[data-side]')?.dataset.side}),true)`);
  for (const side of ['local', 'remote']) {
    phase = 'native ' + side + ' drag after source row unmount';
    const target = side === 'local' ? 'remote' : 'local', source = side === 'local' ? 'C:\\Fixture\\file-00000.txt' : '/home/a/file-00000.txt';
    const rowSelector = `.file-pane[data-side=${side}] [data-file-path=${JSON.stringify(source)}]`;
    await evaluate(`document.querySelector('.file-pane[data-side=${side}] .file-table-wrap').scrollTop=0;window.__nativeDragEvents=[]`);
    await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(rowSelector)}))`), 'source row mounted');
    const sourcePoint = await point(rowSelector); intercepted = undefined;
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...sourcePoint });
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...sourcePoint, button: 'left', clickCount: 1 });
    for (const dx of [10, 30, 60]) { await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sourcePoint.x + dx, y: sourcePoint.y + 2, button: 'left', buttons: 1 }); await wait(40); }
    await until(() => !!intercepted, 'Chromium intercepted drag');
    const payload = intercepted.items.find(item => item.mimeType === 'application/x-gooeshell-files');
    assert.ok(payload, 'native drag carries application payload'); assert.deepEqual(JSON.parse(payload.data).paths, [source]);
    await evaluate(`document.querySelector('.file-pane[data-side=${side}] .file-table-wrap').scrollTop=20000`);
    await until(() => evaluate(`!document.querySelector(${JSON.stringify(rowSelector)})`), 'source row virtualized away');
    const beforeDrop = await evaluate('window.__nativeDragEvents');
    assert.ok(beforeDrop.some(event => event.type === 'dragstart' && event.trusted && event.path === source));
    assert.ok(!beforeDrop.some(event => event.type === 'dragend'), 'removing source must not end the intercepted drag');
    const targetPoint = await point(`.file-pane[data-side=${target}] .file-table-wrap`); targetPoint.y += 50;
    for (const type of ['dragEnter', 'dragOver', 'drop']) await command('Input.dispatchDragEvent', { type, ...targetPoint, data: intercepted });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...targetPoint, button: 'left', clickCount: 1 });
    await until(() => evaluate('Boolean(document.querySelector(".transfer-dialog"))'), 'transfer chooser after native drop');
    const events = await evaluate('window.__nativeDragEvents');
    assert.ok(events.some(event => event.type === 'drop' && event.trusted && event.side === target));
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".transfer-source-list li")].map(item=>item.textContent)'), [source]);
    await click(side === 'local' ? '开始上传' : '开始下载', '.transfer-dialog');
    await until(() => evaluate('!document.querySelector(".transfer-dialog")'), 'queue transfer');
    const request = await evaluate('window.appExplorerFixture.calls.filter(call=>call.method==="transfer").at(-1).request');
    assert.equal(request.source, source); assert.equal(request.sessionId, session);
    assert.equal(request.direction, side === 'local' ? 'upload' : 'download');
    assert.equal(request.destinationDir, side === 'local' ? '/home/a' : 'C:\\Fixture');
    result.cases.push({ side, sourceUnmounted: true, nativeDragStart: true, nativeDrop: true, request, events });
  }
  result.success = true;
}
run().catch(error => { result.success = false; result.phase = phase; result.error = error.stack || String(error); }).finally(async () => {
  if (window && !window.isDestroyed()) try { result.events = await evaluate('window.__nativeDragEvents'); } catch {}
  await fs.writeFile(report, JSON.stringify(result, null, 2)); app.exit(result.success ? 0 : 1);
});
