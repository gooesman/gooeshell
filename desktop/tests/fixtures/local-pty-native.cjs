const assert = require('node:assert/strict');
const {promises: fs} = require('node:fs');
const path = require('node:path');
const {LocalPtyService} = require('../../dist-main/main/local-pty-service.js');
const artifacts = process.env.GOOESHELL_LOCAL_PTY_NATIVE_ARTIFACTS;
if (!artifacts || !path.isAbsolute(artifacts) || !path.basename(artifacts).startsWith('local-pty-native-')) throw new Error('Explicit isolated fixture directory required');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 10000) { const deadline = Date.now() + timeout; while (!await predicate()) { if (Date.now() > deadline) throw new Error('Timeout: ' + message); await delay(20); } }
const report = {success: false, versions: process.versions, checks: {}, shells: []};
const events = [], ptys = [];
let ack = true;
const ptyModule = require('node-pty');
const service = new LocalPtyService(event => {
  events.push(event);
  if (ack && event.type === 'terminal') queueMicrotask(() => service.terminalAck(event.sessionId, event.bytes));
}, (file, args, options) => {
  const name = path.basename(file).toLowerCase();
  const cleanArgs = /^(pwsh|powershell)\.exe$/.test(name) ? [...args, '-NoProfile'] : name === 'bash' ? ['--noprofile', '--norc'] : name === 'zsh' ? ['-d', '-f'] : name === 'fish' ? ['--no-config'] : name === 'sh' ? [] : args;
  const env = {...options.env}; delete env.ENV; delete env.BASH_ENV;
  const pty = ptyModule.spawn(file, cleanArgs, {...options, env}); ptys.push(pty); return pty;
});
const output = id => Buffer.concat(events.filter(event => event.type === 'terminal' && event.sessionId === id).map(event => Buffer.from(event.data, 'base64'))).toString('utf8').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
const closed = id => events.filter(event => event.type === 'sessionClosed' && event.sessionId === id);
const emittedBytes = id => events.filter(event => event.type === 'terminal' && event.sessionId === id).reduce((sum, event) => sum + event.bytes, 0);
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function run() {
  const shells = await service.listLocalShells(); report.shells = shells;
  for (const option of shells.filter(shell => shell.available && (process.platform !== 'win32' ? shell.isDefault : ['pwsh', 'powershell', 'cmd'].includes(shell.id)))) {
    const session = await service.createLocalSession({shell: option.id, cwd: artifacts});
    await delay(200); assert.equal(events.filter(event => event.type === 'terminal' && event.sessionId === session.id).length, 0);
    service.terminalResize(session.id, 120, 40);
    const cmd = option.id === 'cmd';
    const send = text => service.terminalInput(session.id, text + '\r');
    send(cmd ? 'echo LOCAL_中文' : process.platform === 'win32' ? "[Console]::WriteLine('LOCAL_'+'中文')" : "printf 'LOCAL_%s\\n' '中文'");
    await until(() => cmd ? (output(session.id).match(/LOCAL_中文/g) || []).length >= 2 : output(session.id).includes('LOCAL_中文'), option.id + ' Chinese');
    report.checks[option.id + ':chinese'] = true;
    send(cmd ? 'cd' : process.platform === 'win32' ? "[Console]::WriteLine('CWD='+ (Get-Location).Path)" : "printf 'CWD=%s\\n' \"$PWD\"");
    await until(() => cmd ? output(session.id).includes(artifacts) : output(session.id).includes('CWD=' + artifacts), option.id + ' working directory');
    report.checks[option.id + ':cwd'] = true;
    if (!cmd && process.platform === 'win32') {
      send("[Console]::WriteLine('SIZE='+[Console]::WindowWidth+','+[Console]::WindowHeight)");
      await until(() => output(session.id).includes('SIZE=120,40'), option.id + ' initial dimensions');
      service.terminalResize(session.id, 97, 31);
      send("[Console]::WriteLine('RESIZE='+[Console]::WindowWidth+','+[Console]::WindowHeight)");
      await until(() => output(session.id).includes('RESIZE=97,31'), option.id + ' resize');
    } else { service.terminalResize(session.id, 97, 31); await delay(100); }
    report.checks[option.id + ':resize'] = true;
    send(cmd ? 'ping -t 127.0.0.1' : process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30');
    await delay(200); service.terminalInput(session.id, '\x03'); await delay(300);
    send(cmd ? 'echo CTRL_C_OK' : process.platform === 'win32' ? "[Console]::WriteLine('CTRL_'+'C_OK')" : "printf 'CTRL_%s\\n' 'C_OK'");
    await until(() => cmd ? (output(session.id).match(/CTRL_C_OK/g) || []).length >= 2 : output(session.id).includes('CTRL_C_OK'), option.id + ' Ctrl+C'); report.checks[option.id + ':ctrlC'] = true;
    if (option.id === 'pwsh' || process.platform !== 'win32') {
      ack = false;
      const start = emittedBytes(session.id);
      send(process.platform === 'win32' ? "for($i=0;$i -lt 40000;$i++){[Console]::WriteLine(('BULKROW-{0:D8}-abcdefghijklmnopqrstuvwxyz0123456789' -f $i))}; [Console]::WriteLine('BULK_'+'DONE')" : "i=0; while [ $i -lt 40000 ]; do printf 'BULKROW-%08d-abcdefghijklmnopqrstuvwxyz0123456789\\n' $i; i=$((i+1)); done; printf 'BULK_%s\\n' DONE");
      await until(() => emittedBytes(session.id) - start >= 512 * 1024, option.id + ' bulk high-water');
      await delay(300); assert.ok(!output(session.id).includes('BULK_DONE'));
      ack = true;
      const outstanding = emittedBytes(session.id) - start;
      service.terminalAck(session.id, outstanding);
      await until(() => output(session.id).includes('BULK_DONE'), option.id + ' ACK resumed', 20000);
      assert.ok((output(session.id).match(/BULKROW-\d{8}-abcdefghijklmnopqrstuvwxyz0123456789/g) || []).length >= 40000); report.checks[option.id + ':bulkAck'] = true;
    }
    const pid = ptys.at(-1).pid;
    send('exit'); await until(() => closed(session.id).length === 1, option.id + ' exit'); assert.equal(processAlive(pid), false);
    service.disconnect(session.id); assert.equal(closed(session.id).length, 1); report.checks[option.id + ':exit'] = true;
  }
  const early = await service.createLocalSession({cwd: artifacts}), earlyPid = ptys.at(-1).pid;
  service.disconnect(early.id);
  await until(() => !processAlive(earlyPid), 'disconnect before first resize'); report.checks.earlyDisconnect = true;
  const nodeExe = process.env.GOOESHELL_LOCAL_PTY_NODE_EXE;
  if (!nodeExe || !path.isAbsolute(nodeExe)) throw new Error('Explicit Node executable required for owned child fixture');
  const childScript = path.join(artifacts, 'owned-child.cjs'), pidFile = path.join(artifacts, 'owned-child.pid');
  await fs.writeFile(childScript, "require('node:fs').writeFileSync(process.argv[2],String(process.pid)); setInterval(()=>{},1000);\n");
  const tree = await service.createLocalSession({shell: process.platform === 'win32' ? 'cmd' : undefined, cwd: artifacts}), treePid = ptys.at(-1).pid;
  service.terminalResize(tree.id, 80, 24);
  const quote = value => process.platform === 'win32' ? '"' + value + '"' : "'" + value.replace(/'/g, "'\\''") + "'";
  service.terminalInput(tree.id, [nodeExe, childScript, pidFile].map(quote).join(' ') + '\r');
  let childPid;
  await until(async () => { try { childPid = Number(await fs.readFile(pidFile, 'utf8')); return Number.isSafeInteger(childPid) && childPid > 0; } catch { return false; } }, 'owned child pid');
  service.disconnect(tree.id);
  await until(() => !processAlive(treePid) && !processAlive(childPid), 'owned process tree released'); report.checks.processTree = true;
  const fresh = await service.createLocalSession({cwd: artifacts});
  const freshPid = ptys.at(-1).pid;
  service.terminalInput(early.id, 'INVALID_STALE_INPUT'); assert.equal(service.has(early.id), false);
  await service.shutdown(); await until(() => !processAlive(freshPid), 'shutdown tree'); report.checks.shutdown = true;
  report.success = true;
}
run().catch(error => { report.error = error.stack || String(error); }).finally(async () => { await service.shutdown(); await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify(report, null, 2)); process.exit(report.success ? 0 : 1); });
