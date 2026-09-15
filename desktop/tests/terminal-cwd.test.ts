import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Server, type Client } from 'ssh2';
import { readTerminalDirectory, TERMINAL_CWD_PYTHON } from '../src/main/terminal-cwd';
import { SshService } from '../src/main/ssh-service';

class ProbeChannel extends EventEmitter {
  stderr = new EventEmitter();
  writes: unknown[] = [];
  ended = false;
  closed = false;
  end() { this.ended = true; }
  close() { this.closed = true; }
  write(value: unknown) { this.writes.push(value); }
}
function probe() {
  const channel = new ProbeChannel();
  let command = '';
  const client = { exec(source: string, options: unknown, callback: Function) {
    command = source; assert.deepEqual(options, { pty: false }); callback(null, channel);
  } } as unknown as Client;
  return { channel, client, result(value: unknown) {
    const marker = command.match(/GOOESHELL_CWD_[a-f0-9]+$/)![0];
    const encoded = `${marker}:${Buffer.from(JSON.stringify(value)).toString('base64')}\n`;
    channel.emit('data', Buffer.from('Noninteractive banner\n' + encoded.slice(0, 17)));
    channel.emit('data', Buffer.from(encoded.slice(17)));
  } };
}

test('directory probe observes a separate exec channel and keeps shell input untouched', async () => {
  const fixture = probe(), pending = readTerminalDirectory(fixture.client);
  fixture.result({ ok: true, value: { path: "/tmp/中文 folder/' odd\nname", source: 'shell' } });
  assert.deepEqual(await pending, { path: "/tmp/中文 folder/' odd\nname", source: 'shell' });
  assert.deepEqual(fixture.channel.writes, []);
  assert.equal(fixture.channel.ended, true);
});

test('directory probe rejects ambiguous or malformed results rather than following another tab', async () => {
  const unsupported = probe(), pending = readTerminalDirectory(unsupported.client);
  unsupported.result({ ok: false, error: '无法唯一识别此连接的终端目录' });
  await assert.rejects(pending, /无法唯一识别/);
  for (const value of [{ path: '../other', source: 'shell' }, { path: '/tmp\0bad', source: 'tmux' }, { path: '/tmp', source: 'other' }]) {
    const fixture = probe(), invalid = readTerminalDirectory(fixture.client);
    fixture.result({ ok: true, value });
    await assert.rejects(invalid, /终端目录无效/);
  }
});

test('directory probe releases its channel when disconnected, timed out, or unsupported', async () => {
  const fixture = probe(), controller = new AbortController();
  const pending = readTerminalDirectory(fixture.client, controller.signal);
  controller.abort(); await assert.rejects(pending, /连接已关闭/); assert.equal(fixture.channel.closed, true);
  const slow = probe(), timed = readTerminalDirectory(slow.client, undefined, 10);
  await assert.rejects(timed, /超时/); assert.equal(slow.channel.closed, true);
  const noPython = probe(), unavailable = readTerminalDirectory(noPython.client);
  noPython.channel.stderr.emit('data', Buffer.from('python3: command not found'));
  noPython.channel.emit('close');
  await assert.rejects(unavailable, /Python 3/);
});

test('real SSH probes use each terminal own authenticated transport and coalesce concurrent queries', { timeout: 15000 }, async t => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'gooeshell-cwd-ssh-'));
  const clients = new Set<any>();
  let transports = 0, execs = 0, terminalWrites = 0;
  const server = new Server({ hostKeys: [key] }, client => {
    const identity = ++transports; clients.add(client);
    client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => context.method === 'password' && context.password === 'fixture-only' ? context.accept() : context.reject(['password']));
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', accept => accept?.());
      session.on('shell', accept => { const shell = accept(); shell.on('data', () => terminalWrites++); });
      session.on('exec', (accept, _reject, info) => {
        execs++;
        const channel = accept(), marker = info.command.match(/GOOESHELL_CWD_[a-f0-9]+$/)?.[0];
        assert.ok(marker);
        setTimeout(() => {
          channel.write(`${marker}:${Buffer.from(JSON.stringify({ ok: true, value: { path: `/connection-${identity}`, source: 'shell' } })).toString('base64')}\n`);
          channel.exit(0); channel.end();
        }, 20);
      });
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const service = new SshService(event => { if (event.type === 'hostKey') service.confirmHostKey(event.requestId, 'once'); }, path.join(folder, 'known.json'));
  t.after(async () => {
    service.shutdown(); for (const client of clients) client.end();
    await new Promise<void>(resolve => server.close(() => resolve())); await fs.rmdir(folder);
  });
  const profile = { id: 'fixture', name: 'Fixture', host: '127.0.0.1', port: (server.address() as { port: number }).port, username: 'test', auth: 'password' as const, encoding: 'utf8' as const, rememberHost: false };
  const first = await service.connect({ profile, password: 'fixture-only' });
  const second = await service.connect({ profile, password: 'fixture-only' });
  const results = await Promise.all([service.terminalCwd({ sessionId: first.id }), service.terminalCwd({ sessionId: first.id }), service.terminalCwd({ sessionId: second.id })]);
  assert.deepEqual(results.map(result => result.path), ['/connection-1', '/connection-1', '/connection-2']);
  assert.equal(transports, 2, 'directory reads must not authenticate a new control connection');
  assert.equal(execs, 2, 'concurrent reads per terminal share one probe');
  assert.equal(terminalWrites, 0);
  service.disconnect(first.id);
  assert.throws(() => service.terminalCwd({ sessionId: first.id }), /已断开/);
});

const wsl = process.env.GOOESHELL_CWD_WSL_TEST === '1';
test('Linux PTYs follow separate shell directories and each tmux client active pane', {
  skip: !wsl && process.platform !== 'linux' ? 'Set GOOESHELL_CWD_WSL_TEST=1 with local Ubuntu-24.04' : false,
  timeout: 45_000,
}, () => {
  const fixture = readFileSync(new URL('./fixtures/terminal-cwd.py', import.meta.url), 'utf8');
  const output = execFileSync(wsl ? 'wsl.exe' : 'python3',
    wsl ? ['-d', 'Ubuntu-24.04', '--', 'python3', '-I', '-c', fixture] : ['-I', '-c', fixture],
    { input: TERMINAL_CWD_PYTHON, encoding: 'utf8', timeout: 40_000, maxBuffer: 1024 * 1024, windowsHide: true });
  assert.deepEqual(JSON.parse(output), { shell: true, separateConnections: true, tmux: true, activePane: true, nestedSsh: true, ambiguousPty: true });
});
