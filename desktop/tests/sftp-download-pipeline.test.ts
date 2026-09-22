import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SFTPWrapper, Stats } from 'ssh2';
import { performSftpTransfer } from '../src/main/sftp-transfer';
import type { TransferInfo, TransferRequest } from '../src/shared/types';

const CHUNK = 64 * 1024;
type Callback<T = void> = (error: Error | null, result?: T) => void;
type Read = { position: number; length: number; checking: boolean };
class DownloadSftp extends EventEmitter {
  active = 0; maximum = 0; payloadActive = 0; payloadMaximum = 0; closes: number[] = []; reads: Read[] = [];
  shortRead = CHUNK; failureAt?: number; corrupt = false;
  delay = (read: Read) => read.checking ? 1 : read.position === 0 ? 25 : 1;
  onRead?: (read: Read) => void;
  constructor(readonly bytes: Buffer, readonly info: TransferInfo) { super(); }
  get wrapper(): SFTPWrapper { return this as unknown as SFTPWrapper; }
  private stat(): Stats { return { size: this.bytes.length, mtime: 1, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false } as Stats; }
  realpath(name: string, callback: Callback<string>): void { setImmediate(() => callback(null, name)); }
  lstat(_name: string, callback: Callback<Stats>): void { setImmediate(() => callback(null, this.stat())); }
  fstat(_handle: Buffer, callback: Callback<Stats>): void { setImmediate(() => callback(null, this.stat())); }
  open(_name: string, _flags: string, callback: Callback<Buffer>): void { setImmediate(() => callback(null, Buffer.from('handle'))); }
  close(_handle: Buffer, callback: Callback): void { this.closes.push(this.active); setImmediate(() => callback(null)); }
  read(_handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: Callback<number>): void {
    const read = { position, length, checking: this.info.state === 'checking' };
    this.reads.push(read); this.active++; this.maximum = Math.max(this.maximum, this.active);
    if (!read.checking) { this.payloadActive++; this.payloadMaximum = Math.max(this.payloadMaximum, this.payloadActive); }
    this.onRead?.(read);
    setTimeout(() => {
      this.active--;
      if (!read.checking) this.payloadActive--;
      if (!read.checking && this.failureAt === position) { callback(new Error('injected download failure')); return; }
      const count = Math.min(length, this.shortRead, this.bytes.length - position);
      this.bytes.copy(buffer, offset, position, position + count);
      if (this.corrupt && !read.checking && position === CHUNK && count) buffer[offset] ^= 0xff;
      callback(null, count);
    }, this.delay(read));
  }
}

async function fixture(t: TestContext, prefixLength = 0) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'gooeshell-download-pipeline-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('gooeshell-download-pipeline-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const bytes = Buffer.allocUnsafe(49 * CHUNK + 131);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + Math.floor(i / CHUNK)) % 251;
  const request: TransferRequest = { sessionId: 'pipeline', direction: 'download', source: '/file.bin', destinationDir: root, resume: true };
  const info: TransferInfo = { ...request, id: randomUUID(), name: 'file.bin', destination: root, state: 'queued', done: 0, total: 0 };
  const destination = path.join(root, 'file.bin'), partial = destination + '.gooeshell.part';
  if (prefixLength) await fs.writeFile(partial, bytes.subarray(0, prefixLength));
  const sftp = new DownloadSftp(bytes, info);
  let abort = new AbortController(), onProgress: () => void = () => {};
  const run = () => performSftpTransfer(sftp.wrapper, request, info, abort.signal, () => onProgress(), root);
  const assertUnpublished = () => assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  return { root, bytes, info, destination, partial, sftp, run, assertUnpublished,
    abort: () => abort.abort(), setProgress: (callback: () => void) => { onProgress = callback; },
    reset: () => { abort = new AbortController(); info.done = 0; onProgress = () => {}; sftp.failureAt = undefined; },
  };
}

test('download reorders short reads with a bounded window and commits exact contents', async t => {
  const f = await fixture(t);
  f.sftp.shortRead = 8191;
  f.sftp.onRead = read => {
    if (!read.checking) assert.ok(read.position < f.info.done + 16 * CHUNK, 'read-ahead must stay below the fixed 1 MiB window');
  };
  await f.run();
  assert.deepEqual(await fs.readFile(f.destination), f.bytes);
  assert.equal(f.info.done, f.bytes.length);
  assert.equal(f.sftp.maximum, 16);
  assert.equal(f.sftp.payloadMaximum, 16, 'new payload reads must overlap, independently of parallel verification');
  assert.deepEqual(f.sftp.closes, [0]);
  assert.equal(f.sftp.reads.filter(read => !read.checking && read.position < CHUNK).length, 9);
});

test('cancelled out-of-order download retains only the committed prefix and resumes', async t => {
  const f = await fixture(t, 31);
  f.setProgress(() => { if (f.info.state === 'transferring' && f.info.done >= 31 + CHUNK) f.abort(); });
  await assert.rejects(f.run(), /已取消/);
  await f.assertUnpublished();
  assert.deepEqual(await fs.readFile(f.partial), f.bytes.subarray(0, 31 + CHUNK));
  assert.equal(f.sftp.active, 0); assert.deepEqual(f.sftp.closes, [0]);
  f.reset(); await f.run();
  assert.deepEqual(await fs.readFile(f.destination), f.bytes);
});

test('a failed later read drains pending requests without extending a resumed prefix', async t => {
  const prefix = 70_031, f = await fixture(t, prefix);
  f.sftp.failureAt = prefix + 5 * CHUNK;
  f.sftp.delay = read => read.checking ? 1 : read.position === f.sftp.failureAt ? 1 : 25;
  await assert.rejects(f.run(), /injected download failure/);
  assert.deepEqual(await fs.readFile(f.partial), f.bytes.subarray(0, prefix));
  assert.equal(f.sftp.active, 0); assert.deepEqual(f.sftp.closes, [0]);
  await f.assertUnpublished();
  f.reset(); await f.run();
  assert.deepEqual(await fs.readFile(f.destination), f.bytes);
});

test('failure halfway through a short-read block does not write incomplete buffered data', async t => {
  const f = await fixture(t);
  f.sftp.shortRead = CHUNK / 2; f.sftp.failureAt = 4 * CHUNK + CHUNK / 2;
  await assert.rejects(f.run(), /injected download failure/);
  const partial = await fs.readFile(f.partial);
  assert.equal(partial.length % CHUNK, 0);
  assert.deepEqual(partial, f.bytes.subarray(0, partial.length));
  assert.equal(f.sftp.active, 0); assert.deepEqual(f.sftp.closes, [0]);
  f.reset(); await f.run();
  assert.deepEqual(await fs.readFile(f.destination), f.bytes);
});

test('download still verifies contents and refuses publication on corruption', async t => {
  const f = await fixture(t); f.sftp.corrupt = true;
  await assert.rejects(f.run(), /不一致/);
  await f.assertUnpublished();
  assert.equal((await fs.stat(f.partial)).size, f.bytes.length);
  assert.equal(f.sftp.active, 0); assert.deepEqual(f.sftp.closes, [0]);
});

test('a destination created during pipelined download is never overwritten', async t => {
  const f = await fixture(t);
  let created: Promise<void> | undefined;
  f.setProgress(() => {
    if (!created && f.info.state === 'transferring' && f.info.done > 0) created = fs.writeFile(f.destination, 'keep this other file', { flag: 'wx' });
  });
  await assert.rejects(f.run(), /无法发布下载文件/);
  await created;
  assert.equal(await fs.readFile(f.destination, 'utf8'), 'keep this other file');
  assert.deepEqual(await fs.readFile(f.partial), f.bytes);
});
