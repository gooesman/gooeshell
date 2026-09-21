import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { Client, SFTPWrapper } from 'ssh2';
import type { RemoteTransferHash, RemoteTransferHashProof } from '../src/main/remote-transfer-hash';
import { createTransferHash } from '../src/main/transfer-hash-probe';

const LARGE = 256 * 1024;
const digest = { sha256: 'a'.repeat(64), size: LARGE, mtime: 1_700_000_000 };
const denied = (code: number | string) => Object.assign(new Error(`refused ${code}`), { code });

function fixture(raw: RemoteTransferHash) {
  const channel = new EventEmitter();
  const files = new Map<string, Buffer>();
  const handles = new Map<string, string>();
  const opens: string[] = [], unlinks: string[] = [], closes: string[] = [];
  let nextHandle = 0;
  const controls: { openError?: Error; writeError?: Error; closeError?: Error; unlinkError?: Error;
    afterOpen?: () => void; afterWrite?: () => void; afterClose?: () => void } = {};
  const sftp = Object.assign(channel, {
    open(name: string, flags: string, attrs: { mode: number }, callback: (error: Error | null, handle?: Buffer) => void) {
      opens.push(name);
      assert.equal(flags, 'wx'); assert.equal(attrs.mode, 0o600);
      if (controls.openError) return callback(controls.openError);
      assert.equal(files.has(name), false);
      const handle = Buffer.from(String(++nextHandle));
      handles.set(handle.toString(), name); files.set(name, Buffer.alloc(0));
      controls.afterOpen?.(); callback(null, handle);
    },
    write(handle: Buffer, data: Buffer, offset: number, length: number, position: number, callback: (error?: Error) => void) {
      if (controls.writeError) return callback(controls.writeError);
      assert.equal(position, 0); assert.equal(offset, 0); assert.equal(length, 64);
      const name = handles.get(handle.toString()); assert.ok(name);
      files.set(name, Buffer.from(data.subarray(offset, offset + length)));
      controls.afterWrite?.(); callback();
    },
    close(handle: Buffer, callback: (error?: Error) => void) {
      closes.push(handle.toString());
      if (controls.closeError) return callback(controls.closeError);
      assert.equal(handles.delete(handle.toString()), true);
      controls.afterClose?.(); callback();
    },
    unlink(name: string, callback: (error?: Error) => void) {
      unlinks.push(name);
      if (controls.unlinkError) return callback(controls.unlinkError);
      assert.equal(files.delete(name), true); callback();
    },
  }) as unknown as SFTPWrapper;
  return { hash: createTransferHash(sftp, {} as Client, raw), sftp, files, handles, opens, unlinks, closes, controls };
}

test('a large checksum proves its own SFTP parent, closes the probe before exec, then removes it', async () => {
  const progress: number[] = [];
  const f = fixture(async (remote, length, _signal, emit, proof) => {
    assert.equal(remote, '/目录/space name.bin'); assert.equal(length, LARGE);
    assert.ok(proof);
    assert.equal(path.posix.dirname(proof.path), '/目录');
    assert.match(path.posix.basename(proof.path), /^\.gooeshell-verify-[a-f0-9-]{36}$/);
    assert.match(proof.token, /^[a-f0-9]{64}$/);
    assert.equal(f.files.get(proof.path)?.toString('ascii'), proof.token);
    assert.equal(f.handles.size, 0);
    emit?.(length); return digest;
  });
  assert.deepEqual(await f.hash('/目录/space name.bin', LARGE, new AbortController().signal, n => progress.push(n)), digest);
  assert.deepEqual(progress, [LARGE]); assert.deepEqual(f.unlinks, f.opens);
  assert.equal(f.files.size, 0); assert.equal(f.closes.length, 1);
});

test('small files and prefixes avoid both exec and optional probe writes', async () => {
  const f = fixture(async () => { throw new Error('must not exec'); });
  for (const length of [0, 1, LARGE - 1]) assert.equal(await f.hash('/data/file', length, new AbortController().signal), undefined);
  assert.deepEqual(f.opens, []);
});

test('creation refusals fall back and are cached only for that parent directory', async () => {
  for (const code of [2, 3, 4, 8, 'EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']) {
    let called = 0;
    const f = fixture(async () => { called++; return digest; });
    f.controls.openError = denied(code);
    assert.equal(await f.hash('/readonly/one', LARGE, new AbortController().signal), undefined);
    f.controls.openError = undefined;
    assert.equal(await f.hash('/readonly/two', LARGE, new AbortController().signal), undefined);
    assert.equal(f.opens.length, 1); assert.equal(called, 0); assert.equal(f.unlinks.length, 0);
    assert.deepEqual(await f.hash('/writable/one', LARGE, new AbortController().signal), digest);
    assert.equal(called, 1);
  }
});

test('unavailable exec or a different namespace returns to comparison and removes its probe', async () => {
  let calls = 0;
  const f = fixture(async (_remote, _length, _signal, _progress, proof) => {
    assert.ok(proof); calls++; return undefined;
  });
  assert.equal(await f.hash('/chroot/one', LARGE, new AbortController().signal), undefined);
  assert.equal(await f.hash('/chroot/two', LARGE, new AbortController().signal), undefined);
  assert.equal(calls, 1); assert.equal(f.opens.length, 1); assert.equal(f.files.size, 0);
  assert.equal(await f.hash('/other/one', LARGE, new AbortController().signal), undefined);
  assert.equal(calls, 2);
});

test('every verification receives a fresh proof, including a resumed prefix and final full hash', async () => {
  const proofs: RemoteTransferHashProof[] = [];
  const f = fixture(async (_remote, _length, _signal, _progress, proof) => {
    assert.ok(proof); proofs.push(proof); return digest;
  });
  await f.hash('/data/same.part', LARGE, new AbortController().signal);
  await f.hash('/data/same.part', LARGE * 2, new AbortController().signal);
  assert.notEqual(proofs[0].path, proofs[1].path); assert.notEqual(proofs[0].token, proofs[1].token);
  assert.equal(f.files.size, 0);
});

test('source changes and transport errors are not mistaken for missing helper capability', async () => {
  let calls = 0;
  const changed = new Error('文件在校验期间改变');
  const f = fixture(async () => { calls++; throw changed; });
  for (let n = 0; n < 2; n++) await assert.rejects(f.hash('/data/file', LARGE, new AbortController().signal), error => error === changed);
  assert.equal(calls, 2); assert.equal(f.files.size, 0);
  f.controls.openError = new Error('transport interrupted');
  await assert.rejects(f.hash('/data/other', LARGE, new AbortController().signal), /transport interrupted/);
  assert.equal(f.unlinks.length, 2);
});

test('failed writes and closes preserve the original error and clean only the owned probe', async () => {
  for (const field of ['writeError', 'closeError'] as const) {
    const f = fixture(async () => { throw new Error('must not exec'); });
    f.controls[field] = new Error(field);
    await assert.rejects(f.hash('/data/file', LARGE, new AbortController().signal), new RegExp(field));
    assert.equal(f.files.size, 0); assert.deepEqual(f.unlinks, f.opens);
  }
});

test('a cleanup refusal cannot turn an already valid checksum into a failed transfer', async () => {
  const f = fixture(async () => digest);
  f.controls.unlinkError = denied(3);
  assert.deepEqual(await f.hash('/data/file', LARGE, new AbortController().signal), digest);
  assert.equal(f.unlinks.length, 1); assert.equal(f.files.size, 1);
});

test('cancellation before opening, after creation, and during hashing never returns a successful digest', async () => {
  for (const stage of ['before', 'open', 'write', 'close', 'hash'] as const) {
    const abort = new AbortController(); let hashes = 0;
    const f = fixture(async () => { hashes++; if (stage === 'hash') abort.abort(); return digest; });
    if (stage === 'before') abort.abort();
    if (stage === 'open') f.controls.afterOpen = () => abort.abort();
    if (stage === 'write') f.controls.afterWrite = () => abort.abort();
    if (stage === 'close') f.controls.afterClose = () => abort.abort();
    await assert.rejects(f.hash('/data/file', LARGE, abort.signal), { name: 'AbortError' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hashes, stage === 'hash' ? 1 : 0); assert.equal(f.files.size, 0);
  }
});

test('closed SFTP channels never receive queued cleanup or another probe', async () => {
  for (const event of ['end', 'close']) {
    const f = fixture(async () => { f.sftp.emit(event); return digest; });
    await assert.rejects(f.hash('/data/file', LARGE, new AbortController().signal), /SFTP 连接已关闭/);
    assert.equal(f.closes.length, 1); assert.equal(f.unlinks.length, 0);
    await assert.rejects(f.hash('/data/other', LARGE, new AbortController().signal), /SFTP 连接已关闭/);
    assert.equal(f.opens.length, 1);
  }
});

test('a closed channel rejects an outstanding SFTP operation instead of leaving it pending', async () => {
  const f = fixture(async () => digest);
  f.sftp.open = (() => { queueMicrotask(() => f.sftp.emit('close')); }) as SFTPWrapper['open'];
  await assert.rejects(f.hash('/data/file', LARGE, new AbortController().signal), /SFTP 连接已关闭/);
  assert.equal(f.unlinks.length, 0);
});

test('cancelling a delayed OPEN returns promptly and cleans a late successful creation', async () => {
  const f = fixture(async () => { throw new Error('must not exec'); });
  const abort = new AbortController();
  const original = f.sftp.open;
  let reply: (() => void) | undefined;
  f.sftp.open = ((name: string, flags: string, attrs: unknown, callback: unknown) => {
    reply = () => original.call(f.sftp, name, flags, attrs as never, callback as never);
  }) as SFTPWrapper['open'];
  const job = f.hash('/data/file', LARGE, abort.signal);
  assert.ok(reply); abort.abort();
  await assert.rejects(job, { name: 'AbortError' });
  assert.equal(f.opens.length, 0);
  reply();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.opens.length, 1); assert.equal(f.closes.length, 1);
  assert.deepEqual(f.unlinks, f.opens); assert.equal(f.files.size, 0);
});

test('cancelling a delayed WRITE defers cleanup until that write settles', async () => {
  const f = fixture(async () => { throw new Error('must not exec'); });
  const abort = new AbortController();
  const original = f.sftp.write;
  let reply: (() => void) | undefined;
  f.sftp.write = ((...args: Parameters<SFTPWrapper['write']>) => {
    reply = () => original.apply(f.sftp, args);
  }) as SFTPWrapper['write'];
  const job = f.hash('/data/file', LARGE, abort.signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(reply); abort.abort();
  await assert.rejects(job, { name: 'AbortError' });
  assert.equal(f.closes.length, 0); assert.equal(f.unlinks.length, 0);
  reply();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.closes.length, 1); assert.deepEqual(f.unlinks, f.opens); assert.equal(f.files.size, 0);
});

test('cancellation during pending cleanup returns promptly while owned cleanup can finish later', async () => {
  for (const failHash of [false, true]) {
    const hashError = new Error('source changed while hashing');
    const f = fixture(async () => { if (failHash) throw hashError; return digest; });
    const abort = new AbortController();
    const original = f.sftp.unlink;
    let reply: (() => void) | undefined;
    f.sftp.unlink = ((name: string, callback: Parameters<SFTPWrapper['unlink']>[1]) => {
      reply = () => original.call(f.sftp, name, callback);
    }) as SFTPWrapper['unlink'];
    const job = f.hash('/data/file', LARGE, abort.signal);
    const rejected = assert.rejects(job, error => failHash ? error === hashError : (error as Error).name === 'AbortError');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(reply); abort.abort();
    await rejected;
    assert.equal(f.files.size, 1); assert.equal(f.unlinks.length, 0);
    reply();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.files.size, 0); assert.deepEqual(f.unlinks, f.opens);
  }
});
