const { app, BrowserWindow, ipcMain } = require('electron');
const { Server } = require('ssh2');
const { generateKeyPairSync, randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { SshService } = require('../../dist-main/main/ssh-service.js');
const { systemFontCatalog } = require('../../dist-main/main/font-catalog.js');

const url = process.env.GOOESHELL_RENDER_URL;
const reportFile = process.env.GOOESHELL_RENDER_REPORT;
const userData = process.env.GOOESHELL_RENDER_DATA;
if (!url || new URL(url).hostname !== '127.0.0.1' || !reportFile || !userData) throw new Error('Explicit isolated fixture paths and a loopback URL are required');
app.setPath('userData', userData);
// Pixel comparisons need an integer grid. At fractional Windows scaling xterm's
// canvas ResizeObserver can round the backing store differently after a refresh.
app.commandLine.appendSwitch('force-device-scale-factor','1');
const socketName = `gooeshell-test-${randomUUID()}`;
const connections = new Set();
const metrics = { socketName, queries: [], bytes: 0, acked: 0, resize: [], rendererErrors: [], console: [] };
let server, service, window, bridge, session, output = '', replies = '', bridgeStderr = '';
const started = Date.now();
let phase = 'initialization';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(25);
  }
}
const inspect = () => window.webContents.executeJavaScript(`(() => {
  const t = window.__fixtureTerminal;
  if (!t) return null;
  const b=t.buffer.active; const lines=[];
  for(let i=b.viewportY;i<Math.min(b.length,b.viewportY+t.rows);i++) lines.push(b.getLine(i)?.translateToString(true)||'');
  return {text:lines.join('\\n'),renderedText:window.__fixtureLastRenderedText,cols:t.cols,rows:t.rows,type:b.type,renders:window.__fixtureRenders,canvas:document.querySelectorAll('canvas').length,synchronized:t.modes.synchronizedOutputMode,visibility:document.visibilityState,theme:document.documentElement.dataset.theme,foreground:t.options.theme.foreground,cursor:t.options.theme.cursor,fontFamily:t.options.fontFamily,fontWeight:t.options.fontWeight,fontWeightBold:t.options.fontWeightBold,fontSelection:window.__fixtureFontSelection,fontWarning:document.querySelector('.terminal-font-warning')?.textContent||'',fontFaces:[...document.fonts].map(face=>({family:face.family,weight:face.weight,status:face.status})),background:getComputedStyle(document.querySelector('.terminal-instance')).backgroundColor,layers:[...document.querySelectorAll('.xterm,.xterm-viewport,.xterm-scrollable-element,.xterm-screen,canvas')].map(el=>({class:el.className,background:getComputedStyle(el).backgroundColor})),sameTerminal:!window.__fixtureOriginalTerminal||t===window.__fixtureOriginalTerminal};
})()`);
const input = data => window.webContents.executeJavaScript(`window.__fixtureTerminal.input(${JSON.stringify(data)},true)`);
const settleFrame = () => window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const pixelSamples = {english:'PIXEL_LATIN_ABCabc0123',chinese:'中文终端字体独立粗体'};
async function selectFonts(selection,label){
  const previous=(await inspect()).fontFamily;
  await window.webContents.executeJavaScript(`window.__fixtureSetFontSelection(${JSON.stringify(selection)})`);
  await until(async()=>{
    const state=await inspect();
    return state?.fontFamily!==previous&&state.fontFamily.startsWith('"GooeshellTerminal')&&!state.fontWarning&&Object.entries(selection).every(([key,value])=>state.fontSelection[key]===value);
  },label);
  await settleFrame();
  // Allow the device-pixel ResizeObserver and the remote tmux redraw to settle
  // after a family changes the cell dimensions before recording a baseline.
  await delay(120);
  await settleFrame();
}
async function captureFontSamples(label){
  await settleFrame();
  const geometry=await window.webContents.executeJavaScript(`(()=>{
    const terminal=window.__fixtureTerminal,buffer=terminal.buffer.active,rect=terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
    const samples=${JSON.stringify(pixelSamples)},rows={};
    for(const [name,text] of Object.entries(samples)){
      let row=-1;for(let index=buffer.viewportY;index<Math.min(buffer.length,buffer.viewportY+terminal.rows);index++)if(buffer.getLine(index)?.translateToString(true).trim()===text){row=index-buffer.viewportY;break;}
      if(row<0)throw new Error('Missing pixel sample: '+name);
      rows[name]={row,x:rect.left,y:rect.top+row*rect.height/terminal.rows,width:rect.width,height:rect.height/terminal.rows};
    }
    return{innerWidth:window.innerWidth,rows};
  })()`);
  // Read inside the real render callback before Chromium clears the non-preserved
  // WebGL buffer. This avoids screenshot compositor resampling at fractional DPI.
  const renderedPixels=await window.webContents.executeJavaScript(`new Promise(resolve=>{
    const terminal=window.__fixtureTerminal,rows=${JSON.stringify(geometry.rows)};
    const listener=terminal.onRender(()=>{
      listener.dispose();const gl=[...terminal.element.querySelectorAll('.xterm-screen canvas')].map(canvas=>canvas.getContext('webgl2')).find(Boolean);
      if(!gl)throw new Error('Actual WebGL renderer is required for font pixel assertions');
      const width=gl.drawingBufferWidth,height=gl.drawingBufferHeight,rowHeight=height/terminal.rows,result={};
      for(const [name,geometry] of Object.entries(rows)){
        const top=Math.round(geometry.row*rowHeight),bottom=Math.round((geometry.row+1)*rowHeight),data=new Uint8Array(width*(bottom-top)*4);
        gl.readPixels(0,height-bottom,width,bottom-top,gl.RGBA,gl.UNSIGNED_BYTE,data);
        let hash=2166136261,ink=0;for(let index=0;index<data.length;index++){hash=Math.imul(hash^data[index],16777619);if(index%4!==3)ink+=data[index];}
        result[name]={hash:(hash>>>0).toString(16),ink,width,height:bottom-top};
      }
      resolve(result);
    });
    terminal.refresh(0,terminal.rows-1);
  })`);
  const screenshot=await window.webContents.capturePage();
  await fs.writeFile(reportFile+'.'+label+'.png',screenshot.toPNG());
  const scale=screenshot.getSize().width/geometry.innerWidth,result={state:await inspect()};
  for(const [name,rect] of Object.entries(geometry.rows)){
    const x=Math.round(rect.x*scale),y=Math.round(rect.y*scale),width=Math.round(rect.width*scale),height=Math.round((rect.y+rect.height)*scale)-y;
    const image=screenshot.crop({x,y,width,height}),data=image.toBitmap();let ink=0;
    for(let index=0;index<data.length;index++)if(index%4!==3)ink+=data[index];
    result[name]={...renderedPixels[name],composited:{hash:createHash('sha256').update(data).digest('hex'),ink,width,height}};
    await fs.writeFile(reportFile+'.'+label+'.'+name+'.png',image.toPNG());
  }
  return result;
}
function verifyChineseOnly(before,after){
  assert.equal(after.state.sameTerminal,true);
  assert.equal(after.state.type,'alternate');
  assert.equal(after.state.cols,before.state.cols);
  assert.equal(after.state.rows,before.state.rows);
  assert.equal(after.state.fontWeight,400,'xterm logical normal weight stays 400');
  assert.equal(after.state.fontSelection.chineseFontWeight,700);
  assert.equal(after.english.hash,before.english.hash,'Chinese weight must not change actual English pixels');
  assert.notEqual(after.chinese.hash,before.chinese.hash,'Chinese pixels must change when a real bold face is selected');
  assert.ok(after.chinese.ink>before.chinese.ink*1.15,'Chinese bold must add visible stroke weight');
}

async function run() {
  await app.whenReady();
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  server = new Server({ hostKeys: [hostKey] }, client => {
    connections.add(client); client.on('error', () => {}); client.on('close', () => connections.delete(client));
    client.on('authentication', c => c.method === 'password' && c.username === 'fixture' && c.password === 'loopback-only' ? c.accept() : c.reject(['password']));
    client.on('ready', () => client.on('session', accept => {
      const remote = accept(); let dimensions = { cols: 100, rows: 30 };
      remote.on('pty', (accept, _reject, info) => { dimensions = info; accept?.(); });
      remote.on('window-change', (accept, _reject, info) => {
        metrics.firstResizeMs??=Date.now()-started;
        dimensions = info; metrics.resize.push({ cols: info.cols, rows: info.rows });
        bridge?.stdin.write(JSON.stringify({ resize: [info.cols, info.rows] }) + '\n'); accept?.();
      });
      remote.on('shell', accept => {
        const stream = accept();
        const beginPty = () => {
          const fixture = path.resolve('tests/fixtures/tmux-pty.py');
          const linux = `/mnt/${fixture[0].toLowerCase()}${fixture.slice(2).replaceAll('\\', '/')}`;
          bridge = spawn('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'python3', '-u', linux, socketName, String(dimensions.cols), String(dimensions.rows)], { windowsHide: true });
          bridge.stdout.on('data', data => { output += data.toString(); stream.write(data); });
          bridge.stderr.on('data', data => { bridgeStderr += data.toString(); });
          bridge.on('close', code => { stream.exit(code ?? 1); stream.end(); });
          stream.on('close', () => bridge?.stdin.end());
        };
        stream.on('data', data => {
          if (!bridge) {
            replies += data.toString('latin1');
            if (/\x1b\[\?1;2c/.test(replies) && /\x1b\[>0;276;0c/.test(replies) && /\x1b\[\d+;\d+R/.test(replies)) {
              metrics.queries = ['primary DA', 'secondary DA', 'cursor position'];
              metrics.queryReadyMs = Date.now() - started;
              beginPty();
            }
          } else bridge.stdin.write(JSON.stringify({ input: Buffer.from(data).toString('base64') }) + '\n');
        });
        // This goes through actual TerminalView -> xterm -> onData -> preload -> SSH.
        stream.write('\x1b[c\x1b[>c\x1b[6n');
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = { id: 'fixture', name: 'render regression', host: '127.0.0.1', port: server.address().port, username: 'fixture', auth: 'password', rememberHost: false, encoding: 'utf8' };
  service = new SshService(event => {
    if (event.type === 'hostKey') service.confirmHostKey(event.requestId, 'once');
    else {
      if (event.type === 'terminal') metrics.bytes += event.bytes;
      if (window && !window.isDestroyed()) window.webContents.send('terminal-fixture:event', event);
    }
  }, path.join(userData, 'known.json'));
  ipcMain.handle('terminal-fixture:connect', async event => {
    assert.equal(event.sender, window.webContents);
    session = await service.connect({ profile, password: 'loopback-only' }); return session;
  });
  ipcMain.handle('terminal-fixture:font-catalog',async event=>{
    assert.equal(event.sender,window.webContents);
    const catalog=systemFontCatalog();
    await until(()=>metrics.resize.length>0,'terminal resizes before the full font catalog is returned',2_000);
    const result=await catalog;
    metrics.catalogReturnedMs=Date.now()-started;
    assert.ok(metrics.firstResizeMs<=metrics.catalogReturnedMs);
    return result;
  });
  ipcMain.on('terminal-fixture:call', (event, method, args) => {
    if (event.sender !== window.webContents || !['terminalInput', 'terminalBinaryInput', 'terminalResize', 'terminalAck'].includes(method)) return;
    if (method === 'terminalAck') metrics.acked += args[1];
    service[method](...args);
  });
  window = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: { preload: path.resolve('tests/fixtures/terminal-render-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('render-process-gone', (_event, details) => metrics.rendererErrors.push(details));
  window.webContents.on('console-message', (_event, details, message) => metrics.console.push(typeof details === 'object' ? details.message : message));
  phase = 'load actual TerminalView';
  await window.loadURL(url);
  phase = 'device query replies';
  await until(() => metrics.queries.length === 3, phase);
  phase = 'tmux alternate buffer';
  await until(async () => (await inspect())?.type === 'alternate', phase);
  await until(async () => {const state=await inspect();return state?.fontFamily.startsWith('"GooeshellTerminal')&&!state.fontWarning;},'physical font catalog and composite family',35_000);
  await settleFrame();
  await input("printf 'RENDER_%s\\n' TMUX_READY\r");
  await until(async () => (await inspect())?.text.includes('RENDER_TMUX_READY'), 'rendered tmux prompt');
  metrics.tmuxReadyMs = Date.now() - started;
  metrics.before = await inspect();
  await fs.writeFile(reportFile + '.before.png', (await window.webContents.capturePage()).toPNG());
  phase = 'live theme changes preserve tmux';
  await window.webContents.executeJavaScript('window.__fixtureOriginalTerminal = window.__fixtureTerminal; window.__fixtureSetTheme("light")');
  await until(async () => { const state = await inspect(); return state?.theme === 'light' && state.foreground !== metrics.before.foreground && state.renders > metrics.before.renders; }, phase);
  metrics.lightTheme = await inspect();
  assert.equal(metrics.lightTheme.sameTerminal, true, 'theme changes must keep the active terminal instance');
  assert.equal(metrics.lightTheme.type, 'alternate');
  assert.equal(metrics.lightTheme.cols, metrics.before.cols);
  assert.equal(metrics.lightTheme.rows, metrics.before.rows);
  assert.match(metrics.lightTheme.text, /RENDER_TMUX_READY/);
  assert.notEqual(metrics.lightTheme.background, metrics.before.background);
  assert.notEqual(metrics.lightTheme.cursor, metrics.before.cursor);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const lightScreenshot = await window.webContents.capturePage();
  await fs.writeFile(reportFile + '.light.png', lightScreenshot.toPNG());
  const lightSize = lightScreenshot.getSize();
  metrics.lightBackgroundPixel = [...lightScreenshot.crop({ x: Math.floor(lightSize.width / 2), y: Math.floor(lightSize.height / 2), width: 1, height: 1 }).toBitmap()];
  assert.ok(metrics.lightBackgroundPixel.slice(0, 3).every(channel => channel > 240), 'the actual terminal background must be white, not only its outer container');
  await input("printf 'RENDER_%s\\n' LIGHT_RESPONSIVE\r");
  await until(async () => (await inspect())?.renderedText?.includes('RENDER_LIGHT_RESPONSIVE'), 'input after light theme');
  await window.webContents.executeJavaScript('window.__fixtureSetTheme("dark")');
  await until(async () => { const state = await inspect(); return state?.theme === 'dark' && state.foreground === metrics.before.foreground; }, 'restore dark theme');
  metrics.darkTheme = await inspect();
  assert.equal(metrics.darkTheme.sameTerminal, true);
  assert.equal(metrics.darkTheme.type, 'alternate');
  assert.match(metrics.darkTheme.text, /RENDER_LIGHT_RESPONSIVE/);
  assert.equal(metrics.darkTheme.background, metrics.before.background);
  phase='independent Chinese weight keeps English pixels';
  await input(`printf '%s\\n' '${pixelSamples.english}' '${pixelSamples.chinese}'\r`);
  await until(async()=>{const state=await inspect();return state?.renderedText?.includes(pixelSamples.chinese);},'rendered multilingual pixel samples');
  metrics.chineseRegular=await captureFontSamples('chinese-regular');
  await selectFonts({chineseFontWeight:700},phase);
  metrics.chineseBold=await captureFontSamples('chinese-bold');
  verifyChineseOnly(metrics.chineseRegular,metrics.chineseBold);
  phase='Chinese weight overrides a Latin family containing CJK glyphs';
  await selectFonts({fontFamily:'Microsoft YaHei',fontWeight:400,chineseFontWeight:400},'system Latin font baseline');
  metrics.systemChineseRegular=await captureFontSamples('system-chinese-regular');
  await selectFonts({chineseFontWeight:700},phase);
  metrics.systemChineseBold=await captureFontSamples('system-chinese-bold');
  verifyChineseOnly(metrics.systemChineseRegular,metrics.systemChineseBold);
  await input("printf 'RENDER_%s\\n' CHINESE_WEIGHT_RESPONSIVE\r");
  await until(async()=>(await inspect())?.renderedText?.includes('RENDER_CHINESE_WEIGHT_RESPONSIVE'),'input after independent Chinese weight');
  await selectFonts({fontFamily:'DejaVu Sans Mono',fontWeight:400,chineseFontWeight:400},'restore bundled font');
  phase = 'live font family and bold changes preserve tmux';
  await selectFonts({fontFamily:'JetBrains Mono',fontWeight:700},phase);
  await input("printf 'RENDER_%s\\n' BOLD_RESPONSIVE\r");
  await until(async () => (await inspect())?.renderedText?.includes('RENDER_BOLD_RESPONSIVE'), 'input after bold font');
  metrics.boldFont = await inspect();
  assert.equal(metrics.boldFont.sameTerminal, true);
  assert.equal(metrics.boldFont.type, 'alternate');
  assert.equal(metrics.boldFont.fontWeight,400);
  assert.equal(metrics.boldFont.fontSelection.fontWeight,700);
  assert.equal(metrics.boldFont.fontWeightBold, 700);
  const alias=metrics.boldFont.fontFamily.split(',')[0].replaceAll('"','');
  assert.ok(metrics.boldFont.fontFaces.some(face => face.family.replaceAll('"','')===alias && face.weight === '400' && face.status === 'loaded'), 'xterm must measure the loaded composite normal slot');
  assert.ok(Math.abs(metrics.boldFont.cols - metrics.before.cols) <= 3, 'the two fonts have similar monospaced cell widths; a much wider grid indicates fallback measurement');
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fs.writeFile(reportFile + '.bold.png', (await window.webContents.capturePage()).toPNG());
  await selectFonts({fontFamily:'DejaVu Sans Mono',fontWeight:400},'restore regular font');
  await until(async () => { const state = await inspect(); return state?.cols === metrics.before.cols && state.rows === metrics.before.rows; }, 'restore regular font and terminal grid');
  metrics.regularFont = await inspect();
  assert.equal(metrics.regularFont.sameTerminal, true);
  assert.equal(metrics.regularFont.type, 'alternate');
  assert.match(metrics.regularFont.text, /RENDER_BOLD_RESPONSIVE/);
  phase = 'tmux split';
  await input('\x02"');
  await input("printf 'RENDER_%s\\n' SPLIT_READY\r");
  await until(async () => (await inspect())?.text.includes('RENDER_SPLIT_READY'), phase);
  phase = '2 MB burst';
  await input(`python3 -c 'import sys;sys.stdout.write(("0123456789"*10+"\\n")*20000);print("RENDER_BURST_"+"DONE")'\r`);
  await until(async () => (await inspect())?.text.includes('RENDER_BURST_DONE'), phase);
  phase = 'post-burst prompt';
  await input("printf 'RENDER_%s\\n' STILL_RESPONSIVE\r");
  await until(async () => (await inspect())?.text.includes('RENDER_STILL_RESPONSIVE'), phase);
  await until(() => metrics.acked === metrics.bytes, 'all xterm write callbacks acknowledged');
  phase = 'post-burst render event';
  await until(async () => (await inspect())?.renderedText?.includes('RENDER_STILL_RESPONSIVE'), phase);
  await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await delay(100);
  metrics.after = await inspect();
  assert.ok(metrics.after.renders > metrics.before.renders);
  assert.ok(metrics.after.canvas > 0, 'real canvas/WebGL renderer is attached');
  await fs.writeFile(reportFile + '.after.png', (await window.webContents.capturePage()).toPNG());
  assert.equal(bridgeStderr, '');
  assert.equal(metrics.rendererErrors.length, 0);
  metrics.success = true;
}

run().catch(async error => {
  metrics.success = false; metrics.error = error.stack || String(error); metrics.phase = phase;
  metrics.bridgeStderr = bridgeStderr; metrics.replies = replies; metrics.outputTail = output.slice(-3000);
  if (window && !window.isDestroyed()) {
    try { metrics.screen = await inspect(); await fs.writeFile(reportFile + '.failure.png', (await window.webContents.capturePage()).toPNG()); } catch {}
  }
}).finally(async () => {
  metrics.elapsedMs = Date.now() - started;
  bridge?.stdin.end(); service?.shutdown();
  for (const connection of connections) connection.end();
  if (server) await new Promise(resolve => server.close(() => resolve()));
  if (bridge && bridge.exitCode === null) await Promise.race([new Promise(resolve => bridge.once('close', resolve)), delay(3000)]);
  if (window && !window.isDestroyed()) window.destroy();
  await fs.writeFile(reportFile, JSON.stringify(metrics, null, 2));
  app.exit(metrics.success ? 0 : 1);
});
