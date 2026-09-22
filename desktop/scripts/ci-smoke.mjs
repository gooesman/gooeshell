import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

const [target, arch] = process.argv.slice(2);
const platform = { win: 'win32', mac: 'darwin', linux: 'linux' }[target];
assert.equal(process.platform, platform, 'Smoke tests must use a native runner');
assert.equal(process.arch, arch, 'Smoke tests must use the native architecture');
const release = path.resolve(process.env.GOOESHELL_SMOKE_RELEASE || 'release');
const defaultExecutable = target === 'win' ? path.join(release, 'win-unpacked/gooeshell.exe')
  : target === 'mac' ? path.join(release, arch === 'arm64' ? 'mac-arm64' : 'mac', 'gooeshell.app/Contents/MacOS/gooeshell')
  : path.join(release, 'linux-unpacked/gooeshell');
const executable = process.env.GOOESHELL_SMOKE_EXECUTABLE ? path.resolve(process.env.GOOESHELL_SMOKE_EXECUTABLE) : defaultExecutable;
const nodeExecutable = process.env.GOOESHELL_SMOKE_NODE_EXECUTABLE ? path.resolve(process.env.GOOESHELL_SMOKE_NODE_EXECUTABLE) : executable;
const packageLabel = process.env.GOOESHELL_SMOKE_PACKAGE || '';
assert.match(packageLabel, /^[a-zA-Z0-9-]*$/, 'Invalid package smoke label');
await fs.access(executable);
await fs.access(nodeExecutable);
const output = path.resolve('test-output');
await fs.mkdir(output, { recursive: true });
const data = await fs.mkdtemp(path.join(output, 'smoke-data-'));
const reportFile = path.join(output, `smoke-${target}-${arch}${packageLabel ? '-' + packageLabel : ''}.json`);
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.GOOESHELL_DEV_URL;
const started = Date.now();
const diagnostics = { phase: 'launch', phases: [], commands: [], events: [] };
function phase(name) { diagnostics.phase = name; diagnostics.phases.push({ name, elapsedMs: Date.now() - started }); }
const child = spawn(executable, [
  `--user-data-dir=${data}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
  // Ubuntu hosted runners restrict user namespaces; this is limited to the disposable CI launch.
  ...(target === 'linux' ? ['--no-sandbox'] : []),
], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
let launchError;
child.stdout.on('data', bytes => { logs = (logs + bytes.toString()).slice(-12_000); });
child.stderr.on('data', bytes => { logs = (logs + bytes.toString()).slice(-12_000); });
child.once('error', error => { launchError = error; });
const stopped = new Promise(resolve => child.once('close', resolve));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deadline = started + 45_000;
let socket;
let nextId = 0;
const pending = new Map();
async function call(method, params = {}, timeoutMs = Math.max(1, deadline - Date.now())) {
  const id = ++nextId;
  const command = { id, method, phase: diagnostics.phase, startedMs: Date.now() - started };
  diagnostics.commands.push(command);
  const result = new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer); pending.delete(id); command.elapsedMs = Date.now() - started - command.startedMs;
      if (error) { command.error = String(error); reject(error); } else { command.completed = true; resolve(value); }
    };
    const timer = setTimeout(() => finish(new Error(`Packaged application inspection timed out in ${command.phase} (${method})`)), timeoutMs);
    pending.set(id, { resolve: value => finish(undefined, value), reject: error => finish(error) });
    try { socket.send(JSON.stringify({ id, method, params })); } catch (error) { finish(error); }
  });
  return result;
}
async function until(check) {
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Packaged application exited before its home screen became ready');
    const value = await check();
    if (value) return value;
    await pause(150);
  }
  throw new Error(`Packaged application did not become ready within 45 seconds (${diagnostics.phase})`);
}
const watchdog = setTimeout(() => {
  for (const item of [...pending.values()]) item.reject(new Error(`Packaged application inspection timed out in ${diagnostics.phase}`));
  socket?.close();
  child.kill();
}, 50_000);
try {
  phase('discover packaged page');
  const page = await until(async () => {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then(response => response.json());
      return targets.find(item => item.type === 'page' && item.url.startsWith('file:') && item.webSocketDebuggerUrl);
    } catch { return undefined; }
  });
  diagnostics.page = { id: page.id, url: page.url, title: page.title };
  phase('connect page inspector');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method && ['Runtime.exceptionThrown', 'Inspector.targetCrashed', 'Page.javascriptDialogOpening'].includes(message.method)) {
      diagnostics.events.push({ method: message.method, params: message.params, elapsedMs: Date.now() - started });
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const item of [...pending.values()]) item.reject(new Error('Application inspection connection closed'));
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged page inspector did not open before the startup deadline')), Math.max(1, deadline - Date.now()));
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', error => { clearTimeout(timer); reject(error); }, { once: true });
  });
  await call('Runtime.enable'); await call('Page.enable');
  phase('wait for rendered home');
  await until(async () => {
    const result = await call('Runtime.evaluate', {
      expression: 'Boolean(window.gooeshell && document.querySelector("#server-sidebar") && document.body.innerText.includes("快速连接"))', returnByValue: true,
    });
    return result.result?.value;
  });
  phase('read initial settings through packaged IPC');
  const result = await call('Runtime.evaluate', {
    expression: '(async () => { const state = await window.gooeshell.initial(); return { version: state.version, profiles: state.profiles.length, theme: state.settings.theme, title: document.title }; })()',
    returnByValue: true, awaitPromise: true,
  });
  assert.equal(result.exceptionDetails, undefined, 'Packaged preload or main IPC failed');
  const state = result.result.value;
  diagnostics.initial = state;
  phase('read system font catalog through packaged IPC');
  const fontResult = await call('Runtime.evaluate', { expression: '(async () => (await window.gooeshell.fontCatalog()).length)()', returnByValue: true, awaitPromise: true });
  assert.equal(fontResult.exceptionDetails, undefined, 'Packaged font catalog IPC failed');
  state.fonts = fontResult.result.value;
  const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.equal(state.version, version);
  assert.equal(state.profiles, 0, 'Smoke launch must use its isolated settings directory');
  assert.equal(state.theme, 'dark');
  assert.ok(state.fonts > 0, 'Font catalog must provide usable font choices');
  const fileRoot = await fs.mkdtemp(path.join(output, 'smoke-files-'));
  const selected = path.join(fileRoot, 'selected'), leaf = path.join(selected, 'new.txt');
  const keep = path.join(fileRoot, 'keep.txt'); await fs.writeFile(keep, 'outside selected tree');
  phase('exercise packaged file operations');
  const files = await call('Runtime.evaluate', {
    expression: `(async()=>{
      const api=window.gooeshell, request={side:'local',sessionId:''};
      await api.mkdir({...request,path:${JSON.stringify(selected)}});
      await api.createFile({...request,path:${JSON.stringify(leaf)}});
      await api.writeFile({...request,path:${JSON.stringify(leaf)},text:'preserve original'});
      let rejected=false;try{await api.createFile({...request,path:${JSON.stringify(leaf)}});}catch{rejected=true;}
      const text=await api.readFile({...request,path:${JSON.stringify(leaf)}});
      await api.removeFile({...request,path:${JSON.stringify(selected)},recursive:true});
      document.querySelector('[aria-label="展开文件管理"]')?.click();
      await new Promise(resolve=>setTimeout(resolve,50));
      document.querySelector('[aria-label="展开本地文件栏"]')?.click();
      return {rejected,text:text.text,toolbar:!!document.querySelector('.file-actions-toolbar, .file-selection-bar'),followInPathBar:!!document.querySelector('[data-side="remote"] .file-pane-toolbar [aria-label="跟随终端目录"]'),remoteDisabled:document.querySelector('[aria-label="跟随终端目录"]').disabled};
    })()`, returnByValue: true, awaitPromise: true,
  });
  assert.equal(files.exceptionDetails, undefined, 'Packaged file mutation IPC failed');
  assert.deepEqual(files.result.value, {rejected:true,text:'preserve original',toolbar:false,followInPathBar:true,remoteDisabled:true});
  assert.equal(await fs.readFile(keep, 'utf8'), 'outside selected tree');
  assert.equal(await fs.stat(selected).then(()=>true,()=>false), false);
  const resources = target === 'mac' ? path.resolve(path.dirname(nodeExecutable), '../Resources') : path.join(path.dirname(nodeExecutable), 'resources');
  // Load the library from the packaged ASAR with the packaged Node runtime.
  // This catches production dependencies accidentally left in devDependencies.
  const archiveSmoke = String.raw`
    const fs=require('node:fs/promises'),path=require('node:path');
    const {packLocalArchive,extractLocalArchive}=require(process.argv[2]);
    (async()=>{
      const root=process.argv[1],source=path.join(root,'archive-source'),target=path.join(root,'archive-target');
      await fs.mkdir(path.join(source,'空目录'),{recursive:true});await fs.mkdir(target);
      const text='gooeshell 压缩传输';await fs.writeFile(path.join(source,'中文.txt'),text);
      const archive=path.join(root,'smoke.tar.gz'),signal=new AbortController().signal;
      const packed=await packLocalArchive(source,archive,signal);
      const extracted=await extractLocalArchive(archive,target,'archive-source',signal,()=>{},packed.originalBytes);
      if(await fs.readFile(path.join(target,'archive-source','中文.txt'),'utf8')!==text)throw new Error('Archive contents changed');
      if(!(await fs.stat(path.join(target,'archive-source','空目录'))).isDirectory())throw new Error('Missing empty directory');
      if(extracted.entries!==3)throw new Error('Unexpected archive entries');
      console.log(JSON.stringify({entries:extracted.entries,bytes:extracted.originalBytes}));
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  phase('exercise packaged archive dependency');
  const archiveResult = await new Promise((resolve, reject) => execFile(nodeExecutable,
    ['-e', archiveSmoke, fileRoot, path.join(resources, 'app.asar/dist-main/main/local-archive.js')],
    { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 },
    (error, stdout, stderr) => error ? reject(new Error(`Packaged archive smoke failed: ${stderr || error.message}`)) : resolve(JSON.parse(stdout.trim()))));
  phase('complete');
  await fs.writeFile(reportFile, JSON.stringify({ success: true, target, arch, ...state, files:files.result.value, archive:archiveResult, elapsedMs: Date.now() - started, diagnostics }, null, 2) + '\n');
  console.log(`Packaged application smoke passed: ${target}-${arch} ${version}`);
} catch (error) {
  clearTimeout(watchdog);
  // An unresolved async IPC promise does not necessarily stop the renderer.
  // Capture its state without calling that IPC again; bound diagnostics rather
  // than hiding the original failure behind another unbounded inspector call.
  if (socket?.readyState === WebSocket.OPEN) {
    const checks = await Promise.allSettled([
      call('Runtime.evaluate', { expression: '({readyState:document.readyState,title:document.title,visibility:document.visibilityState,focused:document.hasFocus(),preload:!!window.gooeshell,sidebar:!!document.querySelector("#server-sidebar"),text:document.body?.innerText.slice(0,12000),dialogs:document.querySelectorAll("[role=dialog]").length})', returnByValue: true }, 2500),
      call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 2500),
    ]);
    diagnostics.failureSnapshot = checks[0].status === 'fulfilled' ? checks[0].value.result?.value : { error: String(checks[0].reason) };
    // Keep the image with the JSON artifact already collected on every CI host.
    diagnostics.failureScreenshot = checks[1].status === 'fulfilled' ? { format: 'png', base64: checks[1].value.data } : { error: String(checks[1].reason) };
  }
  await fs.writeFile(reportFile, JSON.stringify({ success: false, target, arch, error: String(error), elapsedMs: Date.now() - started, diagnostics, logs }, null, 2) + '\n');
  throw error;
} finally {
  clearTimeout(watchdog);
  socket?.close();
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.race([stopped, pause(3000)]);
}
