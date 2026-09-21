import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Client } from 'ssh2';
import { createRemoteTransferHash, REMOTE_TRANSFER_HASH_PYTHON } from '../src/main/remote-transfer-hash';

class Channel extends EventEmitter {
  stderr = new EventEmitter();
  requests: string[] = [];
  signals: string[] = [];
  closed = false;
  destroyed = false;
  end(request: string) { this.requests.push(request); }
  signal(value: string) { this.signals.push(value); }
  close() { this.closed = true; this.emit('close', null); }
  destroy() { this.destroyed = true; }
}
function connection() {
  const channel = new Channel();
  let command = '', calls = 0;
  let callback: ((error: Error | null, channel: Channel) => void) | undefined;
  const client = Object.assign(new EventEmitter(), {
    exec(value: string, options: unknown, cb: typeof callback) {
      command = value; calls++;
      assert.deepEqual(options, { pty: false });
      callback = cb;
    },
  }) as unknown as Client;
  return {
    client, channel, hash: createRemoteTransferHash(client),
    get command() { return command; }, get calls() { return calls; },
    get frame() { return command.match(/GOOESHELL_HASH_[a-f0-9]+$/)![0]; },
    connect(error: Error | null = null) { callback!(error, channel); },
    start() { channel.emit('data', Buffer.from(`${this.frame}:READY\n`)); },
    send(kind: string, value: unknown) {
      const line = `${this.frame}:${kind}:${JSON.stringify(value)}\n`;
      channel.emit('data', Buffer.from(line.slice(0, 37)));
      channel.emit('data', Buffer.from(line.slice(37)));
    },
    result(value: unknown) { this.send('RESULT', { ok: true, value }); },
    close(code: number | null = 0) { channel.emit('close', code); },
  };
}
const digest = createHash('sha256').update('fixture').digest('hex');
const goodResult = { sha256: digest, size: 7, mtime: 1770000000 };
const signal = () => new AbortController().signal;

test('hash paths/proof use stdin, progress is monotonic, and completion requires a clean channel close', async () => {
  const server = connection(), progress: number[] = [];
  const path = "/tmp/中文 ' $(touch DO_NOT_RUN)";
  const proof = { path: '/tmp/.probe', token: 'a'.repeat(48) };
  let resolved = false;
  const operation = server.hash(path, 7, signal(), value => progress.push(value), proof).then(value => { resolved = true; return value; });
  server.connect();
  assert(!server.command.includes(path));
  server.channel.emit('data', Buffer.from('login banner\n'));
  server.start();
  assert.deepEqual(JSON.parse(server.channel.requests[0]), { path, length: 7, proof });
  server.send('PROGRESS', 0); server.send('PROGRESS', 3); server.send('PROGRESS', 7);
  server.result(goodResult);
  await Promise.resolve(); assert.equal(resolved, false);
  server.close();
  assert.deepEqual(await operation, goodResult);
  assert.deepEqual(progress, [0, 3, 7]);
  assert.equal(server.client.listenerCount('close'), 0);
  assert.equal(server.channel.listenerCount('data'), 0);
  assert.equal(server.channel.listenerCount('error'), 0);
  assert.equal(server.channel.stderr.listenerCount('data'), 0);
});

test('Python absence is cached per connection, while a path namespace mismatch is not', async () => {
  const missing = connection();
  const first = missing.hash('/file', 7, signal()); missing.connect();
  missing.channel.stderr.emit('data', Buffer.from('sh: python3: command not found'));
  missing.close(127); assert.equal(await first, undefined);
  assert.equal(await missing.hash('/other', 7, signal()), undefined);
  assert.equal(missing.calls, 1);
  const accessible = connection();
  const second = accessible.hash('/file', 7, signal()); accessible.connect(); accessible.start();
  accessible.result({ unsupported: 'path' }); accessible.close();
  assert.equal(await second, undefined);
  const third = accessible.hash('/other', 7, signal()); accessible.connect(); accessible.start();
  accessible.result(goodResult); accessible.close();
  assert.deepEqual(await third, goodResult); assert.equal(accessible.calls, 2);
});

test('explicit environment or exec capability failures fall back and are cached', async () => {
  for (const kind of ['exec', 'ssh2-denied', 'environment']) {
    const server = connection();
    const operation = server.hash('/file', 7, signal());
    if (kind === 'exec') server.connect(new Error('exec request denied'));
    else if (kind === 'ssh2-denied') server.connect(new Error('Unable to exec'));
    else { server.connect(); server.start(); server.result({ unsupported: 'environment' }); server.close(); }
    assert.equal(await operation, undefined);
    assert.equal(await server.hash('/other', 7, signal()), undefined);
    assert.equal(server.calls, 1);
  }
});

test('exec transport/resource failures reject and are not cached as unsupported', async () => {
  const server = connection();
  const operation = server.hash('/file', 7, signal());
  server.connect(new Error('No response from server'));
  await assert.rejects(operation, /No response/);
  const next = server.hash('/file', 7, signal()); server.connect(); server.start(); server.result(goodResult); server.close();
  assert.deepEqual(await next, goodResult); assert.equal(server.calls, 2);
  const broken = Object.assign(new EventEmitter(), { exec() { throw new Error('Not connected'); } }) as unknown as Client;
  await assert.rejects(createRemoteTransferHash(broken)('/file', 7, signal()), /Not connected/);
});

test('invalid digest, metadata, progress, changed-file and premature close are never accepted', async () => {
  const scenarios = [
    (server: ReturnType<typeof connection>) => server.result({ ...goodResult, sha256: 'bad' }),
    (server: ReturnType<typeof connection>) => server.result({ ...goodResult, size: 6 }),
    (server: ReturnType<typeof connection>) => server.send('PROGRESS', 8),
    (server: ReturnType<typeof connection>) => { server.send('PROGRESS', 4); server.send('PROGRESS', 2); },
    (server: ReturnType<typeof connection>) => server.send('RESULT', { ok: false, error: '文件发生变化' }),
    (server: ReturnType<typeof connection>) => server.close(),
    (server: ReturnType<typeof connection>) => { server.result(goodResult); server.close(1); },
    (server: ReturnType<typeof connection>) => { server.result(goodResult); server.channel.emit('error', new Error('channel error')); },
    (server: ReturnType<typeof connection>) => { server.result(goodResult); server.result(goodResult); },
  ];
  for (const scenario of scenarios) {
    const server = connection();
    const operation = server.hash('/file', 7, signal()); server.connect(); server.start();
    scenario(server);
    await assert.rejects(operation);
  }
});

test('cancellation is immediate before connection, during hashing and after the result', async () => {
  for (const phase of ['before', 'hashing', 'result']) {
    const server = connection(), controller = new AbortController();
    const operation = server.hash('/file', 7, controller.signal);
    if (phase !== 'before') { server.connect(); server.start(); }
    if (phase === 'result') server.result(goodResult);
    controller.abort();
    await assert.rejects(operation, { name: 'AbortError' });
    if (phase === 'before') server.connect();
    assert.deepEqual(server.channel.signals, ['TERM']);
    assert(server.channel.closed && server.channel.destroyed);
    assert.equal(server.client.listenerCount('close'), 0);
    assert.equal(server.channel.listenerCount('data'), 0);
    assert.equal(server.channel.listenerCount('error'), 0);
  }
  const server = connection(), controller = new AbortController(); controller.abort();
  await assert.rejects(server.hash('/file', 7, controller.signal), { name: 'AbortError' });
  assert.equal(server.calls, 0);
});

test('transport closure and excessive output stop the helper and reject', async () => {
  for (const kind of ['transport', 'stderr', 'stdout', 'banner']) {
    const server = connection();
    const operation = server.hash('/file', 7, signal()); server.connect();
    if (kind !== 'banner') server.start();
    if (kind === 'transport') server.client.emit('close');
    else if (kind === 'stderr') server.channel.stderr.emit('data', Buffer.alloc(65537, 65));
    else server.channel.emit('data', Buffer.from(kind === 'banner' ? 'x\n'.repeat(32769) : 'x'.repeat(65537)));
    await assert.rejects(operation);
    assert(server.channel.destroyed);
  }
});

test('only startup and completed-helper shutdown are timed, not large-file hashing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const startup = connection(), slow = startup.hash('/file', 7, signal()); startup.connect();
  t.mock.timers.tick(15000);
  assert.equal(await slow, undefined); assert(startup.channel.destroyed);
  const server = connection(), operation = server.hash('/file', 7, signal()); server.connect(); server.start();
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(server.channel.destroyed, false);
  server.result(goodResult); server.close(); assert.deepEqual(await operation, goodResult);
  const hanging = connection(), finished = hanging.hash('/file', 7, signal()); hanging.connect(); hanging.start(); hanging.result(goodResult);
  t.mock.timers.tick(10000); await assert.rejects(finished, /未正常结束/);
});

test('Python helper hashes prefixes, guards file changes and validates the SFTP namespace proof', {
  timeout: 20000,
  skip: process.platform === 'win32' && process.env.GOOESHELL_HASH_LINUX_TEST !== '1',
}, () => {
  const exercise = String.raw`
import hashlib, json, os, pathlib, shutil, sys, tempfile
request = json.loads(sys.stdin.read())
scope = {'__name__': 'fixture'}
exec(request['script'], scope)
folder = pathlib.Path(tempfile.mkdtemp(prefix='gooeshell-hash-fixture-'))
try:
    target = folder / "quote ' $(do-not-run) 中文"
    content = b'abc123' * 400000
    target.write_bytes(content)
    proof_file = folder / '.proof'
    token = 'ab' * 24
    proof_file.write_text(token)
    proof = {'path': str(proof_file), 'token': token}
    seen = []
    hash_file = scope['hash_file']
    full = hash_file(str(target), len(content), seen.append, proof)
    assert full['sha256'] == hashlib.sha256(content).hexdigest()
    assert full['size'] == len(content) and full['mtime'] == target.stat().st_mtime_ns // 1000000000
    assert seen[0] == 0 and seen[-1] == len(content)
    assert hash_file(str(target), 19, lambda n: None, proof)['sha256'] == hashlib.sha256(content[:19]).hexdigest()
    assert hash_file(str(target), 0, lambda n: None, proof)['sha256'] == hashlib.sha256(b'').hexdigest()
    try: hash_file(str(target), len(content) + 1, lambda n: None, proof); raise AssertionError('short file accepted')
    except RuntimeError: pass
    proof_file.write_text('wrong')
    assert hash_file(str(target), 0, lambda n: None, proof) == {'unsupported': 'path'}
    proof_file.unlink(); proof_file.symlink_to(target)
    assert hash_file(str(target), 0, lambda n: None, proof) == {'unsupported': 'path'}
    proof_file.unlink(); proof_file.write_text(token)
    other = folder / 'other'; other.mkdir(); outside = other / 'proof'; outside.write_text(token)
    assert hash_file(str(target), 0, lambda n: None, {'path': str(outside), 'token': token}) == {'unsupported': 'path'}
    link = folder / 'link'; link.symlink_to(target)
    assert hash_file(str(link), 0, lambda n: None, proof) == {'unsupported': 'path'}
    pipe = folder / 'pipe'; os.mkfifo(pipe)
    assert hash_file(str(pipe), 0, lambda n: None, proof) == {'unsupported': 'path'}
    def corrupt_proof(done):
        if done > 0: proof_file.write_text('x' * len(token))
    assert hash_file(str(target), len(content), corrupt_proof, proof) == {'unsupported': 'path'}
    proof_file.write_text(token)
    def modify_target(done):
        if done == 0:
            with open(target, 'r+b') as file: file.write(b'changed')
    try: hash_file(str(target), len(content), modify_target, proof); raise AssertionError('changed file accepted')
    except RuntimeError: pass
    def replace_target(done):
        if done == 0:
            replacement = folder / 'replacement'; replacement.write_bytes(content); replacement.replace(target)
    try: hash_file(str(target), len(content), replace_target, proof); raise AssertionError('replacement accepted')
    except RuntimeError: pass
    def truncate_target(done):
        if done == 0: target.write_bytes(b'')
    try: hash_file(str(target), len(content), truncate_target, proof); raise AssertionError('truncation accepted')
    except RuntimeError: pass
    target.write_bytes(b'')
    assert hash_file(str(target), 0, lambda n: None, proof)['sha256'] == hashlib.sha256(b'').hexdigest()
    print(json.dumps({'passed': True}))
finally:
    shutil.rmtree(folder)
`;
  const runner = process.platform === 'win32' ? 'wsl.exe' : 'python3';
  const args = process.platform === 'win32' ? ['-e', 'python3', '-I', '-c', exercise] : ['-I', '-c', exercise];
  const result = spawnSync(runner, args, { input: JSON.stringify({ script: REMOTE_TRANSFER_HASH_PYTHON }), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).passed, true);
});
