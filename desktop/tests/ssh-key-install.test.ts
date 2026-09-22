import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { Server, utils, type Connection } from 'ssh2';
import { LocalKeyStore, canonicalPublicKey, generateVerifiedEd25519KeyPair } from '../src/main/local-keys';
import { fixtureEd25519Pair } from './fixtures/ssh-key-pairs';
import { INSTALL_PUBLIC_KEY_PYTHON } from '../src/main/ssh-key-install';
import { SshService } from '../src/main/ssh-service';
import type { AppEvent, HostProfile } from '../src/shared/types';

const keyPair = fixtureEd25519Pair();
const publicKey = canonicalPublicKey(keyPair.public).publicKey;
const hostKey = fixtureEd25519Pair().private;
async function temporary(t: TestContext) {
  const base = path.resolve('test-output'); await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'ssh-key-'));
  t.after(async () => { assert(directory.startsWith(base + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  return directory;
}
test('local key handles expose only metadata; encrypted private keys, pub-only and expiration are distinguished', async t => {
  const directory = await temporary(t), store = new LocalKeyStore(path.join(directory, 'keys'));
  const encrypted = fixtureEd25519Pair({ passphrase: 'fixture-only', cipher: 'aes256-ctr', rounds: 4 });
  const file = path.join(directory, 'private'); await fs.writeFile(file, encrypted.private);
  await assert.rejects(store.prepare({ path: file }), /口令/);
  const metadata = await store.prepare({ path: file, passphrase: 'fixture-only' });
  assert.equal(metadata.privateKeyPath, file); assert.match(metadata.fingerprint, /^SHA256:/);
  assert(!JSON.stringify(metadata).includes('fixture-only')); assert(!JSON.stringify(metadata).includes('PRIVATE KEY'));
  assert.equal(store.resolve(metadata.keyId).passphrase, 'fixture-only');
  await fs.writeFile(`${file}.pub`, encrypted.public);
  const pub = await store.prepare({ path: `${file}.pub` });
  assert.equal(pub.privateKeyPath, undefined); assert.equal(pub.fingerprint, metadata.fingerprint);
  store.clear(); assert.throws(() => store.resolve(metadata.keyId), /过期/);
});
test('generated Ed25519 pairs reject zero-truncated or mismatched output and retry only within a fixed bound', async () => {
  const blob = Buffer.from(publicKey.split(' ')[1], 'base64');
  const truncated = Buffer.concat([blob.subarray(0, 19), blob.subarray(20)]); truncated.writeUInt32BE(31, 15);
  const broken = { ...keyPair, public: 'ssh-ed25519 ' + truncated.toString('base64') };
  const mismatch = { ...keyPair, public: fixtureEd25519Pair().public };
  let attempts = 0;
  const valid = await generateVerifiedEd25519KeyPair(undefined, async () => [broken, mismatch, keyPair][Math.min(attempts++, 2)]);
  assert.equal(attempts, 3); assert.equal(valid.public, keyPair.public);
  attempts = 0;
  await assert.rejects(generateVerifiedEd25519KeyPair(undefined, async () => { attempts++; return broken; }), /未写入任何密钥文件/);
  assert.equal(attempts, 8);
});
test('valid Ed25519 public keys retain a real leading zero octet', () => {
  const blob = Buffer.from(publicKey.split(' ')[1], 'base64'); blob[19] = 0;
  const source = 'ssh-ed25519 ' + blob.toString('base64');
  assert.equal(canonicalPublicKey(source).publicKey, source);
  assert.equal(Buffer.from(canonicalPublicKey(source).publicKey.split(' ')[1], 'base64').readUInt32BE(15), 32);
});
test('generating repeated names creates separate Ed25519 files without replacing earlier private keys', { timeout: 30000 }, async t => {
  const directory = await temporary(t), store = new LocalKeyStore(path.join(directory, 'keys'));
  const first = await store.generate({ name: '办公账号' });
  const original = await fs.readFile(first.privateKeyPath!);
  const second = await store.generate({ name: '办公账号', passphrase: 'fixture-passphrase' });
  assert.notEqual(first.privateKeyPath, second.privateKeyPath);
  assert.deepEqual(await fs.readFile(first.privateKeyPath!), original);
  const parsed = await store.prepare({ path: second.privateKeyPath!, passphrase: 'fixture-passphrase' });
  assert.equal(parsed.fingerprint, second.fingerprint);
});

test('Linux installer preserves restricted entries, deduplicates concurrent append, rejects links, and only repairs SSH file permissions', {
  timeout: 20000, skip: process.platform === 'win32' && process.env.GOOESHELL_KEY_INSTALL_LINUX_TEST !== '1',
}, () => {
  const exercise = String.raw`
import base64, json, multiprocessing, os, pathlib, shutil, tempfile, types
request = json.loads(__import__('sys').stdin.read())
scope = {'__name__': 'fixture'}
exec(request['script'], scope)
key = request['key']
home = tempfile.mkdtemp(prefix='gooeshell-key-fixture-')
try:
    scope['pwd'].getpwuid = lambda uid: types.SimpleNamespace(pw_dir=home)
    install = scope['install']
    assert install(key) == {'installed': True, 'alreadyPresent': False}
    ssh = pathlib.Path(home) / '.ssh'
    target = ssh / 'authorized_keys'
    restricted = '# keep comment\ncommand="echo hello world",no-pty ' + key + ' kept-comment\n'
    target.write_text(restricted)
    assert install(key)['alreadyPresent'] is True
    assert target.read_text() == restricted
    unpadded = 'restrict ' + key.rstrip('=') + ' existing\n'
    target.write_text(unpadded)
    assert install(key)['alreadyPresent'] is True
    assert target.read_text() == unpadded
    other = ssh / 'keep-permissions'
    other.write_text('keep')
    other.chmod(0o644)
    ssh.chmod(0o755)
    target.chmod(0o644)
    assert install(key)['alreadyPresent'] is True
    assert target.stat().st_mode & 0o777 == 0o600
    assert ssh.stat().st_mode & 0o777 == 0o700
    assert other.stat().st_mode & 0o777 == 0o644
    target.write_text('# no newline')
    # This POSIX-only fixture injects a temporary home and a function via exec.
    # Explicit fork preserves that isolated scope on macOS, whose default spawn
    # cannot import the synthetic fixture module. Production does not fork here.
    context = multiprocessing.get_context('fork')
    children = [context.Process(target=install, args=(key,)) for _ in range(6)]
    for child in children: child.start()
    for child in children: child.join(); assert child.exitcode == 0
    assert target.read_text() == '# no newline\n' + key + ' gooeshell\n'
    target.unlink()
    outside = pathlib.Path(home) / 'outside'
    outside.write_text('untouched')
    target.symlink_to(outside)
    try: install(key); raise AssertionError('symlink accepted')
    except OSError: pass
    assert outside.read_text() == 'untouched'
    target.unlink(); os.link(outside, target)
    try: install(key); raise AssertionError('hardlink accepted')
    except ValueError: pass
    assert outside.read_text() == 'untouched'
    target.unlink(); other.unlink(); ssh.rmdir(); ssh.symlink_to(home, target_is_directory=True)
    try: install(key); raise AssertionError('directory symlink accepted')
    except OSError: pass
    print(json.dumps({'passed': True}))
finally:
    shutil.rmtree(home)
`;
  const command = process.platform === 'win32' ? 'wsl.exe' : 'python3';
  const args = process.platform === 'win32' ? ['-d', 'Ubuntu-24.04', '--', 'python3', '-c', exercise] : ['-c', exercise];
  const result = spawnSync(command, args, { input: JSON.stringify({ script: INSTALL_PUBLIC_KEY_PYTHON, key: publicKey }), encoding: 'utf8', timeout: 18000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { passed: true });
});

async function fixture(t: TestContext, jump: boolean = false) {
  const directory = await temporary(t), events: AppEvent[] = [], clients = new Set<Connection>(), sockets = new Set<net.Socket>();
  let installed = '', hold = false, rejectKey = false, pty = 0, shells = 0, passwordAttempts = 0, publicAttempts = 0, forwards = 0;
  const target = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => {
      if (context.username !== 'fixture-user') return context.reject();
      if (context.method === 'password') { passwordAttempts++; return context.password === 'fixture-password' ? context.accept() : context.reject(); }
      if (context.method === 'publickey') {
        publicAttempts++;
        if (rejectKey || context.key.data.toString('base64') !== installed.split(' ')[1]) return context.reject(['publickey']);
        const parsed = utils.parseKey(keyPair.public); assert(!(parsed instanceof Error));
        if (context.signature && !parsed.verify(context.blob!, context.signature, context.hashAlgo)) return context.reject();
        return context.accept();
      }
      context.reject(['password', 'publickey']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', accept => { pty++; accept?.(); }); session.on('shell', accept => { shells++; accept(); });
      session.on('exec', (accept, _reject, info) => {
        const stream = accept(); stream.on('error', () => {});
        assert(!info.command.includes(publicKey));
        const frame = info.command.match(/(GOOESHELL_KEY_[a-f0-9]+)$/)![1];
        let input = '';
        stream.on('data', (data: Buffer) => { input += data.toString(); });
        stream.on('end', () => {
          if (hold) return;
          const key = JSON.parse(input).publicKey; const alreadyPresent = installed === key; installed = key;
          stream.write(frame + ':' + Buffer.from(JSON.stringify({ ok: true, value: { installed: true, alreadyPresent } })).toString('base64') + '\n');
          stream.exit(0); stream.end();
        });
      });
    }));
  });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const port = (target.address() as net.AddressInfo).port;
  let gateway: Server | undefined;
  const profile: HostProfile = { id: 'fixture', name: 'Fixture', host: '127.0.0.1', port, username: 'fixture-user', auth: 'password', encoding: 'utf8', rememberHost: true };
  if (jump) {
    gateway = new Server({ hostKeys: [hostKey] }, client => {
      clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
      client.on('authentication', context => context.method === 'password' && context.username === 'jump-user' && context.password === 'jump-password' ? context.accept() : context.reject(['password']));
      client.on('ready', () => client.on('tcpip', (accept, reject, info) => {
        forwards++;
        assert.equal(info.destIP, 'private-key.fixture.invalid'); assert.equal(info.destPort, 22);
        const socket = net.createConnection({ host: '127.0.0.1', port }); sockets.add(socket);
        socket.on('close', () => sockets.delete(socket)); socket.once('error', () => reject());
        socket.once('connect', () => {
          const stream = accept(); stream.on('error', () => socket.destroy()); stream.on('close', () => socket.destroy());
          socket.removeAllListeners('error'); socket.on('error', () => stream.destroy()); socket.pipe(stream).pipe(socket);
        });
      }));
    });
    await new Promise<void>(resolve => gateway!.listen(0, '127.0.0.1', resolve));
    profile.host = 'private-key.fixture.invalid'; profile.port = 22;
    profile.jumpHost = { id: 'jump', host: '127.0.0.1', port: (gateway.address() as net.AddressInfo).port, username: 'jump-user', auth: 'password', rememberHost: true, reuseConnection: true };
  }
  const service = new SshService(event => { events.push(event); if (event.type === 'hostKey') queueMicrotask(() => service.confirmHostKey(event.requestId, 'once')); }, path.join(directory, 'known.json'));
  const privateKeyPath = path.join(directory, 'private'); await fs.writeFile(privateKeyPath, keyPair.private);
  t.after(async () => {
    service.shutdown(); for (const client of clients) client.end(); for (const socket of sockets) socket.destroy();
    await Promise.all([target, gateway].filter(Boolean).map(server => new Promise<void>(resolve => server!.close(() => resolve()))));
  });
  const request = { profile, password: 'fixture-password', jumpPassword: 'jump-password', key: { publicKey, privateKeyPath }, attemptId: 'fixture-operation' };
  return { service, request, events, counts: () => ({ pty, shells, passwordAttempts, publicAttempts, forwards }), hold: () => { hold = true; }, rejectKey: () => { rejectKey = true; } };
}

test('dedicated install verifies selected key over a new connection without terminal events or password fallback', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.pushSshKey(f.request), { installed: true, alreadyPresent: false, verified: true });
  const second = await f.service.pushSshKey(f.request); assert.equal(second.alreadyPresent, true);
  assert.equal(f.counts().passwordAttempts, 2); assert(f.counts().publicAttempts >= 2);
  assert.equal(f.counts().pty, 0); assert.equal(f.counts().shells, 0);
  assert(!f.events.some(event => event.type === 'terminal' || event.type === 'sessionClosed'));
  assert.equal((f.service as any).sessions.size, 0);
  f.rejectKey(); const failed = await f.service.pushSshKey(f.request);
  assert.equal(failed.installed, true); assert.equal(failed.verified, false); assert.match(failed.verificationError!, /已安装/);
  assert.equal(f.counts().passwordAttempts, 3);
});
test('public-only installs never claim verification; cancellation closes only its operation', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const only = await f.service.pushSshKey({ ...f.request, key: { publicKey } });
  assert.equal(only.verified, false); assert.equal(f.counts().publicAttempts, 0);
  f.hold(); const pending = f.service.pushSshKey(f.request);
  setTimeout(() => f.service.cancelSshKeyPush(f.request.attemptId), 150);
  await assert.rejects(pending, /KEY_PUSH_CANCELLED/);
  assert.equal((f.service as any).keyAttempts.size, 0);
  assert(!f.events.some(event => event.type === 'sessionClosed'));
});
test('installation and independent key verification both traverse the configured jump with once-only trust preserved', { timeout: 10000 }, async t => {
  const f = await fixture(t, true);
  const result = await f.service.pushSshKey(f.request);
  assert.equal(result.verified, true); assert.equal(f.counts().forwards, 2);
  assert.equal(f.events.filter(event => event.type === 'hostKey').length, 2);
  assert.equal((f.service as any).jumps.size, 0);
});
