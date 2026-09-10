import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client, type SFTPWrapper } from 'ssh2';
import { performSftpTransfer, sftpCall } from '../src/main/sftp-transfer';
import type { TransferInfo, TransferRequest } from '../src/shared/types';

const readyFile = process.env.GOOESHELL_SFTP_TEST_READY;
test('real SSH/SFTP transfers with verified resume and no overwrite', { skip: readyFile ? false : 'Set GOOESHELL_SFTP_TEST_READY to a disposable loopback fixture readiness file', timeout: 90_000 }, async t => {
  const values = Object.fromEntries((await fs.readFile(readyFile!, 'utf8')).trim().split(/\r?\n/).map(line => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]; }));
  assert.equal(values.fixture, 'gooeshell-sftp-v1');
  assert.equal(values.host, '127.0.0.1');
  assert.ok(path.basename(values.root).startsWith('gooeshell-sftp-test-'));
  assert.equal(await fs.readFile(path.join(values.root, 'fixture.token'), 'utf8'), values.token);
  const client = new Client();
  client.on('error', () => {});
  t.after(() => client.destroy());
  await new Promise<void>((resolve, reject) => {
    client.once('ready', resolve).once('error', reject).connect({ host: values.host, port: Number(values.port), username: values.username, password: values.password,
      hostVerifier: (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === values.fingerprint,
    });
  });
  const sftp = await sftpCall<SFTPWrapper>(cb => client.sftp(cb));
  const caseName = randomUUID();
  const local = path.join(values.root, 'local', caseName);
  const remote = path.join(values.root, 'remote', caseName);
  await fs.mkdir(local); await fs.mkdir(remote);
  const bytes = randomBytes(256 * 1024 + 321);
  const transfer = async (direction: 'upload' | 'download', name: string, options: { resume?: boolean; abortAt?: number } = {}) => {
    const request: TransferRequest = { sessionId: 'fixture', direction, source: direction === 'upload' ? path.join(local, name) : `/${caseName}/${name}`, destinationDir: direction === 'upload' ? `/${caseName}` : local, resume: options.resume ?? true };
    const info: TransferInfo = { id: randomUUID(), sessionId: 'fixture', direction, name, source: request.source, destination: request.destinationDir, state: 'queued', total: 0, done: 0 };
    const abort = new AbortController();
    await performSftpTransfer(sftp, request, info, abort.signal, () => { if (options.abortAt !== undefined && info.done >= options.abortAt) abort.abort(); }, 'fixture');
    return info;
  };
  await t.test('upload and download preserve exact contents', async () => {
    await fs.writeFile(path.join(local, 'upload.bin'), bytes);
    const uploaded = await transfer('upload', 'upload.bin');
    assert.equal(uploaded.done, bytes.length);
    assert.deepEqual(await fs.readFile(path.join(remote, 'upload.bin')), bytes);
    await fs.writeFile(path.join(remote, 'download.bin'), bytes);
    await transfer('download', 'download.bin');
    assert.deepEqual(await fs.readFile(path.join(local, 'download.bin')), bytes);
  });
  await t.test('both directions resume only after comparing every prefix byte', async () => {
    await fs.writeFile(path.join(local, 'resume-up.bin'), bytes);
    await fs.writeFile(path.join(remote, 'resume-up.bin.gooeshell.part'), bytes.subarray(0, 70_031));
    await transfer('upload', 'resume-up.bin');
    assert.deepEqual(await fs.readFile(path.join(remote, 'resume-up.bin')), bytes);
    await fs.writeFile(path.join(remote, 'resume-down.bin'), bytes);
    await fs.writeFile(path.join(local, 'resume-down.bin.gooeshell.part'), bytes.subarray(0, 131_123));
    await transfer('download', 'resume-down.bin');
    assert.deepEqual(await fs.readFile(path.join(local, 'resume-down.bin')), bytes);
  });
  await t.test('mismatch preserves partial contents and never publishes', async () => {
    for (const direction of ['upload', 'download'] as const) {
      const name = `mismatch-${direction}.bin`;
      const sourceRoot = direction === 'upload' ? local : remote;
      const targetRoot = direction === 'upload' ? remote : local;
      await fs.writeFile(path.join(sourceRoot, name), bytes);
      const wrong = Buffer.from(bytes.subarray(0, 80_000)); wrong[70_321] ^= 0xff;
      await fs.writeFile(path.join(targetRoot, `${name}.gooeshell.part`), wrong);
      await assert.rejects(transfer(direction, name), /不一致/);
      assert.deepEqual(await fs.readFile(path.join(targetRoot, `${name}.gooeshell.part`)), wrong);
      await assert.rejects(fs.stat(path.join(targetRoot, name)), { code: 'ENOENT' });
    }
  });
  await t.test('existing destination survives and resume=false preserves part', async () => {
    for (const direction of ['upload', 'download'] as const) {
      const name = `existing-${direction}.bin`;
      const sourceRoot = direction === 'upload' ? local : remote;
      const targetRoot = direction === 'upload' ? remote : local;
      await fs.writeFile(path.join(sourceRoot, name), bytes);
      await fs.writeFile(path.join(targetRoot, name), 'keep me');
      await assert.rejects(transfer(direction, name), /已存在/);
      assert.equal(await fs.readFile(path.join(targetRoot, name), 'utf8'), 'keep me');
      const partialName = `noresume-${direction}.bin`;
      await fs.writeFile(path.join(sourceRoot, partialName), bytes);
      await fs.writeFile(path.join(targetRoot, `${partialName}.gooeshell.part`), bytes.subarray(0, 87));
      await assert.rejects(transfer(direction, partialName, { resume: false }), /校验后续传/);
      assert.deepEqual(await fs.readFile(path.join(targetRoot, `${partialName}.gooeshell.part`)), bytes.subarray(0, 87));
    }
  });
  await t.test('cancelled upload retains a reusable partial', async () => {
    await fs.writeFile(path.join(local, 'cancel.bin'), bytes);
    await assert.rejects(transfer('upload', 'cancel.bin', { abortAt: 64 * 1024 }), /已取消/);
    await assert.rejects(fs.stat(path.join(remote, 'cancel.bin')), { code: 'ENOENT' });
    assert.ok((await fs.stat(path.join(remote, 'cancel.bin.gooeshell.part'))).size >= 64 * 1024);
    await transfer('upload', 'cancel.bin');
    assert.deepEqual(await fs.readFile(path.join(remote, 'cancel.bin')), bytes);
  });
  await t.test('recursive directories include empty folders and Unicode names', async () => {
    await fs.mkdir(path.join(local, '树', 'empty'), { recursive: true });
    await fs.writeFile(path.join(local, '树', '空 格.txt'), '你好，gooeshell');
    await transfer('upload', '树');
    assert.equal(await fs.readFile(path.join(remote, '树', '空 格.txt'), 'utf8'), '你好，gooeshell');
    assert.ok((await fs.stat(path.join(remote, '树', 'empty'))).isDirectory());
  });
  await t.test('connection loss during cancellation settles instead of hanging cleanup', { timeout: 5_000 }, async () => {
    const source = path.join(local, 'disconnect.bin');
    await fs.writeFile(source, bytes);
    const request: TransferRequest = { sessionId: 'fixture', direction: 'upload', source, destinationDir: `/${caseName}`, resume: true };
    const info: TransferInfo = { id: randomUUID(), sessionId: 'fixture', direction: 'upload', name: 'disconnect.bin', source, destination: request.destinationDir, state: 'queued', total: 0, done: 0 };
    const abort = new AbortController();
    await assert.rejects(performSftpTransfer(sftp, request, info, abort.signal, () => {
      if (info.done >= 64 * 1024) { abort.abort(); client.destroy(); }
    }, 'fixture'));
    assert.ok((await fs.stat(path.join(remote, 'disconnect.bin.gooeshell.part'))).size > 0);
    await assert.rejects(fs.stat(path.join(remote, 'disconnect.bin')), { code: 'ENOENT' });
  });
});
