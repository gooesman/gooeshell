import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs, type Stats as LocalStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import type { Client, SFTPWrapper } from 'ssh2';
import { performSftpTransfer } from '../src/main/sftp-transfer';
import { createTransferHash } from '../src/main/transfer-hash-probe';
import type { TransferInfo, TransferRequest } from '../src/shared/types';

/** An isolated disk-backed SFTP boundary. Python sees the same files through
 * WSL/normal POSIX paths; there is no user server or SSH configuration involved. */
class DiskSftp extends EventEmitter {
  handles = new Map<string, { file: FileHandle; remote: string }>();
  readBytes = 0;
  verificationReadBytes = 0;
  delayMs = 0;
  checking = () => false;
  constructor(readonly localRoot: string, readonly remoteRoot: string) { super(); }
  private local(remote: string) {
    const normalized = path.posix.normalize(remote);
    if (normalized !== this.remoteRoot && !normalized.startsWith(this.remoteRoot + '/')) throw new Error('fixture path escaped');
    return path.join(this.localRoot, path.posix.relative(this.remoteRoot, normalized));
  }
  private attrs(value: LocalStats) {
    return { size: value.size, mode: value.mode, uid: value.uid, gid: value.gid,
      mtime: Math.floor(value.mtimeMs / 1000), atime: Math.floor(value.atimeMs / 1000),
      isFile: () => value.isFile(), isDirectory: () => value.isDirectory(), isSymbolicLink: () => value.isSymbolicLink() };
  }
  private call<T>(operation: Promise<T>, callback: (error: Error | null, value?: T) => void) {
    void operation.then(value => callback(null, value), error => callback(Object.assign(error, { code: error.code === 'ENOENT' ? 2 : error.code })));
  }
  realpath(remote: string, callback: any) { this.call(fs.realpath(this.local(remote)).then(() => path.posix.normalize(remote)), callback); }
  lstat(remote: string, callback: any) { this.call(fs.lstat(this.local(remote)).then(value => this.attrs(value)), callback); }
  fstat(handle: Buffer, callback: any) { this.call(this.handles.get(handle.toString())!.file.stat().then(value => this.attrs(value)), callback); }
  open(remote: string, flags: number | string, attrsOrCallback: any, lastCallback?: any) {
    const callback = lastCallback ?? attrsOrCallback;
    this.call(fs.open(this.local(remote), flags === 0x2b ? 'wx+' : flags, typeof attrsOrCallback === 'object' ? attrsOrCallback.mode : undefined).then(file => {
      const id = randomUUID(); this.handles.set(id, { file, remote }); return Buffer.from(id);
    }), callback);
  }
  close(handle: Buffer, callback: any) {
    const entry = this.handles.get(handle.toString())!;
    this.call(entry.file.close().then(() => { this.handles.delete(handle.toString()); }), callback);
  }
  write(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: any) {
    this.call(this.handles.get(handle.toString())!.file.write(buffer, offset, length, position).then(value => {
      assert.equal(value.bytesWritten, length);
    }), callback);
  }
  read(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: any) {
    const checking = this.checking();
    this.call(this.handles.get(handle.toString())!.file.read(buffer, offset, length, position).then(async value => {
      this.readBytes += value.bytesRead;
      if (checking) this.verificationReadBytes += value.bytesRead;
      if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs));
      return value.bytesRead;
    }), callback);
  }
  unlink(remote: string, callback: any) { this.call(fs.unlink(this.local(remote)), callback); }
  rename(from: string, to: string, callback: any) { this.call((async () => {
    await assert.rejects(fs.stat(this.local(to)), { code: 'ENOENT' });
    await fs.rename(this.local(from), this.local(to));
  })(), callback); }
}

/** Executes the exact constant helper shell command through a local process,
 * preserving its stdin/stdout/channel lifecycle rather than mocking hashes. */
function pythonClient() {
  let calls = 0;
  const client = Object.assign(new EventEmitter(), { exec(command: string, options: unknown, callback: any) {
    calls++;
    assert.deepEqual(options, { pty: false });
    assert(command.startsWith('python3 -I -u -c '));
    const child = process.platform === 'win32'
      ? spawn('wsl.exe', ['-e', 'sh', '-c', command], { windowsHide: true })
      : spawn('sh', ['-c', command]);
    const channel = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      end(value: string) { child.stdin.end(value); },
      signal() { child.kill(); }, close() { child.kill(); }, destroy() { child.kill(); },
    });
    child.stdout.on('data', data => channel.emit('data', data));
    child.stderr.on('data', data => channel.stderr.emit('data', data));
    child.on('error', error => channel.emit('error', error));
    child.on('close', code => channel.emit('close', code));
    callback(null, channel);
  } }) as unknown as Client;
  return { client, get calls() { return calls; } };
}

async function fixture(t: TestContext) {
  const base = path.resolve('test-output'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'hash-integration-'));
  t.after(async () => { assert(root.startsWith(base + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  const local = path.join(root, 'local'), remote = path.join(root, 'remote');
  await fs.mkdir(local); await fs.mkdir(remote);
  const remoteRoot = process.platform === 'win32'
    ? execFileSync('wsl.exe', ['-e', 'wslpath', '-a', '-u', remote], { encoding: 'utf8', windowsHide: true }).trim()
    : remote;
  const disk = new DiskSftp(remote, remoteRoot), python = pythonClient();
  const sftp = disk as unknown as SFTPWrapper, hash = createTransferHash(sftp, python.client);
  const transfer = async (name: string, direction: 'upload' | 'download', implementation = performSftpTransfer, digest = true) => {
    disk.readBytes = disk.verificationReadBytes = 0;
    const request: TransferRequest = { sessionId: 'fixture', direction, source: direction === 'upload' ? path.join(local, name) : `${remoteRoot}/${name}`,
      destinationDir: direction === 'upload' ? remoteRoot : local, resume: true };
    const info: TransferInfo = { id: randomUUID(), sessionId: 'fixture', direction, name, source: request.source, destination: request.destinationDir, state: 'queued', done: 0, total: 0 };
    disk.checking = () => info.state === 'checking';
    const methods = new Set<string>(); let finalStart = 0;
    const emit = () => {
      if (!finalStart && info.state === 'checking' && info.total > 0 && info.done === info.total) finalStart = performance.now();
      if (info.verification) methods.add(info.verification.method);
    };
    await implementation(sftp, request, info, new AbortController().signal, emit, root, digest ? hash : undefined);
    return { verificationMs: performance.now() - finalStart, remoteReadBytes: disk.readBytes, verificationReadBytes: disk.verificationReadBytes, methods: [...methods] };
  };
  return { root, local, remote, disk, python, transfer };
}

test('real Python digest and namespace proof integrate with upload/download and both resume directions', {
  timeout: 60000, skip: process.platform === 'win32' && process.env.GOOESHELL_HASH_LINUX_TEST !== '1',
}, async t => {
  const env = await fixture(t), bytes = randomBytes(1024 * 1024 + 311), prefix = 400_017;
  for (const direction of ['upload', 'download'] as const) {
    for (const resume of [false, true]) {
      const name = `${direction}-${resume}.bin`, source = direction === 'upload' ? env.local : env.remote, target = direction === 'upload' ? env.remote : env.local;
      await fs.writeFile(path.join(source, name), bytes);
      if (resume) await fs.writeFile(path.join(target, `${name}.gooeshell.part`), bytes.subarray(0, prefix));
      const result = await env.transfer(name, direction);
      assert.deepEqual(await fs.readFile(path.join(target, name)), bytes);
      assert.equal(result.verificationReadBytes, 0, 'SHA256 verification must not reread remote payload');
      assert.equal(result.remoteReadBytes, direction === 'upload' ? 0 : bytes.length - (resume ? prefix : 0));
      assert.deepEqual(result.methods, ['sha256']);
      assert.equal(env.disk.handles.size, 0);
      assert(!(await fs.readdir(env.remote)).some(name => name.startsWith('.gooeshell-verify-')));
    }
  }
  assert.equal(env.python.calls, 6, 'four final digests plus two resume-prefix digests');
  for (const direction of ['upload', 'download'] as const) {
    const name = `mismatched-${direction}.bin`, source = direction === 'upload' ? env.local : env.remote, target = direction === 'upload' ? env.remote : env.local;
    const wrong = Buffer.from(bytes.subarray(0, prefix)); wrong[200_007] ^= 0xff;
    await fs.writeFile(path.join(source, name), bytes);
    await fs.writeFile(path.join(target, `${name}.gooeshell.part`), wrong);
    await assert.rejects(env.transfer(name, direction), /不一致/);
    assert.deepEqual(await fs.readFile(path.join(target, `${name}.gooeshell.part`)), wrong);
    await assert.rejects(fs.stat(path.join(target, name)), { code: 'ENOENT' });
    assert.equal(env.disk.readBytes, 0);
    assert.equal(env.disk.handles.size, 0);
    assert(!(await fs.readdir(env.remote)).some(name => name.startsWith('.gooeshell-verify-')));
  }
});

test('controlled 40 ms READ-latency benchmark compares baseline serial, remote digest and pipelined readback', {
  timeout: 60000, skip: process.env.GOOESHELL_HASH_BENCHMARK !== '1',
}, async t => {
  const env = await fixture(t), bytes = randomBytes(8 * 1024 * 1024);
  const baselineRevision = '3015fff30dbf610e62de51aa56c659a0ddbed023'; // Released 0.4.0, before this optimization.
  const source = execFileSync('git', ['show', `${baselineRevision}:desktop/src/main/sftp-transfer.ts`], { encoding: 'utf8', windowsHide: true });
  // An ignored copy is used so the historical implementation remains untouched.
  assert(source.includes("from './transfer-speed'"));
  const baselineFile = path.join(path.resolve('test-output'), `hash-baseline-${randomUUID()}.ts`);
  await fs.writeFile(baselineFile, source.replace("from './transfer-speed'", "from '../src/main/transfer-speed'"));
  t.after(async () => { await fs.unlink(baselineFile); });
  const baseline = (await import(pathToFileURL(baselineFile).href)).performSftpTransfer as typeof performSftpTransfer;
  env.disk.delayMs = 40;
  const rows: Array<Record<string, unknown>> = [];
  for (const [name, implementation, digest] of [
    ['baseline-serial', baseline, false], ['remote-sha256', performSftpTransfer, true], ['pipelined-readback', performSftpTransfer, false],
  ] as const) {
    await fs.writeFile(path.join(env.local, `${name}.bin`), bytes);
    const result = await env.transfer(`${name}.bin`, 'upload', implementation, digest);
    assert.deepEqual(await fs.readFile(path.join(env.remote, `${name}.bin`)), bytes);
    rows.push({ method: name, verificationMs: Math.round(result.verificationMs), remotePayloadBytes: result.verificationReadBytes });
  }
  assert.equal(rows[0].remotePayloadBytes, bytes.length);
  assert.equal(rows[1].remotePayloadBytes, 0);
  assert.equal(rows[2].remotePayloadBytes, bytes.length);
  const result = { scope: 'Isolated local disk + real Python helper, simulated 40 ms per SFTP READ response; not a real network/server benchmark. Windows includes WSL process startup.',
    baselineRevision, bytes: bytes.length, readResponseDelayMs: 40, results: rows };
  await fs.writeFile(path.join(path.resolve('test-output'), 'transfer-verification-benchmark.json'), JSON.stringify(result, null, 2) + '\n');
  t.diagnostic(JSON.stringify(result));
});
