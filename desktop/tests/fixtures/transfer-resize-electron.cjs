const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { finishRendererFixture } = require('./renderer-fixture-report.cjs');
const url = process.env.GOOESHELL_RESIZE_URL, report = process.env.GOOESHELL_RESIZE_REPORT, data = process.env.GOOESHELL_RESIZE_DATA;
if (!url || new URL(url).hostname !== '127.0.0.1' || !report || !data) throw new Error('Explicit isolated fixture paths required');
app.setPath('userData', data);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const result = { success: false, checks: {} }; let window, phase = 'startup';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => window.webContents.executeJavaScript(code);
async function until(code) { for (let i = 0; i < 200; i++) { if (await evaluate(code)) return; await wait(50); } throw new Error('Timed out: ' + code); }
async function click(label) { await evaluate(`document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}).click()`); await wait(100); }
async function drag(selector, delta) {
  const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  window.webContents.sendInputEvent({type:'mouseMove',...point});
  window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  window.webContents.sendInputEvent({type:'mouseMove',x:point.x,y:point.y+delta,button:'left'});
  window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:point.x,y:point.y+delta});
  await wait(150);
}
async function run() {
  await app.whenReady();
  window = new BrowserWindow({show:false,width:1000,height:800,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  window.showInactive(); await window.loadURL(url);
  await until('document.querySelectorAll(".host").length===2');
  await evaluate('document.querySelector(".host").click()');
  await until('document.querySelector("[aria-label=展开文件管理]")'); await click('展开文件管理');
  await until('document.querySelector("[aria-label=展开传输队列]")'); await click('展开传输队列');
  phase = 'drag queue upward';
  const separator = '[aria-label="调整传输队列高度"]';
  await until(`document.querySelector(${JSON.stringify(separator)})?.getClientRects().length`);
  const height = () => evaluate('document.querySelector(".transfer-area").getBoundingClientRect().height');
  const initial = await height(); await drag(separator, -80); const expanded = await height();
  assert(expanded > initial + 50, `queue did not expand: ${initial} -> ${expanded}`);
  await drag(separator, 50); const reduced = await height();
  assert(reduced < expanded - 30, `queue did not shrink: ${expanded} -> ${reduced}`);
  result.checks.pointer = true;
  phase = 'keyboard resize';
  await evaluate(`document.querySelector(${JSON.stringify(separator)}).focus()`);
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Up'});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Up'});
  await wait(150); const keyboard = await height(); assert(keyboard > reduced + 10);
  result.checks.keyboard = true;
  phase = 'collapse and reopen';
  await click('收起传输队列');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(separator)}).getClientRects().length`), 0);
  await click('展开传输队列'); assert(Math.abs(await height() - keyboard) < 2); result.checks.collapse = true;
  phase = 'resize outer file manager';
  await drag('[aria-label="调整文件管理高度"]', 500);
  const dimensions = await evaluate('(()=>{const a=document.querySelector(".dual-files").getBoundingClientRect(),b=document.querySelector(".transfer-area").getBoundingClientRect();return {files:a.height,queue:b.height}})()');
  assert(dimensions.files >= 115 && dimensions.queue >= 65, JSON.stringify(dimensions));
  result.checks.bounds = true; result.success = true;
}
run().catch(error => { result.phase = phase; result.error = error.stack || String(error); }).finally(() => finishRendererFixture(app, report, result));
