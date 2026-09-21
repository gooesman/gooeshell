import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, truncateSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SFTPWrapper, Stats } from 'ssh2';
import { performSftpTransfer } from '../src/main/sftp-transfer';
import type { RemoteTransferHash } from '../src/main/remote-transfer-hash';
import type { TransferInfo, TransferRequest } from '../src/shared/types';

const CHUNK = 64 * 1024;
type Direction = TransferRequest['direction'];
type Node = { bytes: Buffer; mtime: number; directory?: boolean };
type ReadCall = { path: string; position: number; length: number; checking: boolean; returned?: number };
type Callback<T = void> = (error: Error | undefined, result: T) => void;
const missing = () => Object.assign(new Error('No such file'), { code: 2 });

/** Minimal asynchronous SFTP transport. Files are separate from the real local
 * filesystem, so verification must actually inspect either endpoint's bytes. */
class MemorySftp extends EventEmitter {
  readonly nodes = new Map<string, Node>([['/remote', { bytes: Buffer.alloc(0), mtime: 1, directory: true }]]);
  readonly handles = new Map<string, string>();
  readonly reads: ReadCall[] = [];
  readonly writes: { path: string; position: number; length: number }[] = [];
  readonly published: string[] = [];
  readonly closeActiveReads: number[] = [];
  activeReads = 0;
  maxActiveReads = 0;
  maxRead = Infinity;
  corruptAt?: number;
  failReadAt?: number;
  readDelay: (call: ReadCall) => number = () => 1;
  constructor(readonly phase: () => TransferInfo['state']) { super(); }
  get wrapper(): SFTPWrapper { return this as unknown as SFTPWrapper; }
  put(name: string, bytes: Buffer): void { this.nodes.set(name, { bytes: Buffer.from(bytes), mtime: 123 }); }
  node(name: string): Node { const node = this.nodes.get(name); if (!node) throw missing(); return node; }
  private name(handle: Buffer): string { const name = this.handles.get(handle.toString()); if (!name) throw new Error('Handle already closed'); return name; }
  private stat(name: string): Stats {
    const node = this.node(name);
    return { size: node.bytes.length, mtime: node.mtime, isFile: () => !node.directory, isDirectory: () => !!node.directory, isSymbolicLink: () => false } as Stats;
  }
  private reply<T>(callback: Callback<T>, operation: () => T): void {
    setImmediate(() => { let value: T; try { value = operation(); } catch (error) { callback(error as Error, undefined as T); return; } callback(undefined, value); });
  }
  realpath(name: string, callback: Callback<string>): void { this.reply(callback, () => { this.node(name); return name; }); }
  lstat(name: string, callback: Callback<Stats>): void { this.reply(callback, () => this.stat(name)); }
  fstat(handle: Buffer, callback: Callback<Stats>): void { this.reply(callback, () => this.stat(this.name(handle))); }
  open(name: string, flags: string | number, attrsOrCallback: unknown, callback?: Callback<Buffer>): void {
    const done = (typeof attrsOrCallback === 'function' ? attrsOrCallback : callback) as Callback<Buffer>;
    this.reply(done, () => {
      if (typeof flags === 'number') { if (this.nodes.has(name)) throw new Error('File exists'); this.put(name, Buffer.alloc(0)); }
      this.node(name); const handle = randomUUID(); this.handles.set(handle, name); return Buffer.from(handle);
    });
  }
  read(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: Callback<number>): void {
    const name = this.name(handle), call: ReadCall = { path: name, position, length, checking: this.phase() === 'checking' };
    this.reads.push(call); this.activeReads++; this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
    setTimeout(() => {
      let count = 0, error: Error | undefined;
      try {
        assert.ok(this.handles.has(handle.toString()), 'remote read must settle before its handle closes');
        if (call.checking && this.failReadAt === position) throw new Error('injected read failure');
        const source = this.node(name).bytes;
        count = Math.max(0, Math.min(length, this.maxRead, source.length - position));
        source.copy(buffer, offset, position, position + count);
        if (call.checking && this.corruptAt !== undefined && this.corruptAt >= position && this.corruptAt < position + count) buffer[offset + this.corruptAt - position] ^= 0xff;
        call.returned = count;
      } catch (caught) { error = caught as Error; }
      this.activeReads--; callback(error, count);
    }, this.readDelay(call));
  }
  write(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: Callback): void {
    this.reply(callback, () => {
      const name = this.name(handle), node = this.node(name);
      if (position + length > node.bytes.length) { const next = Buffer.alloc(position + length); node.bytes.copy(next); node.bytes = next; }
      buffer.copy(node.bytes, position, offset, offset + length); node.mtime++;
      this.writes.push({ path: name, position, length });
    });
  }
  close(handle: Buffer, callback: Callback): void {
    this.closeActiveReads.push(this.activeReads);
    this.reply(callback, () => { assert.ok(this.handles.delete(handle.toString())); });
  }
  rename(source: string, destination: string, callback: Callback): void {
    this.reply(callback, () => { if (this.nodes.has(destination)) throw new Error('File exists'); this.nodes.set(destination, this.node(source)); this.nodes.delete(source); this.published.push(destination); });
  }
  unlink(name: string, callback: Callback): void { this.reply(callback, () => { if (!this.nodes.delete(name)) throw missing(); }); }
}

function contents(size: number): Buffer {
  const result = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index++) result[index] = (index * 19 + Math.floor(index / CHUNK)) % 251;
  return result;
}

async function fixture(t: TestContext, direction: Direction, data: Buffer, prefix?: Buffer) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'gooeshell-verification-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('gooeshell-verification-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const local = path.join(root, 'file.bin'), remote = '/remote/file.bin';
  const request: TransferRequest = { sessionId: 'verification-test', direction, source: direction === 'upload' ? local : remote, destinationDir: direction === 'upload' ? '/remote' : root, resume: true };
  const info: TransferInfo = { ...request, id: randomUUID(), name: 'file.bin', destination: request.destinationDir, state: 'queued', done: 0, total: 0 };
  const sftp = new MemorySftp(() => info.state), abort = new AbortController(), samples: TransferInfo[] = [];
  if (direction === 'upload') { await fs.writeFile(local, data); if (prefix !== undefined) sftp.put(remote + '.gooeshell.part', prefix); }
  else { sftp.put(remote, data); if (prefix !== undefined) await fs.writeFile(local + '.gooeshell.part', prefix); }
  const hashes: { path: string; length: number }[] = [];
  const hash: RemoteTransferHash = async (name, length, signal, update) => {
    hashes.push({ path: name, length });
    const node = sftp.node(name), snapshot = Buffer.from(node.bytes), mtime = node.mtime;
    for (let done = 0; done < length;) { signal.throwIfAborted(); done = Math.min(length, done + CHUNK); update?.(done); await new Promise<void>(resolve => setImmediate(resolve)); }
    signal.throwIfAborted(); return { sha256: createHash('sha256').update(snapshot.subarray(0, length)).digest('hex'), size: snapshot.length, mtime };
  };
  const run = (remoteHash?: RemoteTransferHash) => performSftpTransfer(sftp.wrapper, request, info, abort.signal, () => samples.push({ ...info, verification: info.verification && { ...info.verification } }), randomUUID(), remoteHash);
  const result = () => direction === 'upload' ? Promise.resolve(sftp.node(remote).bytes) : fs.readFile(local);
  const partial = () => direction === 'upload' ? Promise.resolve(sftp.node(remote + '.gooeshell.part').bytes) : fs.readFile(local + '.gooeshell.part');
  const assertUnpublished = async () => {
    if (direction === 'upload') assert.equal(sftp.nodes.has(remote), false);
    else await assert.rejects(fs.stat(local), { code: 'ENOENT' });
  };
  return { sftp, abort, info, hashes, hash, run, result, partial, samples, assertUnpublished };
}

for (const direction of ['upload', 'download'] as const) {
  test(`SHA256 ${direction} verifies full contents and resumed prefixes without SFTP verification reads`, async t => {
    const data = contents(8 * CHUNK + 37), prefix = data.subarray(0, 5 * CHUNK + 83);
    for (const existing of [undefined, prefix]) {
      const f = await fixture(t, direction, data, existing);
      await f.run(f.hash);
      assert.deepEqual(await f.result(), data);
      assert.equal(f.sftp.reads.filter(read => read.checking).length, 0);
      assert.deepEqual(f.hashes.map(call => call.length), existing ? [existing.length, data.length] : [data.length]);
      assert.equal(f.info.done, data.length);
      const payloadBytes = direction === 'upload' ? f.sftp.writes.reduce((sum, write) => sum + write.length, 0) : f.sftp.reads.reduce((sum, read) => sum + (read.returned || 0), 0);
      assert.equal(payloadBytes, data.length - (existing?.length || 0));
    }
  });

  test(`SHA256 ${direction} rejects a changed resume prefix before modifying or publishing it`, async t => {
    const data = contents(8 * CHUNK), wrong = Buffer.from(data.subarray(0, 5 * CHUNK)); wrong[CHUNK + 11] ^= 0xff;
    const f = await fixture(t, direction, data, wrong);
    await assert.rejects(f.run(f.hash), /不一致/);
    assert.deepEqual(await f.partial(), wrong);
    assert.equal(f.sftp.writes.length, 0); assert.equal(f.sftp.reads.length, 0);
    await f.assertUnpublished();
  });

  test(`SHA256 ${direction} retains the complete partial after a final checksum mismatch`, async t => {
    const data = contents(5 * CHUNK + 19), f = await fixture(t, direction, data);
    await assert.rejects(f.run(async (...args) => ({ ...(await f.hash(...args))!, sha256: '0'.repeat(64) })), /不一致/);
    assert.deepEqual(await f.partial(), data); await f.assertUnpublished();
    assert.equal(f.sftp.reads.filter(read => read.checking).length, 0, 'a bad hash is never downgraded to readback');
  });

  test(`${direction} empty files and fully transferred partials publish without retransmission`, async t => {
    for (const data of [Buffer.alloc(0), contents(5 * CHUNK + 17)]) {
      const f = await fixture(t, direction, data, data);
      await f.run(f.hash); assert.deepEqual(await f.result(), data);
      assert.equal(f.sftp.writes.length, 0); assert.equal(f.sftp.reads.length, 0);
      assert.deepEqual(f.hashes.map(call => call.length), data.length ? [data.length, data.length] : []);
      assert.ok(f.samples.filter(sample => sample.state === 'transferring').every(sample => sample.bytesPerSecond === 0));
    }
  });
}

test('a remote hash error or cancellation never falls back to SFTP readback', async t => {
  for (const cancel of [false, true]) {
    const data = contents(8 * CHUNK), prefix = data.subarray(0, 5 * CHUNK), f = await fixture(t, 'upload', data, prefix);
    await assert.rejects(f.run(async (_name, _length, signal) => {
      if (cancel) { f.abort.abort(); signal.throwIfAborted(); }
      throw new Error('remote hash failed');
    }), cancel ? /已取消/ : /remote hash failed/);
    assert.equal(f.sftp.reads.length, 0); assert.equal(f.sftp.writes.length, 0);
    assert.deepEqual(await f.partial(), prefix); await f.assertUnpublished();
    assert.equal(f.sftp.handles.size, 0);
  }
});

test('small files use readback without starting a remote checksum process', async t => {
  const data = contents(4 * CHUNK - 1);
  for (const direction of ['upload', 'download'] as const) {
    const f = await fixture(t, direction, data, data.subarray(0, CHUNK + 17));
    await f.run(async () => { throw new Error('small transfers must not launch a remote checksum'); });
    assert.deepEqual(await f.result(), data);
    assert.ok(f.sftp.reads.some(read => read.checking));
    assert.ok(f.samples.filter(sample => sample.verification).every(sample => sample.verification!.method === 'readback'));
  }
});

test('a local read failure is preserved instead of reporting the remote secondary cancellation', async t => {
  const data = contents(48 * CHUNK), f = await fixture(t, 'upload', data);
  await assert.rejects(f.run(async (_name, _length, signal) => {
    truncateSync(f.info.source, 0);
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('校验已取消'), { name: 'AbortError' }));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    throw new Error('Unreachable');
  }), /内容不一致/);
  assert.equal(f.sftp.reads.length, 0);
  await f.assertUnpublished();
});

test('unsupported remote hashing uses bounded parallel readback and handles short reads', async t => {
  for (const shortReads of [false, true]) {
    const data = contents(40 * CHUNK + 29), f = await fixture(t, 'upload', data, data);
    if (shortReads) f.sftp.maxRead = 10_003;
    await f.run(async () => undefined);
    assert.deepEqual(await f.result(), data);
    assert.equal(f.sftp.maxActiveReads, 16, 'readback must overlap 16 requests without exceeding the bound');
    assert.equal(f.sftp.activeReads, 0);
    assert.ok(f.sftp.closeActiveReads.every(count => count === 0));
    const bytesRead = f.sftp.reads.reduce((sum, read) => sum + (read.returned || 0), 0);
    assert.equal(bytesRead, 2 * data.length, 'resume and final verification inspect every byte exactly once');
    if (shortReads) assert.ok(f.sftp.reads.some(read => read.position % CHUNK !== 0), 'short reads require explicit remainder requests');
    assert.ok(f.samples.some(sample => sample.verification?.method === 'readback'));
  }
});

test('parallel readback rejects corruption in the middle of an otherwise correct file', async t => {
  const data = contents(40 * CHUNK), f = await fixture(t, 'upload', data);
  f.sftp.corruptAt = 23 * CHUNK + 123;
  await assert.rejects(f.run(async () => undefined), /不一致/);
  assert.deepEqual(await f.partial(), data); await f.assertUnpublished();
  assert.ok(f.sftp.reads.some(read => read.position <= f.sftp.corruptAt! && read.position + (read.returned || 0) > f.sftp.corruptAt!));
  assert.equal(f.sftp.activeReads, 0); assert.ok(f.sftp.closeActiveReads.every(count => count === 0));
});

test('failed parallel verification drains every outstanding read before closing handles', async t => {
  const data = contents(40 * CHUNK), f = await fixture(t, 'upload', data, data.subarray(0, 32 * CHUNK));
  f.sftp.failReadAt = 0; f.sftp.readDelay = call => call.position === 0 ? 1 : 30;
  await assert.rejects(f.run(async () => undefined), /injected read failure/);
  assert.equal(f.sftp.maxActiveReads, 16); assert.equal(f.sftp.activeReads, 0);
  assert.deepEqual(f.sftp.closeActiveReads, [0]); assert.equal(f.sftp.handles.size, 0);
  assert.equal(f.sftp.writes.length, 0); await f.assertUnpublished();
});

test('verification progress is separate from transfer speed and excludes resumed bytes', async t => {
  const data = contents(9 * CHUNK + 256), prefix = data.subarray(0, data.length - 256);
  for (const remoteHash of [true, false]) {
    const f = await fixture(t, 'download', data, prefix);
    await f.run(remoteHash ? f.hash : async () => undefined);
    const checks = f.samples.filter(sample => sample.verification), moving = f.samples.filter(sample => sample.state === 'transferring');
    assert.ok(checks.length > 0);
    assert.ok(checks.every(sample => sample.state === 'checking' && sample.bytesPerSecond === undefined));
    for (const stage of ['resume', 'final'] as const) {
      const events = checks.filter(sample => sample.verification!.stage === stage), expected = stage === 'resume' ? prefix.length : data.length;
      assert.ok(events.length > 1); assert.ok(events.every(sample => sample.verification!.total === expected));
      assert.equal(events.at(-1)!.verification!.done, expected);
      assert.ok(events.every(sample => sample.verification!.done >= 0 && sample.verification!.done <= expected));
    }
    assert.equal(moving[0].done, prefix.length); assert.equal(moving[0].bytesPerSecond, 0);
    assert.ok(moving.every(sample => !sample.verification && (sample.bytesPerSecond || 0) <= 2560));
    assert.ok(moving.some(sample => (sample.bytesPerSecond || 0) > 0));
    assert.equal(f.info.bytesPerSecond, undefined);
  }
});
