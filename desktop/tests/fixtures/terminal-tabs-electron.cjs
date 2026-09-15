const { app, BrowserWindow } = require('electron');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const url = process.env.GOOESHELL_TABS_RENDER_URL, report = process.env.GOOESHELL_TABS_RENDER_REPORT, userData = process.env.GOOESHELL_TABS_RENDER_DATA;
if (!url || new URL(url).hostname !== '127.0.0.1' || !report || !userData) throw new Error('Explicit isolated paths required');
app.setPath('userData', userData); app.commandLine.appendSwitch('force-device-scale-factor', '1');
// Hosted runners have no physical GPU; still exercise the actual WebGL atlas.
if (process.env.CI) { app.commandLine.appendSwitch('use-angle', 'swiftshader'); app.commandLine.appendSwitch('enable-unsafe-swiftshader'); }
const result = { checks: {}, rendererErrors: [] }; let window, phase = 'initial';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => window.webContents.executeJavaScript(code);
const flush = async () => { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await wait(70); };
async function until(predicate, label) { const end = Date.now() + 10000; while (!await predicate()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await wait(30); } }
async function activate(index) { await evaluate(`window.__tabsSetActive(${index})`); await until(() => evaluate(`window.__tabsActive===${index}`), 'active tab'); await flush(); }
async function write(index, text) { await evaluate(`new Promise(resolve=>window.__fixtureTerminals[${index}].write(${JSON.stringify(text)},resolve))`); await flush(); }
async function capture(label) {
  await flush();
  const geometry = await evaluate(`(()=>{const terminal=window.__fixtureTerminals[window.__tabsActive],r=terminal.element.querySelector('.xterm-screen').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height*8/terminal.rows)}})()`);
  const shot = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  await fs.writeFile(report + '.' + label + '.png', shot.toPNG());
  return createHash('sha256').update(shot.crop(geometry).toBitmap()).digest('hex');
}
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 960, height: 680, webPreferences: { preload: path.resolve('tests/fixtures/terminal-palettes-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('render-process-gone', (_event, details) => result.rendererErrors.push(details));
  await window.loadURL(url); window.setMenu(null);
  await until(() => evaluate('window.__fixtureTerminals?.length===1&&window.__fixtureTerminals[0].options.fontFamily.includes("GooeshellTerminal")'), 'first composite font');
  await flush();
  const firstText = '\x1b[?1049h\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[H' +
    ['FIRST_TERMINAL_0123456789', '\x1b[34m中文甲乙ΓθΩЖЯй∆∑☃\x1b[0m', '\x1b[32m国界山河路桥水天地\x1b[0m', '╭──────────────╮', '│ SAME BUFFER  │', '╰──────────────╯'].join('\r\n');
  await write(0, firstText);
  const before = await capture('before');
  phase = 'mount another same-font terminal';
  await evaluate('window.__tabsSetCount(2)');
  await until(() => evaluate('window.__fixtureTerminals?.length===2&&window.__fixtureTerminals[1].options.fontFamily.includes("GooeshellTerminal")'), 'second composite font');
  await activate(1);
  await write(1, '\x1b[?25l\x1b[?1049h\x1b[HSECOND_TERMINAL\r\n\x1b[34m领域测试界面日月λβψφДШЖ\x1b[0m');
  // This is the same public operation as an asynchronous font load/setting
  // change. The other terminal must keep valid glyph coordinates afterward.
  await evaluate('window.__fixtureTerminals[1].clearTextureAtlas()');
  await write(1, '\r\n\x1b[32m不同字形内容测试∆ΣΨ\x1b[0m');
  await activate(0);
  const after = await capture('after-sibling-atlas-reset');
  assert.equal(after, before, 'switching back must preserve the exact original glyph pixels'); result.checks.glyphsSurviveSiblingReset = true;
  phase = 'settings change with hidden tabs';
  await evaluate('window.__tabsSetSettings(value=>({...value,fontSize:18,fontWeight:700}))'); await flush();
  await activate(1); await flush();
  await evaluate('window.__tabsSetSettings(value=>({...value,fontSize:14,fontWeight:400}))'); await flush();
  await activate(0);
  assert.equal(await capture('after-font-settings'), before, 'font changes restore glyphs on inactive tabs'); result.checks.hiddenFontSettings = true;
  phase = 'repeat same-size tab switches';
  for (let index = 0; index < 4; index++) { await activate(1); await activate(0); }
  assert.equal(await capture('repeated-switches'), before); result.checks.repeatSwitch = true;
  const state = await evaluate(String.raw`(()=>{const terminal=window.__fixtureTerminals[0];return {count:window.__fixtureTerminals.length,type:terminal.buffer.active.type,modes:terminal.modes,text:Array.from({length:terminal.buffer.active.length},(_,i)=>terminal.buffer.active.getLine(i)?.translateToString(true)||'').join('\n'),families:window.__fixtureTerminals.map(item=>item.options.fontFamily),canvas:document.querySelectorAll('canvas').length}})()`);
  assert.equal(state.count, 2); assert.equal(state.type, 'alternate'); assert.equal(state.modes.bracketedPasteMode, true); assert.match(state.text, /FIRST_TERMINAL_0123456789/); assert.match(state.text, /中文甲乙/); result.checks.bufferPreserved = true;
  assert.notEqual(state.families[0], state.families[1]); result.checks.isolatedAtlas = true;
  assert.ok(state.canvas > 0, 'GPU renderer required for glyph atlas regression'); result.state = state; result.success = true;
}
run().catch(async error => { result.success = false; result.phase = phase; result.error = error.stack || String(error); if (window && !window.isDestroyed()) try { await fs.writeFile(report + '.failure.png', (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); } catch {} }).finally(async () => { if (window && !window.isDestroyed()) window.destroy(); await fs.writeFile(report, JSON.stringify(result, null, 2)); app.exit(result.success ? 0 : 1); });
