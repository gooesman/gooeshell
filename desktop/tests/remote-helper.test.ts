import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import type { Client } from 'ssh2';
import { REMOTE_HELPER_PYTHON, runRemoteOperation } from '../src/main/remote-helper.ts';
import { encodeEditableText, textRevision } from '../src/main/text-files';

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  writes: string[] = [];
  ended: string[] = [];
  closed = false;
  sentSignals: string[] = [];
  write(value: string) { this.writes.push(value); return true; }
  end(value: string) { this.ended.push(value); }
  close() { this.closed = true; }
  signal(value: string) { this.sentSignals.push(value); }
}

function mockConnection() {
  const channel = new FakeChannel();
  let command = '';
  let connected!: () => void;
  const ready = new Promise<void>(resolve => { connected = resolve; });
  const client = {
    exec(input: string, options: unknown, callback: (error: null, stream: FakeChannel) => void) {
      command = input;
      assert.deepEqual(options, { pty: false });
      queueMicrotask(() => { callback(null, channel); connected(); });
    },
  } as unknown as Client;
  return {
    channel, client, ready,
    get command() { return command; },
    get frame() { return command.match(/(GOOESHELL_[0-9a-f]+)$/)![1]; },
    get prompt() { return command.match(/GOOESHELL_SUDO_[0-9a-f]+:/)![0]; },
    sendReady() { channel.emit('data', Buffer.from(this.frame + ':READY\n')); },
    sendResult(value: unknown) {
      channel.emit('data', Buffer.from(this.frame + ':RESULT:' + Buffer.from(JSON.stringify({ ok: true, value })).toString('base64') + '\n'));
    },
  };
}

test('paths and text stay off the SSH command and wait for READY', async () => {
  const connection = mockConnection();
  const payload = { path: "/tmp/odd ' $(touch SHOULD_NOT_RUN) 中文.txt", text: 'line1\nline2' };
  const operation = runRemoteOperation(connection.client, 'write', { ...payload, sudoPassword: 'must-not-enter-payload' });
  await connection.ready;
  assert.ok(!connection.command.includes(payload.path));
  assert.equal(connection.channel.ended.length, 0);
  connection.channel.emit('data', Buffer.from('Non-interactive SSH banner\n'));
  assert.equal(connection.channel.ended.length, 0);
  connection.sendReady();
  assert.deepEqual(JSON.parse(connection.channel.ended[0]).payload, payload);
  connection.sendResult(null);
  assert.equal(await operation, undefined);
});

test('sudo password waits for the whole random prompt and JSON waits for READY', async () => {
  const connection = mockConnection();
  const operation = runRemoteOperation(connection.client, 'list', { path: '/root' }, { elevated: true, sudoPassword: 'test-only-secret' });
  await connection.ready;
  const prompt = connection.prompt;
  assert.ok(!connection.command.includes('test-only-secret'));
  connection.channel.stderr.emit('data', Buffer.from(prompt.slice(0, 10)));
  assert.equal(connection.channel.writes.length, 0);
  connection.channel.stderr.emit('data', Buffer.from(prompt.slice(10)));
  assert.deepEqual(connection.channel.writes, ['test-only-secret\n']);
  assert.equal(connection.channel.ended.length, 0);
  connection.sendReady();
  assert.ok(!connection.channel.ended[0].includes('test-only-secret'));
  connection.sendResult({ path: '/root', entries: [] });
  assert.deepEqual(await operation, { path: '/root', entries: [] });
});

test('cached or NOPASSWD sudo never receives the supplied password', async () => {
  const connection = mockConnection();
  const operation = runRemoteOperation(connection.client, 'list', { path: '/root' }, { elevated: true, sudoPassword: 'unused-secret' });
  await connection.ready;
  connection.sendReady();
  connection.sendResult({ path: '/root', entries: [] });
  await operation;
  assert.deepEqual(connection.channel.writes, []);
});

test('a repeated sudo prompt fails without resending a password', async () => {
  const connection = mockConnection();
  const operation = runRemoteOperation(connection.client, 'list', { path: '/root' }, { elevated: true, sudoPassword: 'wrong-test-only' });
  const rejected = assert.rejects(operation, /密码未被接受/);
  await connection.ready;
  connection.channel.stderr.emit('data', Buffer.from(connection.prompt));
  connection.channel.stderr.emit('data', Buffer.from('Sorry, try again.\n' + connection.prompt));
  await rejected;
  assert.equal(connection.channel.writes.length, 1);
  assert.ok(connection.channel.closed);
});

test('missing sudo password, requiretty and missing Python have explicit errors', async () => {
  for (const [diagnostic, expected] of [
    ['prompt', /SUDO_PASSWORD_REQUIRED/],
    ['sudo: sorry, you must have a tty to run sudo', /requiretty/],
    ['sudo: python3: command not found', /Python 3/],
  ] as const) {
    const connection = mockConnection();
    const operation = runRemoteOperation(connection.client, 'list', { path: '/root' }, { elevated: true });
    const rejected = assert.rejects(operation, expected);
    await connection.ready;
    connection.channel.stderr.emit('data', Buffer.from(diagnostic === 'prompt' ? connection.prompt : diagnostic));
    connection.channel.emit('close', 1);
    await rejected;
  }
});

test('operation cancellation closes only its own exec channel', async () => {
  const connection = mockConnection();
  const controller = new AbortController();
  const operation = runRemoteOperation(connection.client, 'run', { path: '/tmp/test.sh' }, { signal: controller.signal });
  const rejected = assert.rejects(operation, { name: 'AbortError' });
  await connection.ready;
  controller.abort();
  await rejected;
  assert.deepEqual(connection.channel.sentSignals, ['TERM']);
  assert.ok(connection.channel.closed);
});

test('invalid permissions, NUL paths and oversized writes are rejected before exec', async () => {
  const connection = mockConnection();
  await assert.rejects(runRemoteOperation(connection.client, 'chmod', { path: '/tmp/a', mode: 0o4755 }), /特殊权限位/);
  await assert.rejects(runRemoteOperation(connection.client, 'read', { path: '/tmp/a\0b' }), /NUL/);
  await assert.rejects(runRemoteOperation(connection.client, 'write', { path: '/tmp/a', text: 'x'.repeat(2 * 1024 * 1024 + 1) }), /2 MiB/);
  await assert.rejects(runRemoteOperation(connection.client, 'writeBytes', { path: '/tmp/a', data: 'not-base64', expectedRevision: 'missing' }), /原始版本无效/);
  assert.equal(connection.command, '');
});

const wslDistribution = process.env.GOOESHELL_TEST_WSL;
const supportsLinux = process.platform === 'linux' || !!wslDistribution;
function python(code: string, args: string[] = [], input = ''): string {
  const command = wslDistribution ? 'wsl.exe' : 'python3';
  const commandArgs = wslDistribution ? ['-d', wslDistribution, '--', 'python3', '-I', '-c', code, ...args] : ['-I', '-c', code, ...args];
  return execFileSync(command, commandArgs, { input, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 20_000 });
}

test('real Linux helper validates edits, no-follow mutations, permissions, shebang and run limits', { skip: !supportsLinux }, () => {
  const directory = python('import tempfile; print(tempfile.mkdtemp(prefix="gooeshell-helper-test-"))').trim();
  assert.match(directory, /^\/tmp\/gooeshell-helper-test-[A-Za-z0-9_-]+$/);
  function operation(op: string, payload: Record<string, unknown>, elevated = false, timeoutMs = 5000): any {
    const stdout = python(REMOTE_HELPER_PYTHON, ['TEST_FRAME'], JSON.stringify({ op, payload, elevated, timeoutMs }) + '\n');
    assert.ok(stdout.startsWith('TEST_FRAME:READY\n'));
    const response = stdout.split('\n').find(line => line.startsWith('TEST_FRAME:RESULT:'))!;
    return JSON.parse(Buffer.from(response.slice('TEST_FRAME:RESULT:'.length), 'base64').toString('utf8'));
  }
  function fixture(code: string, values: unknown[] = []) {
    return python('import os, pathlib, json, sys; root=sys.argv[1]; values=json.loads(sys.stdin.read()); ' + code, [directory], JSON.stringify(values));
  }
  try {
    const path = directory + "/odd ' $(ignored) 中文.txt";
    assert.equal(operation('write', { path, text: '你好\nworld\n' }).ok, true);
    assert.deepEqual(operation('read', { path }).value, { text: '你好\nworld\n', truncated: false });
    assert.equal(operation('list', { path: directory }).value.entries[0].name, "odd ' $(ignored) 中文.txt");
    assert.equal(operation('chmod', { path, mode: 0o640 }, true).ok, true);
    fixture('os.chmod(values[0], 0o4640)', [path]);
    assert.equal(operation('chmod', { path, mode: 0o600 }, true).ok, true);
    assert.equal(operation('list', { path: directory }).value.entries[0].mode, 0o4600);
    assert.equal(operation('chmod', { path, mode: 0o4755 }, true).ok, false);
    assert.equal(operation('write', { path, text: 'replacement' }, true).ok, true);
    assert.equal(operation('read', { path }).value.text, 'replacement');

    const symlink = directory + '/symlink';
    fixture('os.symlink(values[0], values[1])', [path, symlink]);
    assert.equal(operation('write', { path: symlink, text: 'must not write' }, true).ok, false);
    assert.equal(operation('chmod', { path: symlink, mode: 0o777 }, true).ok, false);
    fixture('os.mkdir(root + "/real"); os.symlink(root + "/real", root + "/linked-parent")');
    assert.equal(operation('write', { path: directory + '/linked-parent/a', text: 'must not write' }, true).ok, false);

    assert.equal(operation('mkdir', { path: directory + '/new-dir' }, true).ok, true);
    assert.equal(operation('rename', { path, destination: directory + '/renamed.txt' }, true).ok, true);
    assert.equal(operation('write', { path, text: 'keep both' }).ok, true);
    assert.equal(operation('rename', { path, destination: directory + '/renamed.txt' }, true).ok, false);
    assert.equal(operation('read', { path }).value.text, 'keep both');

    const script = directory + '/script.sh';
    assert.equal(operation('write', { path: directory + '/resource.txt', text: 'sibling-resource' }).ok, true);
    assert.equal(operation('write', { path: script, text: '#!/bin/bash\n[[ -n "$BASH_VERSION" ]] || exit 23\ncat "$(dirname "$0")/resource.txt"\nexit 7\n' }).ok, true);
    const result = operation('run', { path: script, makeExecutable: true }).value;
    assert.equal(result.exitCode, 7);
    assert.equal(result.permissionsChanged, true);
    assert.equal(result.mode, 0o700);
    assert.equal(result.executionStarted, true);
    assert.match(result.output, /sibling-resource/);

    assert.equal(operation('write', { path: script, text: '#!/bin/sh\nexec 1>&- 2>&-\nsleep 5\n' }).ok, true);
    const timed = operation('run', { path: script }, false, 100).value;
    assert.equal(timed.exitCode, 124);
    assert.match(timed.output, /超时/);
    assert.equal(operation('write', { path: script, text: '#!/bin/sh\nyes noisy-output\n' }).ok, true);
    const limited = operation('run', { path: script }).value;
    assert.equal(limited.exitCode, 125);
    assert.ok(Buffer.byteLength(limited.output) <= 2 * 1024 * 1024);
    fixture('pathlib.Path(root + "/large.txt").write_bytes(b"x" * (2 * 1024 * 1024 + 10))');
    const preview = operation('read', { path: directory + '/large.txt' }).value;
    assert.equal(preview.truncated, true);
    assert.equal(preview.text.length, 2 * 1024 * 1024);

    // The new editor sends exact encoded bytes; root writes use the same content
    // revision as regular SFTP so a sudo retry does not discard the original baseline.
    const encodedPath = directory + '/encoded.txt';
    const encoded = encodeEditableText('中文\r\nnext\n', 'utf16be');
    const created = operation('writeBytes', { path: encodedPath, data: encoded.toString('base64'), expectedRevision: 'missing' }, true);
    assert.equal(created.ok, true, created.error);
    const raw = operation('readBytes', { path: encodedPath }, true).value;
    assert.deepEqual(Buffer.from(raw.data, 'base64'), encoded);
    assert.equal(raw.revision, created.value.revision);
    const metadata = JSON.parse(fixture('s=os.stat(values[0]); print(json.dumps([s.st_size,int(s.st_mtime),s.st_mode,s.st_uid,s.st_gid]))', [encodedPath]));
    assert.equal(raw.revision, textRevision(encoded, metadata));
    const changed = encodeEditableText('修改\r\nnext\n', 'utf16be');
    const saved = operation('writeBytes', { path: encodedPath, data: changed.toString('base64'), expectedRevision: raw.revision }, true);
    assert.equal(saved.ok, true, saved.error);
    assert.equal(operation('readBytes', { path: encodedPath }).value.revision, saved.value.revision);
    const stale = operation('writeBytes', { path: encodedPath, data: encoded.toString('base64'), expectedRevision: raw.revision }, true);
    assert.equal(stale.ok, false);
    assert.match(stale.error, /TEXT_CONFLICT/);
    assert.deepEqual(Buffer.from(operation('readBytes', { path: encodedPath }).value.data, 'base64'), changed);
    const sameTime = operation('readBytes', { path: encodedPath }).value;
    fixture('s=os.stat(values[0]); pathlib.Path(values[0]).write_bytes(b"x" * s.st_size); os.utime(values[0], ns=(s.st_atime_ns,s.st_mtime_ns))', [encodedPath]);
    assert.match(operation('writeBytes', { path: encodedPath, data: encoded.toString('base64'), expectedRevision: sameTime.revision }, true).error, /TEXT_CONFLICT/);
    const rawPreview = operation('readBytes', { path: directory + '/large.txt' }).value;
    assert.equal(rawPreview.truncated, true);
    assert.match(rawPreview.revision, /^preview:/);
    assert.equal(operation('writeBytes', { path: directory + '/large.txt', data: '', expectedRevision: rawPreview.revision }, true).ok, false);
    assert.equal(operation('writeBytes', { path: symlink, data: '', expectedRevision: 'missing' }, true).ok, false);
    assert.equal(operation('readBytes', { path: symlink }, true).ok, false);
    assert.equal(operation('writeBytes', { path: directory + '/linked-parent/new.txt', data: '', expectedRevision: 'missing' }, true).ok, false);
  } finally {
    python('import os, shutil, sys; root=os.path.realpath(sys.argv[1]); assert os.path.dirname(root)=="/tmp" and os.path.basename(root).startswith("gooeshell-helper-test-"); shutil.rmtree(root)', [directory]);
  }
});
