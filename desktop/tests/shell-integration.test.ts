import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server, type Connection } from 'ssh2';
import test from 'node:test';
import { BASH_INTEGRATION_INIT, SHELL_INTEGRATION_COMMAND } from '../src/main/shell-integration';
import { SshService } from '../src/main/ssh-service';
import { fixtureEd25519Pair } from './fixtures/ssh-key-pairs';
import { Terminal } from '@xterm/xterm';
import { TerminalCommandTracker } from '../src/renderer/terminal-command-tracker';

const linuxAvailable = process.platform === 'linux' || process.platform === 'win32' && process.env.GOOESHELL_SHELL_LINUX_TEST === '1';

function runBashFixture(options: Record<string, unknown> = {}) {
  const exercise = readFileSync(new URL('./fixtures/shell-integration-pty.py', import.meta.url), 'utf8');
  const command = process.platform === 'win32' ? 'wsl.exe' : 'python3';
  // WSL's Windows argument forwarding must not reinterpret dollars/backslashes
  // contained in fixture commands before Python receives them.
  const source = `import base64;exec(base64.b64decode('${Buffer.from(exercise).toString('base64')}'))`;
  const args = process.platform === 'win32' ? ['-d', 'Ubuntu-24.04', '--', 'python3', '-c', source] : ['-c', exercise];
  const result = spawnSync(command, args, { input: JSON.stringify({ command: SHELL_INTEGRATION_COMMAND,
    ...(process.env.GOOESHELL_TEST_BASH ? { bash: process.env.GOOESHELL_TEST_BASH } : {}),
    tmux: process.env.GOOESHELL_SHELL_TMUX_TEST === '1', ...options,
  }), encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true);
  assert.match(report.bashVersion, /^version \d+\.\d+$/);
  return report;
}

test('integration bootstrap is static exec code with a private rc descriptor, not typed PTY input', () => {
  assert.match(SHELL_INTEGRATION_COMMAND, /--noprofile --rcfile \/dev\/fd\/3 -i/);
  assert.match(SHELL_INTEGRATION_COMMAND, /exec "\$\{SHELL:-\/bin\/sh\}" -l/);
  assert(!SHELL_INTEGRATION_COMMAND.includes('\\${'));
  assert(!BASH_INTEGRATION_INIT.includes('\\${'));
  assert(!SHELL_INTEGRATION_COMMAND.includes('> ~/.bashrc'));
});

test('real SSH enables exec PTY only per opted-in connection, never injects shell input, and falls back after exec rejection', { timeout: 15000 }, async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'gooeshell-shell-route-'));
  const clients = new Set<Connection>(), events: string[] = [], ptys: unknown[] = [];
  let execs = 0, shells = 0, inputBytes = 0, rejectExec = false;
  const server = new Server({ hostKeys: [fixtureEd25519Pair().private] }, client => {
    clients.add(client);
    client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => context.method === 'password' && context.password === 'fixture-only'
      ? context.accept() : context.reject(['password']));
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', (accept, _reject, info) => { ptys.push(info); accept?.(); });
      session.on('shell', accept => { shells++; accept().on('data', (bytes: Buffer) => { inputBytes += bytes.length; }); });
      session.on('exec', (accept, reject, info) => {
        execs++; assert.equal(info.command, SHELL_INTEGRATION_COMMAND);
        if (rejectExec) { reject(); return; }
        accept().on('data', (bytes: Buffer) => { inputBytes += bytes.length; });
      });
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const service = new SshService(event => {
    if (event.type === 'hostKey') service.confirmHostKey(event.requestId, 'once');
    if (event.type === 'notice') events.push(event.message);
  }, path.join(folder, 'known.json'));
  t.after(async () => {
    service.shutdown(); for (const client of clients) client.end();
    await new Promise<void>(resolve => server.close(() => resolve())); await fs.rmdir(folder);
  });
  const profile = { id: 'fixture', name: 'Fixture', host: '127.0.0.1', port: (server.address() as { port: number }).port,
    username: 'test', auth: 'password' as const, encoding: 'utf8' as const, rememberHost: false };
  await service.connect({ profile, password: 'fixture-only' });
  assert.equal(execs, 0); assert.equal(shells, 1);
  await service.connect({ profile: { ...profile, shellIntegration: true }, password: 'fixture-only' });
  assert.equal(execs, 1); assert.equal(shells, 1);
  rejectExec = true;
  await service.connect({ profile: { ...profile, shellIntegration: true }, password: 'fixture-only' });
  assert.equal(execs, 2); assert.equal(shells, 2); assert.equal(events.length, 1);
  assert.match(events[0], /普通终端/);
  assert.equal(inputBytes, 0, 'no bootstrap bytes may be typed into a live terminal');
  assert.equal(ptys.length, 4, 'each exec and ordinary fallback obtains its own PTY');
});

test('real Bash PTY preserves prompts/status/hooks and recognizes full commands and interrupts', {
  timeout: 30000,
  skip: !linuxAvailable,
}, () => {
  const report = runBashFixture();
  assert(report.checks.length >= 8);
});

test('real Bash PTY transcripts recover duplicate and history-disabled commands through xterm without collecting password input', {
  timeout: 30000, skip: !linuxAvailable,
}, async t => {
  const report = runBashFixture({ captureTranscripts: true });
  assert.equal(report.replays.length, 4);
  for (const replay of report.replays) {
    const terminal = new Terminal({ cols: replay.cols, rows: replay.rows, scrollback: 1000 });
    const tracker = new TerminalCommandTracker(terminal);
    try {
      const transcript = Buffer.from(replay.transcript, 'base64');
      // Deliberately split OSC and UTF-8 boundaries like real SSH packet delivery.
      for (let offset = 0; offset < transcript.length; offset += 37) {
        await new Promise<void>(resolve => terminal.write(transcript.subarray(offset, offset + 37), resolve));
      }
      assert.equal(tracker.records.length, replay.expected.length, replay.name);
      assert.deepEqual(tracker.records.map(record => ({ command: record.command ?? null, source: record.commandSource ?? null })),
        replay.expected, replay.name);
      assert(tracker.records.every(record => record.status === 'success' && record.exitCode === 0), replay.name);
      assert(tracker.records.every(record => !record.command?.includes(replay.secret)), `${replay.name}: synthetic password cannot be a command`);
      t.diagnostic(`${report.bashVersion}; ${replay.name}: ${tracker.records.length} command boundaries checked with real xterm`);
    } finally {
      tracker.dispose(); terminal.dispose();
    }
  }
});
