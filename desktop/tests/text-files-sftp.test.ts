import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client, type SFTPWrapper } from 'ssh2';
import { sftpCall, trackSftp } from '../src/main/sftp-transfer';
import { SshService } from '../src/main/ssh-service';
import { encodeEditableText, MAX_EDITABLE_TEXT } from '../src/main/text-files';
import type { HostProfile } from '../src/shared/types';

const readyFile = process.env.GOOESHELL_SFTP_TEST_READY;
test('editor reads and atomically saves encoded files over real SSH/SFTP with baseline conflicts', {
  skip: readyFile ? false : 'Set GOOESHELL_SFTP_TEST_READY to the disposable loopback fixture', timeout: 60_000,
}, async t => {
  const values = Object.fromEntries((await fs.readFile(readyFile!, 'utf8')).trim().split(/\r?\n/).map(line => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
  }));
  assert.equal(values.fixture, 'gooeshell-sftp-v1');
  assert.equal(values.host, '127.0.0.1');
  assert.ok(path.basename(values.root).startsWith('gooeshell-sftp-test-'));
  assert.equal(await fs.readFile(path.join(values.root, 'fixture.token'), 'utf8'), values.token);
  const client = new Client();
  client.on('error', error => t.diagnostic(`Fixture SSH error: ${error.message}`));
  t.after(() => client.destroy());
  await new Promise<void>((resolve, reject) => {
    client.once('ready', resolve).once('error', reject).connect({ host: values.host, port: Number(values.port), username: values.username, password: values.password,
      hostVerifier: (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === values.fingerprint,
    });
  });
  const sftp = await sftpCall<SFTPWrapper>(cb => client.sftp(cb));
  trackSftp(sftp);
  const service = new SshService(() => {}, path.join(values.root, 'unused-editor-known-hosts.json'));
  const profile: HostProfile = { id: 'editor-fixture', name: 'Disposable fixture', host: values.host, port: Number(values.port), username: values.username, auth: 'password', rememberHost: false, encoding: 'utf8' };
  // The fixture exposes SFTP only. Supply its already-authenticated control channel
  // so all production editor reads, writes, metadata and rename calls run unchanged.
  const adapter = service as unknown as { sessions: Map<string, unknown>; control: () => Promise<{ client: Client; sftp: SFTPWrapper }> };
  adapter.sessions.set('editor-fixture', { id: 'editor-fixture', profile, fingerprint: values.fingerprint, closed: false });
  adapter.control = async () => ({ client, sftp });
  const caseName = randomUUID();
  const local = path.join(values.root, 'remote', caseName);
  await fs.mkdir(local);
  const remotePath = `/${caseName}/配置.txt`;
  const diskPath = path.join(local, '配置.txt');
  const request = { sessionId: 'editor-fixture', path: remotePath };
  const original = encodeEditableText('原始\r\nline\n', 'utf16le');
  await fs.writeFile(diskPath, original);
  const initial = await service.readTextFile(request);
  assert.equal(initial.text, '原始\r\nline\n');
  assert.equal(initial.encoding, 'utf16le');
  assert.equal(initial.lineEnding, 'mixed');
  const saved = await service.writeTextFile({ ...request, ...initial, text: '修改\r\nline\n', expectedRevision: initial.revision });
  assert.deepEqual(await fs.readFile(diskPath), encodeEditableText('修改\r\nline\n', 'utf16le'));
  assert.equal((await service.readTextFile(request)).revision, saved.revision);
  const baseline = await service.readTextFile(request);
  const info = await fs.stat(diskPath);
  await fs.writeFile(diskPath, encodeEditableText('别人\r\nline\n', 'utf16le'));
  await fs.utimes(diskPath, info.atime, info.mtime);
  await assert.rejects(service.writeTextFile({ ...request, ...baseline, text: 'stale edit', expectedRevision: baseline.revision }), /TEXT_CONFLICT/);
  assert.equal((await service.readTextFile(request)).text, '别人\r\nline\n');
  const updated = await service.readTextFile(request);
  const concurrent = await Promise.allSettled(['first', 'second'].map(text => service.writeTextFile({ ...request, ...updated, text, expectedRevision: updated.revision })));
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.match((concurrent.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.message, /TEXT_CONFLICT/);
  const newPath = `/${caseName}/new.txt`;
  await service.writeTextFile({ sessionId: 'editor-fixture', path: newPath, text: '新文件', encoding: 'gb18030', expectedRevision: 'missing' });
  assert.equal((await service.readTextFile({ sessionId: 'editor-fixture', path: newPath, encoding: 'gb18030' })).text, '新文件');
  await assert.rejects(service.writeTextFile({ sessionId: 'editor-fixture', path: newPath, text: 'overwrite', encoding: 'utf8', expectedRevision: 'missing' }), /TEXT_CONFLICT/);
  await fs.writeFile(diskPath, Buffer.from('x'.repeat(MAX_EDITABLE_TEXT - 1) + '你suffix'));
  const preview = await service.readTextFile(request);
  assert.equal(preview.truncated, true);
  assert.equal(preview.text, 'x'.repeat(MAX_EDITABLE_TEXT - 1));
  await assert.rejects(service.writeTextFile({ ...request, ...preview, expectedRevision: preview.revision }), /预览不能保存/);
  assert.deepEqual((await fs.readdir(local)).filter(name => name.startsWith('.gooeshell-edit-')), []);
});
