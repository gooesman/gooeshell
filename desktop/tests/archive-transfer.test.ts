import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Client, type SFTPWrapper } from 'ssh2';
import { performArchiveTransfer, type ArchiveTransferOperations } from '../src/main/archive-transfer';
import { packLocalArchive, extractLocalArchive } from '../src/main/local-archive';
import { performSftpTransfer, sftpCall, trackSftp } from '../src/main/sftp-transfer';
import type { TransferInfo, TransferRequest } from '../src/shared/types';

function infoFor(request: TransferRequest): TransferInfo {
  return { id: randomUUID(), sessionId: request.sessionId, direction: request.direction,
    name: path.basename(request.source), source: request.source, destination: request.destinationDir,
    total: 0, done: 0, mode: 'archive', state: 'queued' };
}

test('archive orchestration retains targets, waits for extraction and cleans cancelled/failed jobs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gooeshell-archive-tests-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const request: TransferRequest = { sessionId: 'original-session', direction: 'upload', source: path.join(root, 'source.txt'),
    destinationDir: '/chosen', mode: 'archive', resume: true };
  await fs.writeFile(request.source, 'archive content');
  const remote = { directory: '/chosen', workDir: '/chosen/.job', archivePath: '/chosen/.job/payload.tar.gz', token: '0'.repeat(64) };
  let cleaned = 0, stoppedData = 0, scratch = '', extracted = false;
  const client = new EventEmitter() as Client;
  const sftp = Object.assign(new EventEmitter(), { destroy() { stoppedData++; } }) as SFTPWrapper;
  const ops: ArchiveTransferOperations = {
    packLocalArchive, extractLocalArchive,
    async prepareRemoteArchive(_client, options) { assert.deepEqual(options, { directory: '/chosen', name: 'source.txt' }); return remote; },
    async packRemoteArchive() { throw new Error('Unexpected remote pack'); },
    async cleanupRemoteArchive(_client, context) { assert.equal(context, remote); cleaned++; },
    async extractRemoteArchive(_client, options, progress) {
      assert.equal(options.expectedName, 'source.txt'); assert.equal(options.total, 15);
      extracted = true; progress?.({ done: 15, total: 15, entries: 1 });
      return { destination: '/chosen/source.txt', total: 15, entries: 1 };
    },
    async performSftpTransfer(_sftp, wire, wireInfo, _signal, emit) {
      scratch = wire.source;
      assert.equal(wire.resume, false); assert.equal(wire.mode, 'direct'); assert.equal(wire.sessionId, 'original-session');
      assert.equal(wire.destinationDir, remote.workDir);
      assert.equal(path.basename(wire.source), 'payload.tar.gz');
      assert.ok((await fs.stat(wire.source)).size > 0);
      wireInfo.destination = '/private/payload.tar.gz'; wireInfo.state = 'transferring'; wireInfo.done = 40; wireInfo.total = 40; emit(true);
    },
  };
  await t.test('packing, checked transfer and extraction keep original queue/retry identity', async () => {
    const info = infoFor(request), states: string[] = [];
    await performArchiveTransfer(client, sftp, request, info, new AbortController().signal, () => {
      states.push(info.state); assert.equal(info.name, 'source.txt'); assert.equal(info.source, request.source);
      assert.equal(info.destination, request.destinationDir); assert.equal(info.mode, 'archive');
      assert.notEqual(info.state, 'completed');
    }, 'fixture', undefined, ops);
    assert.ok(extracted); assert.equal(cleaned, 1);
    assert.deepEqual([...new Set(states)], ['packing', 'checking', 'transferring', 'extracting']);
    assert.equal(info.destination, '/chosen/source.txt'); assert.equal(info.done, 15);
    await assert.rejects(fs.stat(path.dirname(scratch)), { code: 'ENOENT' });
  });
  await t.test('cancel during prepare still cleans returned context without starting packing', async () => {
    const abort = new AbortController(); let packed = false;
    const cancellationOps = { ...ops,
      async prepareRemoteArchive() { abort.abort(); return remote; },
      async packLocalArchive(...args: Parameters<typeof packLocalArchive>) { packed = true; return packLocalArchive(...args); },
    };
    await assert.rejects(performArchiveTransfer(client, sftp, request, infoFor(request), abort.signal, () => {}, 'fixture', undefined, cancellationOps), /取消/);
    assert.equal(packed, false); assert.equal(cleaned, 2); assert.equal(stoppedData, 1);
  });
  await t.test('transfer failure cleans both archives and never starts extraction', async () => {
    extracted = false;
    await assert.rejects(performArchiveTransfer(client, sftp, request, infoFor(request), new AbortController().signal, () => {}, 'fixture', undefined, {
      ...ops, async performSftpTransfer(_sftp, wire) { scratch = wire.source; throw new Error('link lost'); },
    }), /link lost/);
    assert.equal(extracted, false); assert.equal(cleaned, 3);
    await assert.rejects(fs.stat(path.dirname(scratch)), { code: 'ENOENT' });
  });
  await t.test('cleanup failure after publication reports exact scratch location without failing delivery', async () => {
    const notices: string[] = [], info = infoFor(request);
    await performArchiveTransfer(client, sftp, request, info, new AbortController().signal, () => {}, 'fixture', value => notices.push(value), {
      ...ops, async cleanupRemoteArchive() { throw new Error('disconnected'); },
    });
    assert.equal(info.destination, '/chosen/source.txt'); assert.equal(notices.length, 1);
    assert.ok(notices[0].includes(remote.workDir));
    await assert.rejects(fs.stat(path.dirname(scratch)), { code: 'ENOENT' });
  });
  for (const reason of ['channel', 'transport', 'user'] as const) await t.test(`${reason} closure during packing stops CPU work without starting SFTP`, async () => {
    const controller = new AbortController();
    const connection = new EventEmitter() as Client;
    const channel = new EventEmitter() as SFTPWrapper;
    channel.destroy = () => { channel.emit('close'); };
    let wireStarted = false, remoteCleaned = false, packedArchive = '';
    const notices: string[] = [];
    await assert.rejects(performArchiveTransfer(connection, channel, request, infoFor(request), controller.signal, () => {}, 'fixture', value => notices.push(value), {
      ...ops,
      async packLocalArchive(source, archivePath, operationSignal, progress) {
        packedArchive = archivePath;
        return packLocalArchive(source, archivePath, operationSignal, (done, total) => {
          progress?.(done, total);
          if (!done) return;
          if (reason === 'user') controller.abort();
          else (reason === 'channel' ? channel : connection).emit('close');
        });
      },
      async performSftpTransfer() { wireStarted = true; },
      async cleanupRemoteArchive() { remoteCleaned = true; },
    }), reason === 'user' ? /已取消/ : /连接已断开.*重新连接/);
    assert.equal(controller.signal.aborted, reason === 'user');
    assert.equal(wireStarted, false);
    assert.equal(remoteCleaned, reason !== 'transport');
    assert.equal(notices.length, reason === 'transport' ? 1 : 0);
    await assert.rejects(fs.stat(path.dirname(packedArchive)), { code: 'ENOENT' });
    assert.equal(connection.listenerCount('close'), 0);
  });
  await t.test('a channel closed before packing is rejected before allocating archives', async () => {
    const channel = new EventEmitter() as SFTPWrapper;
    channel.destroy = () => {};
    trackSftp(channel); channel.emit('close');
    let prepared = false;
    await assert.rejects(performArchiveTransfer(new EventEmitter() as Client, channel, request, infoFor(request), new AbortController().signal, () => {}, 'fixture', undefined, {
      ...ops, async prepareRemoteArchive() { prepared = true; return remote; },
    }), /连接已断开/);
    assert.equal(prepared, false);
  });
  await t.test('download retains the chosen directory identity throughout packing and transfer', async () => {
    const destination = path.join(root, 'download-destination');
    await fs.mkdir(destination);
    const download: TransferRequest = { ...request, direction: 'download', source: '/source.txt', destinationDir: destination };
    let extractionStarted = false;
    await assert.rejects(performArchiveTransfer(client, sftp, download, infoFor(download), new AbortController().signal, () => {}, 'fixture', undefined, {
      ...ops,
      async prepareRemoteArchive() { return remote; },
      async packRemoteArchive() { return { name: 'source.txt', total: 15, archiveSize: 100, entries: 1 }; },
      async performSftpTransfer() {
        const backup = path.join(root, 'download-original');
        assert.equal(path.dirname(path.resolve(destination)), root);
        assert.equal(path.dirname(path.resolve(backup)), root);
        await fs.rename(destination, backup);
        await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, 'user.txt'), 'untouched');
      },
      async extractLocalArchive() { extractionStarted = true; throw new Error('Unexpected extraction'); },
    }), /目标目录.*发生变化/);
    assert.equal(extractionStarted, false);
    assert.deepEqual(await fs.readdir(destination), ['user.txt']);
  });
});

const readyFile = process.env.GOOESHELL_SFTP_TEST_READY;
test('compressed archives cross a real SFTP connection and automatically extract in both directions', {
  skip: readyFile ? false : 'Requires disposable loopback SFTP fixture', timeout: 90_000,
}, async t => {
  const values = Object.fromEntries((await fs.readFile(readyFile!, 'utf8')).trim().split(/\r?\n/).map(line => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
  }));
  assert.equal(values.fixture, 'gooeshell-sftp-v1'); assert.equal(values.host, '127.0.0.1');
  assert.ok(path.basename(values.root).startsWith('gooeshell-sftp-test-'));
  assert.equal(await fs.readFile(path.join(values.root, 'fixture.token'), 'utf8'), values.token);
  const client = new Client(); client.on('error', () => {}); t.after(() => client.destroy());
  await new Promise<void>((resolve, reject) => client.once('ready', resolve).once('error', reject).connect({
    host: values.host, port: Number(values.port), username: values.username, password: values.password,
    hostVerifier: (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === values.fingerprint,
  }));
  const caseName = randomUUID(), virtual = `/${caseName}`;
  const local = path.join(values.root, 'local', caseName), remote = path.join(values.root, 'remote', caseName);
  await fs.mkdir(local); await fs.mkdir(remote);
  const physical = (value: string) => {
    assert.ok(value === virtual || value.startsWith(virtual + '/'));
    const target = path.resolve(remote, '.' + value.slice(virtual.length));
    const relative = path.relative(remote, target);
    assert.ok(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    return target;
  };
  // This fixture only has an SFTP subsystem. Run archive endpoints against its
  // isolated filesystem; real Python exec/protocol has a separate Linux suite.
  const ops: ArchiveTransferOperations = {
    packLocalArchive, extractLocalArchive, performSftpTransfer,
    async prepareRemoteArchive(_client, options = {}) {
      const directory = options.directory ?? virtual;
      if (options.name) {
        try { await fs.lstat(path.join(physical(directory), options.name)); throw new Error('目标已存在'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const token = randomBytes(32).toString('hex'), workDir = `${directory}/.gooeshell-archive-${token}`;
      await fs.mkdir(physical(workDir));
      return { directory, workDir, token, archivePath: `${workDir}/payload.tar.gz` };
    },
    async packRemoteArchive(_client, options, progress, signal) {
      const packed = await packLocalArchive(physical(options.source), physical(options.context.archivePath), signal!,
        (done, total = 0) => progress?.({ done, total, entries: 0 }));
      return { name: packed.name, total: packed.originalBytes, entries: packed.entries,
        archiveSize: (await fs.stat(physical(options.context.archivePath))).size };
    },
    async extractRemoteArchive(_client, options, progress, signal) {
      const packed = await extractLocalArchive(physical(options.context.archivePath), physical(options.context.directory),
        options.expectedName, signal!, done => progress?.({ done, total: options.total!, entries: 0 }), options.total);
      return { destination: `${options.context.directory}/${packed.name}`, total: packed.originalBytes, entries: packed.entries };
    },
    async cleanupRemoteArchive(_client, context) {
      assert.ok(context.workDir.endsWith(`.gooeshell-archive-${context.token}`));
      await fs.rm(physical(context.workDir), { recursive: true, force: true });
    },
  };
  const transfer = async (direction: 'upload' | 'download', name: string) => {
    const request: TransferRequest = { sessionId: 'fixture', direction,
      source: direction === 'upload' ? path.join(local, name) : `${virtual}/${name}`,
      destinationDir: direction === 'upload' ? virtual : local, mode: 'archive', resume: true };
    const info = infoFor(request), states: string[] = [], notices: string[] = [];
    const sftp = await sftpCall<SFTPWrapper>(cb => client.sftp(cb)); sftp.on('error', () => {});
    try {
      await performArchiveTransfer(client, sftp, request, info, new AbortController().signal, () => {
        states.push(info.state); assert.equal(info.source, request.source); assert.equal(info.mode, 'archive');
      }, values.fingerprint, value => notices.push(value), ops);
      assert.deepEqual(notices, []); assert.ok(states.includes('packing')); assert.ok(states.includes('extracting'));
      assert.ok(states.includes('transferring'));
      return info;
    } finally { sftp.end(); }
  };
  const bytes = randomBytes(256 * 1024 + 321);
  for (const direction of ['upload', 'download'] as const) await t.test(`${direction}: Unicode tree, empty directory and incompressible bytes`, async () => {
    const name = `打包 ${direction}`, source = direction === 'upload' ? local : remote, destination = direction === 'upload' ? remote : local;
    await fs.mkdir(path.join(source, name, '空文件夹'), { recursive: true });
    await fs.writeFile(path.join(source, name, '内容.bin'), bytes);
    await fs.writeFile(path.join(source, name, '中文.txt'), '你好，gooeshell\n'.repeat(4000));
    const info = await transfer(direction, name);
    assert.deepEqual(await fs.readFile(path.join(destination, name, '内容.bin')), bytes);
    assert.equal(await fs.readFile(path.join(destination, name, '中文.txt'), 'utf8'), '你好，gooeshell\n'.repeat(4000));
    assert.ok((await fs.stat(path.join(destination, name, '空文件夹'))).isDirectory());
    assert.equal(info.done, info.total); assert.ok(info.total > bytes.length);
    assert.equal((await fs.readdir(remote)).some(value => value.startsWith('.gooeshell-archive-')), false);
    assert.equal((await fs.readdir(local)).some(value => value.startsWith('.gooeshell-unpack-')), false);
    await assert.rejects(transfer(direction, name), /已存在/);
    assert.deepEqual(await fs.readFile(path.join(destination, name, '内容.bin')), bytes);
  });
});
