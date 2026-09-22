import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Client, type SFTPWrapper } from 'ssh2';
import { performSftpTransfer, sftpCall } from '../src/main/sftp-transfer';
import type { TransferInfo, TransferRequest } from '../src/shared/types';

const readyFile = process.env.GOOESHELL_SFTP_TEST_READY;
test('compare released serial downloads and bounded pipeline over a disposable real SSH/SFTP server', {
  timeout: 180_000,
  skip: readyFile && process.env.GOOESHELL_DOWNLOAD_BENCHMARK === '1' ? false : 'Opt-in disposable loopback download benchmark',
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
    hostVerifier: key => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === values.fingerprint,
  }));
  client.setNoDelay(true);
  const sftp = await sftpCall<SFTPWrapper>(cb => client.sftp(cb));
  const baselineRevision = 'd7af15a6c2d21c8b9bf6b2efd09c159e55111fc4'; // Released 0.4.1, before download pipelining.
  const source = execFileSync('git', ['show', `${baselineRevision}:desktop/src/main/sftp-transfer.ts`], { encoding: 'utf8', windowsHide: true });
  const output = path.resolve('test-output'); await fs.mkdir(output, { recursive: true });
  const baselineFile = path.join(output, `download-baseline-${randomUUID()}.ts`);
  await fs.writeFile(baselineFile, source.replaceAll("from './", "from '../src/main/").replace("from '../shared/types'", "from '../src/shared/types'"));
  t.after(() => fs.unlink(baselineFile));
  const baseline = (await import(pathToFileURL(baselineFile).href)).performSftpTransfer as typeof performSftpTransfer;
  const rootName = randomUUID(), remote = path.join(values.root, 'remote', rootName), local = path.join(values.root, 'local', rootName);
  await fs.mkdir(remote); await fs.mkdir(local);
  const data = randomBytes(8 * 1024 * 1024), digest = createHash('sha256').update(data).digest('hex');
  const rows: Array<Record<string, unknown>> = [];
  for (const delayMs of [0, 40]) {
    for (let iteration = 0; iteration < 3; iteration++) {
      // Alternate order to reduce warm-cache/order bias.
      const variants = iteration % 2 ? [['pipeline', performSftpTransfer], ['serial-0.4.1', baseline]] as const
        : [['serial-0.4.1', baseline], ['pipeline', performSftpTransfer]] as const;
      for (const [variant, implementation] of variants) {
        const name = `${variant}-${delayMs}-${iteration}.bin`;
        await fs.writeFile(path.join(remote, name), data);
        const request: TransferRequest = { sessionId: 'loopback-benchmark', direction: 'download', source: `/${rootName}/${name}`, destinationDir: local, resume: true };
        const info: TransferInfo = { ...request, id: randomUUID(), name, destination: local, state: 'queued', done: 0, total: 0 };
        let transferStart = 0, transferEnd = 0, active = 0, activePayload = 0, maxActivePayload = 0, readBytes = 0;
        const originalRead = sftp.read;
        sftp.read = (handle, buffer, offset, length, position, callback) => {
          const moving = info.state === 'transferring';
          active++;
          if (moving) { activePayload++; maxActivePayload = Math.max(maxActivePayload, activePayload); }
          originalRead.call(sftp, handle, buffer, offset, length, position, (error, bytesRead, data, position) => {
            const complete = () => { active--; if (moving) { activePayload--; if (!error) readBytes += bytesRead; } callback(error, bytesRead, data, position); };
            if (moving && delayMs) setTimeout(complete, delayMs); else complete();
          });
        };
        const stalls: number[] = []; let previous = performance.now();
        const heartbeat = setInterval(() => { const now = performance.now(); stalls.push(Math.max(0, now - previous - 10)); previous = now; }, 10);
        const totalStart = performance.now();
        try {
          await implementation(sftp, request, info, new AbortController().signal, () => {
            if (!transferStart && info.state === 'transferring') transferStart = performance.now();
            if (!transferEnd && transferStart && info.state === 'checking') transferEnd = performance.now();
          }, rootName);
        } finally { sftp.read = originalRead; clearInterval(heartbeat); }
        assert.equal(active, 0); assert.equal(activePayload, 0); assert.ok(maxActivePayload <= 16);
        assert.equal(maxActivePayload, variant === 'pipeline' ? 16 : 1);
        assert.equal(readBytes, data.length);
        assert.equal(createHash('sha256').update(await fs.readFile(path.join(local, name))).digest('hex'), digest);
        const transferMs = transferEnd - transferStart;
        stalls.sort((a, b) => a - b);
        rows.push({ delayMs, iteration: iteration + 1, variant, bytes: data.length, transferMs: Math.round(transferMs), totalMs: Math.round(performance.now() - totalStart),
          mebibytesPerSecond: Number((data.length / 1048576 / (transferMs / 1000)).toFixed(2)), maxOutstandingPayloadReads: maxActivePayload,
          eventLoopDelayP95Ms: Math.round(stalls[Math.floor(stalls.length * 0.95)] || 0), eventLoopDelayMaxMs: Math.round(stalls.at(-1) || 0) });
      }
    }
  }
  const report = { baselineRevision, scope: 'Real ssh2 + AsyncSSH over 127.0.0.1 with complete checksum verification. delayMs=40 additionally delays each download READ callback by 40 ms; this is controlled latency injection, NOT a real WAN benchmark. Event-loop delays are diagnostic, not a native terminal latency measurement.', results: rows };
  await fs.writeFile(path.join(output, 'sftp-download-benchmark.json'), JSON.stringify(report, null, 2) + '\n');
  t.diagnostic(JSON.stringify(report));
});

test('real pipelined download cancels and disconnects with only a verified resumable prefix', {
  timeout: 30_000, skip: readyFile ? false : 'Requires disposable loopback SFTP fixture',
}, async t => {
  const values = Object.fromEntries((await fs.readFile(readyFile!, 'utf8')).trim().split(/\r?\n/).map(line => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
  }));
  assert.equal(values.fixture, 'gooeshell-sftp-v1'); assert.equal(values.host, '127.0.0.1');
  assert.ok(path.basename(values.root).startsWith('gooeshell-sftp-test-'));
  assert.equal(await fs.readFile(path.join(values.root, 'fixture.token'), 'utf8'), values.token);
  const connect = async () => {
    const client = new Client(); client.on('error', () => {}); t.after(() => client.destroy());
    await new Promise<void>((resolve, reject) => client.once('ready', resolve).once('error', reject).connect({
      host: values.host, port: Number(values.port), username: values.username, password: values.password,
      hostVerifier: key => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === values.fingerprint,
    }));
    client.setNoDelay(true);
    return { client, sftp: await sftpCall<SFTPWrapper>(cb => client.sftp(cb)) };
  };
  const rootName = randomUUID(), remote = path.join(values.root, 'remote', rootName), local = path.join(values.root, 'local', rootName);
  await fs.mkdir(remote); await fs.mkdir(local);
  const bytes = randomBytes(4 * 1024 * 1024 + 17);
  for (const disconnect of [false, true]) {
    const name = `cancel-${disconnect}.bin`; await fs.writeFile(path.join(remote, name), bytes);
    const request: TransferRequest = { sessionId: 'cancel-loopback', direction: 'download', source: `/${rootName}/${name}`, destinationDir: local, resume: true };
    const info: TransferInfo = { ...request, id: randomUUID(), name, destination: local, state: 'queued', done: 0, total: 0 };
    const abort = new AbortController(), first = await connect();
    let cancelledAt = 0;
    await assert.rejects(performSftpTransfer(first.sftp, request, info, abort.signal, () => {
      if (!abort.signal.aborted && info.state === 'transferring' && info.done >= 64 * 1024) {
        cancelledAt = performance.now(); abort.abort(); if (disconnect) first.client.destroy();
      }
    }, rootName));
    assert.ok(cancelledAt > 0);
    const cancelMs = performance.now() - cancelledAt;
    assert.ok(cancelMs < 3000, `cancellation must settle promptly on loopback, took ${Math.round(cancelMs)} ms`);
    await assert.rejects(fs.stat(path.join(local, name)), { code: 'ENOENT' });
    const partial = await fs.readFile(path.join(local, name + '.gooeshell.part'));
    assert.equal(partial.length, 64 * 1024);
    assert.deepEqual(partial, bytes.subarray(0, partial.length));
    const second = await connect(); info.done = 0;
    await performSftpTransfer(second.sftp, request, info, new AbortController().signal, () => {}, rootName);
    assert.deepEqual(await fs.readFile(path.join(local, name)), bytes);
    t.diagnostic(`disconnect=${disconnect} cancelled in ${Math.round(cancelMs)} ms; retained ${partial.length} contiguous bytes and resumed successfully`);
  }
});
