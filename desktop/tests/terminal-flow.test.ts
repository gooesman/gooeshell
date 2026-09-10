import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server, type ServerChannel } from 'ssh2';
import { SshService } from '../src/main/ssh-service';
import type { AppEvent } from '../src/shared/types';

test('terminal preserves raw bytes, resumes after output ACK and deduplicates resize', { timeout: 15_000 }, async t => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gooeshell-flow-test-'));
  const connections = new Set<any>();
  let channel: ServerChannel | undefined;
  const windowChanges: { cols: number; rows: number }[] = [];
  const incoming: Buffer[] = [];
  const raw = Buffer.from([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68, 0x80, 0xff, 0xe4, 0xbd, 0xa0, 0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c]);
  const server = new Server({ hostKeys: [key] }, client => {
    connections.add(client); client.on('error', () => {}); client.on('close', () => connections.delete(client));
    client.on('authentication', context => context.method === 'password' && context.username === 'test' && context.password === 'fixture-only' ? context.accept() : context.reject(['password']));
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', accept => accept?.());
      session.on('window-change', (accept, _reject, info) => { windowChanges.push({ cols: info.cols, rows: info.rows }); accept?.(); });
      session.on('shell', accept => {
        channel = accept(); channel.on('data', data => incoming.push(Buffer.from(data)));
        channel.write(raw.subarray(0, 11)); channel.write(raw.subarray(11));
      });
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const events: Extract<AppEvent, { type: 'terminal' }>[] = [];
  let automaticAck = false;
  const service = new SshService(event => {
    if (event.type === 'hostKey') service.confirmHostKey(event.requestId, 'once');
    if (event.type === 'terminal') {
      events.push(event);
      assert.equal(Buffer.from(event.data, 'base64').length, event.bytes);
      if (automaticAck) queueMicrotask(() => service.terminalAck(event.sessionId, event.bytes));
    }
  }, path.join(directory, 'known.json'));
  t.after(async () => {
    service.shutdown(); for (const connection of connections) connection.end();
    await new Promise<void>(resolve => server.close(() => resolve())); await fs.rmdir(directory);
  });
  const session = await service.connect({ profile: { id: 'fixture', name: 'fixture', host: '127.0.0.1', port: (server.address() as { port: number }).port, username: 'test', auth: 'password', rememberHost: false, encoding: 'utf8' }, password: 'fixture-only' });
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for terminal transport'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  assert.equal(events.length, 0);
  service.terminalResize(session.id, 100, 30);
  const output = () => Buffer.concat(events.map(event => Buffer.from(event.data, 'base64')));
  await until(() => output().length === raw.length);
  assert.deepEqual(output(), raw, 'UTF-8 terminal transport must not replace raw bytes');
  service.terminalAck(session.id, raw.length);
  const report = '\x1b[M\x20\x80\xff';
  service.terminalBinaryInput(session.id, report);
  await until(() => Buffer.concat(incoming).length === report.length);
  assert.deepEqual(Buffer.concat(incoming), Buffer.from(report, 'latin1'));
  service.terminalResize(session.id, 137, 41); service.terminalResize(session.id, 137, 41); service.terminalResize(session.id, 137, 41);
  await until(() => windowChanges.length === 1);
  assert.deepEqual(windowChanges, [{ cols: 137, rows: 41 }]);
  const bulk = randomBytes(1024 * 1024);
  channel!.write(bulk);
  await until(() => output().length - raw.length >= 512 * 1024);
  await new Promise(resolve => setTimeout(resolve, 100));
  const pausedAt = output().length - raw.length;
  assert.ok(pausedAt < bulk.length, 'output must pause until renderer acknowledges');
  automaticAck = true;
  service.terminalAck(session.id, pausedAt);
  await until(() => output().length === raw.length + bulk.length);
  assert.deepEqual(output().subarray(raw.length), bulk, 'ACK must resume every buffered byte without a stalled stream');
});
