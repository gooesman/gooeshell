const { app, BrowserWindow, ipcMain } = require('electron');
const { finishRendererFixture } = require('./renderer-fixture-report.cjs');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const url = process.env.GOOESHELL_OUTPUT_RENDER_URL, report = process.env.GOOESHELL_OUTPUT_RENDER_REPORT, userData = process.env.GOOESHELL_OUTPUT_RENDER_DATA;
if (!url || new URL(url).hostname !== '127.0.0.1' || !report || !userData) throw new Error('Explicit isolated paths required');
app.setPath('userData', userData); app.commandLine.appendSwitch('force-device-scale-factor', '1');
if (process.env.CI) { app.commandLine.appendSwitch('use-angle', 'swiftshader'); app.commandLine.appendSwitch('enable-unsafe-swiftshader'); }
const result = { checks: {}, rendererErrors: [], acked: {}, sent: {} }; let window, phase = 'initial';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => window.webContents.executeJavaScript(code);
const flush = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
async function until(predicate, label) { const end = Date.now() + 12000; while (!await predicate()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await wait(25); } }
function send(id, bytes) {
  result.sent[id] = (result.sent[id] || 0) + bytes.length;
  window.webContents.send('palette-fixture:event', { type: 'terminal', sessionId: id, bytes: bytes.length, data: bytes.toString('base64') });
}
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 960, height: 680, webPreferences: { preload: path.resolve('tests/fixtures/terminal-palettes-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('render-process-gone', (_event, details) => result.rendererErrors.push(details));
  ipcMain.on('palette-fixture:call', (event, method, args) => {
    assert.equal(event.sender, window.webContents);
    if (method === 'terminalAck') result.acked[args[0]] = (result.acked[args[0]] || 0) + args[1];
  });
  await window.loadURL(url); window.setMenu(null);
  await until(() => evaluate('window.__fixtureTerminals?.length===1&&window.__fixtureTerminals[0].options.fontFamily.includes("GooeshellTerminal")'), 'first terminal');
  phase = 'same-runtime decoder benchmark';
  assert.equal(await evaluate('typeof Uint8Array.fromBase64'), 'function'); result.checks.nativeDecoderAvailable = true;
  result.benchmark = await evaluate(`(()=>{
    const old=value=>{const raw=atob(value);return Uint8Array.from(raw,c=>c.charCodeAt(0));};
    const methods=[old,window.__decodeTerminalBytes,window.__decodeTerminalBytesFallback];
    const results=[];let checksum=0;
    for(const packetBytes of [4096,32768,131072]){
      const raw=Array.from({length:packetBytes},(_,index)=>String.fromCharCode(index%256)).join(''), encoded=btoa(raw), iterations=8*1048576/packetBytes;
      for(const decode of methods){const bytes=decode(encoded);if(bytes.length!==packetBytes)throw new Error('Byte count differs');for(let index=0;index<bytes.length;index++)if(bytes[index]!==index%256)throw new Error('Byte content differs');for(let warm=0;warm<16;warm++)decode(encoded);}
      const samples=methods.map(()=>[]);
      for(let round=0;round<7;round++)for(let order=0;order<methods.length;order++){
        const method=(round+order)%methods.length,start=performance.now();
        for(let index=0;index<iterations;index++){const bytes=methods[method](encoded);checksum+=bytes[(index*31)%packetBytes];}
        samples[method].push(performance.now()-start);
      }
      const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
      results.push({packetBytes,totalBytes:iterations*packetBytes,rounds:7,oldMedianMs:median(samples[0]),nativeMedianMs:median(samples[1]),fallbackMedianMs:median(samples[2]),samples});
    }
    window.__decoderChecksum=checksum;return results;
  })()`); result.checks.byteEquality = true;
  phase = 'hidden-tab output and byte boundaries';
  await evaluate('window.__tabsSetCount(2)');
  await until(() => evaluate('window.__fixtureTerminals?.length===2&&window.__fixtureTerminals[1].options.fontFamily.includes("GooeshellTerminal")'), 'hidden terminal');
  const unicode = Buffer.from('\x1b[?1049h\x1b[?1006h\x1b[?2004h\x1b[H\x1b[32mVISIBLE_中文😀\x1b[0m\r\n');
  for (let offset = 0; offset < unicode.length; offset++) send('tabs-0', unicode.subarray(offset, offset + 1));
  const line = '0123456789'.repeat(8) + ' 中文😀\r\n';
  const burst = Buffer.from(line.repeat(12000) + '\x1b[?1049h\x1b[?1006h\x1b[?2004h\x1b[H\x1b[34mHIDDEN_DONE_中文😀\x1b[0m\r\n');
  for (let offset = 0; offset < burst.length; offset += 32767) send('tabs-1', burst.subarray(offset, offset + 32767));
  await until(() => Object.keys(result.sent).every(id => result.acked[id] === result.sent[id]), 'all output write callbacks');
  result.checks.acknowledgements = true;
  const inspect = index => evaluate(`(()=>{const t=window.__fixtureTerminals[${index}],b=t.buffer.active;return{text:Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\\n'),type:b.type,modes:t.modes}})()`);
  const active = await inspect(0), hidden = await inspect(1);
  assert.match(active.text, /VISIBLE_中文😀/); result.checks.splitUnicode = true;
  assert.match(hidden.text, /HIDDEN_DONE_中文😀/); result.checks.hiddenOutput = true;
  for (const state of [active, hidden]) { assert.equal(state.type, 'alternate'); assert.equal(state.modes.bracketedPasteMode, true); }
  result.checks.terminalModes = true;
  await evaluate('window.__decoderOriginal=window.__fixtureTerminals[1];window.__tabsSetActive(1)');
  await until(() => evaluate('window.__tabsActive===1'), 'activate hidden terminal'); await flush();
  assert.equal(await evaluate('window.__decoderOriginal===window.__fixtureTerminals[1]'), true);
  assert.match((await inspect(1)).text, /HIDDEN_DONE_中文😀/); result.checks.sameTerminalAfterSwitch = true;
  await fs.writeFile(report + '.hidden-output.png', (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  result.success = true;
}
run().catch(error => { result.success = false; result.phase = phase; result.error = error.stack || String(error); }).finally(async () => {
  await finishRendererFixture(app, report, result);
});
