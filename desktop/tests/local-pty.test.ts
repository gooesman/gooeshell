import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import type {IPty} from 'node-pty';
import {LocalPtyService, discoverLocalShells, type PtySpawn, type ShellEnvironment} from '../src/main/local-pty-service';
import type {AppEvent} from '../src/shared/types';

class FakePty {
  pid = 123; cols = 80; rows = 24; process = 'fixture'; handleFlowControl = false;
  paused = 0; resumed = 0; killed = 0; sizes: number[][] = []; input: (string | Buffer)[] = [];
  data?: (data: string) => void;
  private exits = new Set<(event: {exitCode: number; signal?: number}) => void>();
  exit = (event: {exitCode: number; signal?: number}) => { for (const listener of [...this.exits]) listener(event); };
  onData = (listener: (data: string) => void) => { this.data = listener; return {dispose: () => { this.data = undefined; }}; };
  onExit = (listener: (event: {exitCode: number; signal?: number}) => void) => { this.exits.add(listener); return {dispose: () => { this.exits.delete(listener); }}; };
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  clear() {}
  write(data: string | Buffer) { this.input.push(data); }
  kill() { this.killed++; this.exit?.({exitCode: 0}); }
  pause() { this.paused++; }
  resume() { this.resumed++; }
}
const context: ShellEnvironment = {platform: 'win32', home: os.tmpdir(), env: {PATH: 'C:\\fixture', SystemRoot: 'C:\\Windows'}, executable: async file => file === 'C:\\fixture\\pwsh.exe' || file.endsWith('\\cmd.exe')};
function fixture() {
  const ptys: FakePty[] = [], events: AppEvent[] = [], spawns: {file: string; args: string[]; options: unknown}[] = [];
  const spawn: PtySpawn = (file, args, options) => { const pty = new FakePty(); ptys.push(pty); spawns.push({file, args, options}); return pty as IPty; };
  const service = new LocalPtyService(event => events.push(event), spawn, context);
  const output = (id: string) => Buffer.concat(events.flatMap(event => event.type === 'terminal' && event.sessionId === id ? [Buffer.from(event.data, 'base64')] : []));
  return {service, ptys, events, spawns, output};
}

test('shell catalog resolves Windows installations and never silently substitutes a missing selected shell', async () => {
  const f = fixture();
  const shells = await f.service.listLocalShells();
  assert.equal(shells.find(shell => shell.id === 'pwsh')?.isDefault, true);
  assert.equal(shells.find(shell => shell.id === 'powershell')?.available, false);
  await assert.rejects(f.service.createLocalSession({shell: 'powershell'}), /Windows PowerShell 未安装/);
  await assert.rejects(f.service.createLocalSession({shell: 'arbitrary-command'}), /未安装或不可用/);
  assert.equal(f.spawns.length, 0);
  const session = await f.service.createLocalSession();
  assert.equal(session.shell, 'pwsh'); assert.equal(session.kind, 'local'); assert.ok(!('profile' in session));
  assert.equal(f.spawns[0].file, 'C:\\fixture\\pwsh.exe'); assert.deepEqual(f.spawns[0].args, ['-NoLogo']);
  f.service.shutdown();
});
test('POSIX default shell follows the system account, detects fallback and retains unavailable choices', async () => {
  const shells = await discoverLocalShells({platform: 'darwin', env: {SHELL: '/bin/bash', PATH: '/bin'}, home: '/home/fixture', userShell: '/bin/zsh', executable: async file => ['/bin/zsh', '/bin/bash', '/bin/sh'].includes(file)});
  assert.equal(shells[0].path, '/bin/zsh'); assert.equal(shells[0].isDefault, true);
  const fallback = await discoverLocalShells({platform: 'linux', env: {}, home: '/home/fixture', userShell: '/missing/shell', executable: async file => file === '/bin/sh'});
  assert.equal(fallback[0].path, '/bin/sh'); assert.equal(fallback.find(shell => shell.id === 'bash')?.available, false);
  const envFallback = await discoverLocalShells({platform: 'linux', env: {SHELL: '/bin/bash'}, home: '/home/fixture', userShell: '/missing/shell', executable: async file => ['/bin/zsh', '/bin/bash'].includes(file)});
  assert.equal(envFallback[0].path, '/bin/bash');
});
test('startup output waits for the renderer; UTF-8, binary input, resize and ACK resume without losing bytes', async () => {
  const f = fixture(), session = await f.service.createLocalSession();
  const pty = f.ptys[0];
  const raw = '\x1b[32m中文终端😀\x1b[0m\r\n'; pty.data!(raw);
  assert.equal(f.events.length, 0); assert.equal(pty.paused, 0);
  await Promise.resolve();
  f.service.terminalResize(session.id, 120, 40);
  assert.equal(f.output(session.id).toString('utf8'), raw);
  for (const event of f.events) if (event.type === 'terminal') assert.equal(Buffer.from(event.data, 'base64').length, event.bytes);
  f.service.terminalInput(session.id, 'echo 中文\r');
  f.service.terminalBinaryInput(session.id, '\x1b[M\x20\x80\xff');
  assert.equal(pty.input[0], 'echo 中文\r'); assert.deepEqual(pty.input[1], Buffer.from('\x1b[M\x20\x80\xff', 'latin1'));
  f.service.terminalResize(session.id, 120, 40); f.service.terminalResize(session.id, 0, 3);
  assert.deepEqual(pty.sizes, [[120, 40]]);
  f.service.terminalAck(session.id, Buffer.byteLength(raw));
  const bulk = 'x'.repeat(512 * 1024); pty.data!(bulk); pty.data!('tail');
  assert.equal(pty.paused, 1); assert.equal(f.output(session.id).length, Buffer.byteLength(raw) + bulk.length);
  f.service.terminalAck(session.id, NaN); f.service.terminalAck(session.id, -1);
  assert.equal(pty.resumed, 0);
  f.service.terminalAck(session.id, bulk.length);
  assert.equal(pty.resumed, 1); assert.equal(f.output(session.id).toString('utf8'), raw + bulk + 'tail');
  f.service.shutdown();
});
test('exit is delivered once after startup text, old sessions cannot reach replacements, shutdown kills owned PTYs', async () => {
  const f = fixture(), first = await f.service.createLocalSession();
  f.ptys[0].data!('last output'); f.ptys[0].exit!({exitCode: 17});
  assert.equal(f.events.length, 0);
  f.service.terminalResize(first.id, 80, 24);
  assert.equal(f.output(first.id).toString(), 'last output'); assert.equal(f.service.has(first.id), false);
  f.service.disconnect(first.id);
  assert.equal(f.events.filter(event => event.type === 'sessionClosed' && event.sessionId === first.id).length, 1);
  const second = await f.service.createLocalSession(); assert.notEqual(first.id, second.id);
  f.service.terminalInput(first.id, 'stale'); f.service.terminalResize(first.id, 100, 50); f.service.terminalAck(first.id, 10000);
  assert.deepEqual(f.ptys[1].input, []); assert.deepEqual(f.ptys[1].sizes, []);
  f.service.shutdown(); f.service.shutdown();
  assert.equal(f.ptys[1].killed, 1);
  assert.equal(f.events.filter(event => event.type === 'sessionClosed' && event.sessionId === second.id).length, 1);
  await assert.rejects(f.service.createLocalSession(), /应用正在退出/);
});
test('invalid CWD and dimensions do not launch any process; multiline command insertion requires bracketed paste', async () => {
  const f = fixture();
  await assert.rejects(f.service.createLocalSession({cwd: 'relative'}), /绝对工作目录/);
  await assert.rejects(f.service.createLocalSession({cols: 0}), /尺寸无效/);
  assert.equal(f.spawns.length, 0);
  const session = await f.service.createLocalSession();
  assert.throws(() => f.service.terminalCommandInput(session.id, 'echo one\necho two', 'insert', false), /未启用括号粘贴/);
  f.service.terminalCommandInput(session.id, 'echo one\necho two', 'insert', true);
  assert.deepEqual(f.ptys[0].input, ['\x1b[200~echo one\recho two\x1b[201~']);
  f.service.shutdown();
});
test('a failure while attaching PTY output listeners kills the just-created process and leaves no live session', async () => {
  const events: AppEvent[] = [], pty = new FakePty();
  pty.onData = () => { throw new Error('fixture listener failed'); };
  const service = new LocalPtyService(event => events.push(event), () => pty as IPty, context);
  await assert.rejects(service.createLocalSession(), /本地终端启动失败：fixture listener failed/);
  assert.equal(pty.killed, 1);
  const closed = events.find(event => event.type === 'sessionClosed');
  assert.ok(closed && closed.type === 'sessionClosed'); assert.equal(service.has(closed.sessionId), false);
  await service.shutdown();
});
