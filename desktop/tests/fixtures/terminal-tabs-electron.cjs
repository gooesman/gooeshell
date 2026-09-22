const { app, BrowserWindow, ipcMain } = require('electron');
const { finishRendererFixture } = require('./renderer-fixture-report.cjs');
const { allowsUnsupportedGpuSkip } = require('./terminal-gpu-policy.cjs');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const url = process.env.GOOESHELL_TABS_RENDER_URL, report = process.env.GOOESHELL_TABS_RENDER_REPORT, userData = process.env.GOOESHELL_TABS_RENDER_DATA;
if (!url || new URL(url).hostname !== '127.0.0.1' || !report || !userData) throw new Error('Explicit isolated paths required');
app.setPath('userData', userData); app.commandLine.appendSwitch('force-device-scale-factor', '1');
const domFallback = process.env.GOOESHELL_TABS_RENDER_DOM === '1';
const host = { platform: process.platform, arch: process.arch, githubActions: process.env.GITHUB_ACTIONS, runnerEnvironment: process.env.RUNNER_ENVIRONMENT };
// Exercise a real WebGL atlas on CI, including hosts without a physical GPU.
// macOS Chromium 151+ SwANGLE needs a separately bundled Vulkan loader; forcing
// it can disable all WebGL in Electron distributions without that library.
// Electron's macOS build allows ANGLE/Metal (its normal platform backend),
// but rejects ANGLE/OpenGL as an unsupported implementation.
// https://github.com/chromiumembedded/cef/issues/4230
// https://github.com/google/angle/blob/main/doc/DebuggingTips.md
const angleBackend = domFallback ? 'not-requested' : process.env.CI ? (process.platform === 'darwin' ? 'metal' : 'swiftshader') : 'default';
if (angleBackend !== 'default' && !domFallback) {
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', angleBackend);
  if (angleBackend === 'swiftshader') app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  else app.commandLine.appendSwitch('ignore-gpu-blocklist');
}
const result = { mode: domFallback ? 'dom' : 'webgl', checks: {}, rendererErrors: [], graphics: { host, requestedAngleBackend: angleBackend }, subscriptions: { calls: 0, active: 0, maximum: 0 } }; let window, phase = 'initial';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => window.webContents.executeJavaScript(code);
const flush = async () => { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await wait(70); };
async function until(predicate, label) { const end = Date.now() + 10000; while (!await predicate()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await wait(30); } }
async function activate(index) { await evaluate(`window.__tabsSetActive(${index})`); await until(() => evaluate(`window.__tabsActive===${index}`), 'active tab'); await flush(); }
async function write(index, text) { await evaluate(`new Promise(resolve=>window.__fixtureTerminals[${index}].write(${JSON.stringify(text)},resolve))`); await flush(); }
async function requireWebgl(label, count) {
  const contexts = await evaluate(`window.__fixtureTerminals.map(terminal=>{
    // xterm inserts a 2D link-overlay canvas before the actual WebGL surface.
    const gl=[...terminal.element.querySelectorAll('.xterm-screen > canvas')].map(canvas=>canvas.getContext('webgl2')).find(Boolean);
    if(!gl)return null;
    const debug=gl.getExtension('WEBGL_debug_renderer_info');
    return {lost:gl.isContextLost(),version:gl.getParameter(gl.VERSION),renderer:gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER)};
  })`);
  result.graphics[label] = contexts;
  assert.equal(contexts.length, count);
  assert.ok(contexts.every(context=>context&&!context.lost&&context.version.includes('WebGL 2')), 'A live terminal WebGL2 renderer is required for glyph atlas regression');
}
async function requireRenderer(label, count) {
  if (!domFallback) return requireWebgl(label, count);
  const renderers = await evaluate(`window.__fixtureTerminals.map(terminal=>({dom:!!terminal.element.querySelector('.xterm-rows'),canvases:terminal.element.querySelectorAll('canvas').length}))`);
  result.graphics[label] = renderers;
  assert.equal(renderers.length, count);
  assert.ok(renderers.every(renderer => renderer.dom && renderer.canvases === 0), 'Actual DOM renderer required for fallback behavior coverage');
}
async function probeWebgl() {
  // Do not use xterm as the capability probe: addon regressions on a working
  // WebGL host must fail, not turn into environmental skips.
  await window.loadURL('about:blank');
  return evaluate(`(()=>{
    const canvas=document.createElement('canvas'),errors=[];canvas.width=2;canvas.height=2;
    canvas.addEventListener('webglcontextcreationerror',event=>errors.push(event.statusMessage));
    const gl=canvas.getContext('webgl2',{preserveDrawingBuffer:true});
    if(!gl)return{status:'unavailable',contextCreated:false,errors};
    const debug=gl.getExtension('WEBGL_debug_renderer_info');
    gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
    const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    const lost=gl.isContextLost(),error=gl.getError(),value={status:lost?'lost-context':error!==gl.NO_ERROR||pixel.join(',')!=='255,0,0,255'?'readback-error':'available',contextCreated:true,lost,error,pixel:[...pixel],version:gl.getParameter(gl.VERSION),renderer:gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER),errors};
    gl.getExtension('WEBGL_lose_context')?.loseContext();return value;
  })()`);
}
async function capture(label) {
  await flush();
  const geometry = await evaluate(`(()=>{const terminal=window.__fixtureTerminals[window.__tabsActive],r=terminal.element.querySelector('.xterm-screen').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height*8/terminal.rows)}})()`);
  const shot = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  await fs.writeFile(report + '.' + label + '.png', shot.toPNG());
  return createHash('sha256').update(shot.crop(geometry).toBitmap()).digest('hex');
}
async function run() {
  await app.whenReady();
  if (process.platform === 'darwin') {
    const libraries = path.join(path.dirname(process.execPath), '..', 'Frameworks', 'Electron Framework.framework', 'Libraries');
    result.graphics.bundledVulkanLibraries = await fs.readdir(libraries).then(names=>names.filter(name=>/vulkan|swiftshader/i.test(name)), error=>({error:error.message}));
  }
  window = new BrowserWindow({ show: false, width: 960, height: 680, webPreferences: { preload: path.resolve('tests/fixtures/terminal-palettes-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  ipcMain.on('palette-fixture:subscription', (event, action) => {
    assert.equal(event.sender, window.webContents);
    if (action === 'add') { result.subscriptions.calls++; result.subscriptions.active++; }
    else result.subscriptions.active--;
    result.subscriptions.maximum = Math.max(result.subscriptions.maximum, result.subscriptions.active);
  });
  window.webContents.on('render-process-gone', (_event, details) => result.rendererErrors.push(details));
  if (!domFallback) {
    phase = 'standalone WebGL2 capability probe';
    result.graphics.capabilityProbe = await probeWebgl();
    result.graphics.featureStatus = app.getGPUFeatureStatus();
    if (allowsUnsupportedGpuSkip(host, result.graphics.capabilityProbe)) {
      result.status = 'unsupported'; result.success = false;
      result.skipReason = 'This GitHub-hosted macOS x64 runner cannot create a standalone WebGL2 context; GPU glyph-atlas coverage is unavailable (DOM tab behavior is tested separately).';
      return;
    }
    assert.equal(result.graphics.capabilityProbe.status, 'available', 'Standalone WebGL2 context creation and pixel readback are required for the GPU regression');
  }
  phase = 'load terminal fixture';
  await window.loadURL(url); window.setMenu(null);
  await until(() => evaluate('window.__fixtureTerminals?.length===1&&window.__fixtureTerminals[0].options.fontFamily.includes("GooeshellTerminal")'), 'first composite font');
  await flush();
  await requireRenderer('initialContexts', 1);
  result.graphics.featureStatus = app.getGPUFeatureStatus();
  const firstText = '\x1b[?1049h\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[H' +
    ['FIRST_TERMINAL_0123456789', '\x1b[34m中文甲乙ΓθΩЖЯй∆∑☃\x1b[0m', '\x1b[32m国界山河路桥水天地\x1b[0m', '╭──────────────╮', '│ SAME BUFFER  │', '╰──────────────╯'].join('\r\n');
  await write(0, firstText);
  const before = await capture('before');
  phase = 'mount another same-font terminal';
  await evaluate('window.__tabsSetCount(2)');
  await until(() => evaluate('window.__fixtureTerminals?.length===2&&window.__fixtureTerminals[1].options.fontFamily.includes("GooeshellTerminal")'), 'second composite font');
  await requireRenderer('twoTerminalContexts', 2);
  await activate(1);
  await write(1, '\x1b[?25l\x1b[?1049h\x1b[HSECOND_TERMINAL\r\n\x1b[34m领域测试界面日月λβψφДШЖ\x1b[0m');
  // This is the same public operation as an asynchronous font load/setting
  // change. The other terminal must keep valid glyph coordinates afterward.
  await evaluate('window.__fixtureTerminals[1].clearTextureAtlas()');
  await write(1, '\r\n\x1b[32m不同字形内容测试∆ΣΨ\x1b[0m');
  await activate(0);
  const after = await capture('after-sibling-atlas-reset');
  assert.equal(after, before, 'switching back must preserve the exact original glyph pixels'); result.checks.glyphsSurviveSiblingUpdate = true;
  if (!domFallback) result.checks.glyphsSurviveSiblingReset = true;
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
  assert.notEqual(state.families[0], state.families[1]); result.checks.isolatedFontFamilies = true;
  if (domFallback) assert.equal(state.canvas, 0);
  else { assert.ok(state.canvas > 0, 'GPU renderer required for glyph atlas regression'); result.checks.isolatedAtlas = true; }
  result.state = state;
  await requireRenderer('finalContexts', 2);
  if (domFallback) result.checks.liveDomRenderers = true; else result.checks.liveWebglContexts = true;
  assert.deepEqual(result.subscriptions, { calls: 1, active: 1, maximum: 1 }, 'terminal tabs share one actual contextBridge event subscription');
  result.checks.singleBridgeSubscription = true;
  await evaluate('window.__tabsSetCount(0)');
  await until(() => result.subscriptions.active === 0, 'unsubscribe after last terminal closes');
  result.checks.bridgeUnsubscribed = true; result.success = true;
}
run().catch(async error => { result.success = false; result.phase = phase; result.error = error.stack || String(error); if (window && !window.isDestroyed()) try { await fs.writeFile(report + '.failure.png', (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); } catch {} }).finally(async () => {
  await finishRendererFixture(app, report, result, result.status === 'unsupported' ? 77 : undefined);
});
