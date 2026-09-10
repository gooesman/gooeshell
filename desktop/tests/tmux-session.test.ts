import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from 'ssh2';
import { SshService } from '../src/main/ssh-service';

const enabled = process.env.GOOESHELL_TMUX_WSL_TEST === '1';
test('real tmux can start, split panes and receive SSH window changes', { skip: enabled ? false : 'Set GOOESHELL_TMUX_WSL_TEST=1 with local Ubuntu-24.04/tmux installed', timeout: 30_000 }, async t => {
  const fixture = path.resolve('tests/fixtures/tmux-pty.py');
  const linuxFixture = `/mnt/${fixture[0].toLowerCase()}${fixture.slice(2).replaceAll('\\', '/')}`;
  const socketName = `gooeshell-test-${randomUUID()}`;
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gooeshell-tmux-test-'));
  const connections = new Set<any>();
  let bridge: ChildProcessWithoutNullStreams | undefined;
  let stderr = '';
  let ptyInfo: { term: string; cols: number; rows: number } | undefined;
  const server = new Server({ hostKeys: [key] }, client => {
    connections.add(client); client.on('error', () => {}); client.on('close', () => connections.delete(client));
    client.on('authentication', context => context.method === 'password' && context.username === 'test' && context.password === 'fixture-only' ? context.accept() : context.reject(['password']));
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', (accept, _reject, info) => { ptyInfo = info; accept?.(); });
      session.on('window-change', (accept, _reject, info) => { bridge?.stdin.write(JSON.stringify({ resize: [info.cols, info.rows] }) + '\n'); accept?.(); });
      session.on('shell', accept => {
        const stream = accept();
        bridge = spawn('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'python3', '-u', linuxFixture, socketName, String(ptyInfo!.cols), String(ptyInfo!.rows)], { windowsHide: true });
        bridge.stdout.on('data', data => stream.write(data));
        bridge.stderr.on('data', data => { stderr += data.toString(); });
        bridge.on('close', code => { stream.exit(code ?? 1); stream.end(); });
        stream.on('data', data => bridge?.stdin.write(JSON.stringify({ input: Buffer.from(data).toString('base64') }) + '\n'));
        stream.on('close', () => bridge?.stdin.end());
      });
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let output = '';
  const service = new SshService(event => {
    if (event.type === 'hostKey') service.confirmHostKey(event.requestId, 'once');
    if (event.type === 'terminal') {
      output += Buffer.from(event.data, 'base64').toString('utf8');
      service.terminalAck(event.sessionId, event.bytes);
    }
  }, path.join(directory, 'known.json'));
  t.after(async () => {
    bridge?.stdin.end(); service.shutdown();
    for (const connection of connections) connection.end();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rmdir(directory);
  });
  const session = await service.connect({ profile: { id: 'fixture', name: 'fixture', host: '127.0.0.1', port: (server.address() as { port: number }).port, username: 'test', auth: 'password', rememberHost: false, encoding: 'utf8' }, password: 'fixture-only' });
  assert.equal(ptyInfo?.term, 'xterm-256color');
  service.terminalResize(session.id, 100, 30);
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error(`tmux timed out. stderr=${stderr} output=${JSON.stringify(output.slice(-2500))}`); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  await until(() => output.includes('bash'));
  service.terminalInput(session.id, "printf 'GOOESHELL_%s\\n' TMUX_READY\r");
  await until(() => output.includes('GOOESHELL_TMUX_READY'));
  service.terminalInput(session.id, '\x02"');
  service.terminalInput(session.id, "printf 'SPLIT_%s\\n' OK\r");
  await until(() => output.includes('SPLIT_OK'));
  service.terminalResize(session.id, 137, 41);
  service.terminalInput(session.id, "printf 'SIZE_%s\\n' \"$(tmux display-message -p '#{client_width}x#{client_height}')\"\r");
  await until(() => output.includes('SIZE_137x41'));
  service.terminalInput(session.id, `python3 -c 'import sys;sys.stdout.write(("0123456789"*10+"\\n")*20000);print("BURST_"+"DONE")'\r`);
  await until(() => output.includes('BURST_DONE'));
  assert.equal(stderr, '');
});
