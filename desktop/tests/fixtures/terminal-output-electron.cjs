const { app, BrowserWindow, ipcMain } = require('electron');
const { finishRendererFixture } = require('./renderer-fixture-report.cjs');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const url = process.env.GOOESHELL_OUTPUT_RENDER_URL, report = process.env.GOOESHELL_OUTPUT_RENDER_REPORT, userData = process.env.GOOESHELL_OUTPUT_RENDER_DATA;
if (!url || new URL(url).hostname !== '127.0.0.1' || !report || !userData) throw new Error('Explicit isolated paths required');
app.setPath('userData', userData); app.commandLine.appendSwitch('force-device-scale-factor', '1');
if (process.env.CI) { app.commandLine.appendSwitch('use-angle', 'swiftshader'); app.commandLine.appendSwitch('enable-unsafe-swiftshader'); }
const result = { checks: {}, rendererErrors: [], acked: {}, sent: {} }; let window, phase = 'initial', inputEcho=0;
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
    if (method === 'terminalInput') send(args[0],Buffer.from(`INPUT_ECHO_${++inputEcho}\r\n`));
  });
  await window.loadURL(url); window.setMenu(null);
  window.showInactive();
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
  phase='input, tab activation and history overlay baseline';
  await evaluate('window.__tabsSetActive(0)');await until(()=>evaluate('window.__tabsActive===0'),'baseline active');await flush();
  send('tabs-0',Buffer.from('\x1b[?1049l\x1b[2J\x1b[H'+Array.from({length:300},(_,i)=>`\x1b]133;A\x07$ \x1b]133;B\x07echo ${i}\x1b]633;E;echo ${i}\x07\x1b]133;C\x07\r\n${i}\r\n\x1b]133;D;0\x07`).join('')));
  await until(()=>result.acked['tabs-0']===result.sent['tabs-0'],'history parsed');await flush();
  await evaluate(`(()=>{window.__latencies=[];window.__railMutations=0;window.__railObserver=new MutationObserver(entries=>window.__railMutations+=entries.length);window.__railObserver.observe(document.querySelector('.command-marks-rail'),{subtree:true,attributes:true,childList:true});document.addEventListener('keydown',()=>{window.__inputStart=performance.now();},{capture:true});window.__fixtureTerminals[0].onRender(()=>{const t=window.__fixtureTerminals[0],b=t.buffer.active,text=Array.from({length:Math.min(5,b.length)},(_,i)=>b.getLine(b.baseY+b.cursorY-i)?.translateToString(true)||'').join(' ');if(window.__inputStart&&text.includes('INPUT_ECHO_'+window.__expectedEcho)){window.__latencies.push(performance.now()-window.__inputStart);window.__inputStart=0;}});})()`);
  const inputSamples=async()=>{const samples=[];for(let i=0;i<20;i++){await evaluate(`window.__expectedEcho=${inputEcho+1};window.__fixtureTerminals[0].focus()`);window.webContents.sendInputEvent({type:'keyDown',keyCode:'x'});window.webContents.sendInputEvent({type:'char',keyCode:'x'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'x'});await until(()=>evaluate(`window.__latencies.length>=${i+1}`),'input render');}samples.push(...await evaluate('window.__latencies'));await evaluate('window.__latencies=[]');return samples;};
  const idle=await inputSamples();
  const burstPacket=Buffer.from('background output 0123456789 中文\r\n'.repeat(100));
  const pump=setInterval(()=>{if((result.sent['tabs-1']||0)-(result.acked['tabs-1']||0)<128*1024)send('tabs-1',burstPacket);},10);
  let loaded;try{loaded=await inputSamples();}finally{clearInterval(pump);}
  const overlayMutations=await evaluate('window.__railObserver.disconnect();window.__railMutations');
  const tabSamples=[];for(let i=0;i<12;i++){const index=i%2;tabSamples.push(await evaluate(`(async()=>{const start=performance.now();window.__tabsSetActive(${index});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return performance.now()-start;})()`));}
  const statistics=samples=>{const sorted=[...samples].sort((a,b)=>a-b);return{medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))],samples};};
  result.experience={inputEchoIdle:statistics(idle),inputEchoWithHiddenOutput:statistics(loaded),tabActivationTwoFrames:statistics(tabSamples),historyCommands:300,overlayMutations};
  result.checks.nativeInputEcho=true;
  await until(()=>Object.keys(result.sent).every(id=>result.acked[id]===result.sent[id]),'experience output integrity');
  await fs.writeFile(report + '.hidden-output.png', (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  result.success = true;
}
run().catch(error => { result.success = false; result.phase = phase; result.error = error.stack || String(error); }).finally(async () => {
  await finishRendererFixture(app, report, result);
});
