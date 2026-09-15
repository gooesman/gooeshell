import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Client } from 'ssh2';
import {
  REMOTE_ARCHIVE_PYTHON, cleanupRemoteArchive, extractRemoteArchive, packRemoteArchive, prepareRemoteArchive,
  type RemoteArchiveContext,
} from '../src/main/remote-archive';
import { extractLocalArchive, packLocalArchive } from '../src/main/local-archive';

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter();
  ended: string[] = [];
  closed = false;
  sentSignals: string[] = [];
  end(value: string) { this.ended.push(value); }
  close() { this.closed = true; }
  signal(value: string) { this.sentSignals.push(value); }
}

function connection() {
  const channel = new FakeChannel();
  let command = '';
  let connected!: () => void;
  const ready = new Promise<void>(resolve => { connected = resolve; });
  const client = Object.assign(new EventEmitter(), { exec(input: string, options: unknown, callback: (error: null, channel: FakeChannel) => void) {
    command = input;
    assert.deepEqual(options, { pty: false });
    queueMicrotask(() => { callback(null, channel); connected(); });
  } }) as unknown as Client;
  return {
    channel, client, ready,
    get command() { return command; },
    get frame() { return command.match(/(GOOESHELL_ARCHIVE_[0-9a-f]+)$/)![1]; },
    start() { channel.emit('data', Buffer.from(`${this.frame}:READY\n`)); },
    send(kind: string, value: unknown) {
      const line = `${this.frame}:${kind}:${Buffer.from(JSON.stringify(value)).toString('base64')}\n`;
      channel.emit('data', Buffer.from(line.slice(0, 43)));
      channel.emit('data', Buffer.from(line.slice(43)));
    },
  };
}

const token = 'a'.repeat(64);
const context: RemoteArchiveContext = { directory: '/tmp', workDir: `/tmp/.gooeshell-archive-${token}`, archivePath: `/tmp/.gooeshell-archive-${token}/payload.tar.gz`, token };

test('remote archive paths remain in stdin JSON and long jobs stream bounded progress frames', async () => {
  const server = connection();
  const source = "/tmp/中文 ' $(touch NO_SHELL)";
  const updates: number[] = [];
  const operation = packRemoteArchive(server.client, { source, context }, update => updates.push(update.done));
  await server.ready;
  assert.ok(!server.command.includes(source));
  assert.equal(server.channel.ended.length, 0);
  server.channel.emit('data', Buffer.from('Server banner\n'));
  server.start();
  assert.deepEqual(JSON.parse(server.channel.ended[0]), { op: 'pack', payload: { source, context } });
  for (let done = 0; done < 1500; done++) server.send('PROGRESS', { done, total: 2000, entries: 2 });
  server.send('RESULT', { ok: true, value: { name: 'root', total: 2000, entries: 2, archiveSize: 99 } });
  assert.equal((await operation).archiveSize, 99);
  assert.equal(updates.length, 1500);
});

test('archive cancellation waits for helper exit before allowing staging cleanup', async () => {
  const server = connection(), abort = new AbortController();
  let complete = false;
  const operation = packRemoteArchive(server.client, { source: '/tmp/a', context }, undefined, abort.signal);
  const rejected = assert.rejects(operation, { name: 'AbortError' }).then(() => { complete = true; });
  await server.ready;
  server.start();
  abort.abort();
  await Promise.resolve();
  assert.deepEqual(server.channel.sentSignals, ['TERM']);
  assert.equal(complete, false);
  assert.equal(server.channel.closed, false);
  server.channel.emit('close', 1);
  await rejected;
});

test('prepare delivers ownership context after mid-flight cancellation so caller can clean it', async () => {
  const server = connection(), abort = new AbortController();
  const operation = prepareRemoteArchive(server.client, {}, abort.signal);
  await server.ready;
  server.start();
  const request = JSON.parse(server.channel.ended[0]);
  assert.equal(request.payload.directory, undefined);
  assert.match(request.payload.token, /^[a-f0-9]{64}$/);
  abort.abort();
  const created = { directory: '/tmp', token: request.payload.token, workDir: `/tmp/.gooeshell-archive-${request.payload.token}`, archivePath: `/tmp/.gooeshell-archive-${request.payload.token}/payload.tar.gz` };
  server.send('RESULT', { ok: true, value: created });
  assert.deepEqual(await operation, created);
  assert.deepEqual(server.channel.sentSignals, []);
});

test('unsafe requests are rejected before exec and missing Python has a clear diagnostic', async () => {
  const server = connection();
  assert.throws(() => prepareRemoteArchive(server.client, { name: '..' }), /文件名/);
  assert.throws(() => extractRemoteArchive(server.client, { context, expectedName: 'a', total: -1 }), /大小/);
  await assert.rejects(cleanupRemoteArchive(server.client, { ...context, token: 'invalid' }), /凭据/);
  assert.equal(server.command, '');
  const operation = prepareRemoteArchive(server.client);
  const rejected = assert.rejects(operation, /Python 3/);
  await server.ready;
  server.channel.stderr.emit('data', Buffer.from('python3: command not found'));
  server.channel.emit('close', 127);
  await rejected;
});

test('prepare has a bounded deadline after READY even when cancellation is deferred', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = connection(), abort = new AbortController();
  const operation = prepareRemoteArchive(server.client, {}, abort.signal);
  const rejected = assert.rejects(operation, /准备超时/);
  await server.ready;
  server.start();
  abort.abort();
  t.mock.timers.tick(15_000);
  assert.deepEqual(server.channel.sentSignals, ['TERM']);
  server.channel.emit('close', 1);
  await rejected;
});

test('transport loss rejects a helper even if its channel never emits close', async () => {
  const server = connection();
  const operation = packRemoteArchive(server.client, { source: '/tmp/a', context });
  const rejected = assert.rejects(operation, /SSH 连接已断开/);
  await server.ready;
  server.start();
  server.client.emit('close');
  await rejected;
});

const wslDistribution = process.env.GOOESHELL_TEST_WSL;
const supportsLinux = process.platform === 'linux' || !!wslDistribution;
function python(program: string, args: string[] = [], input = ''): string {
  // WSL's Windows argument bridge interprets backslashes in -c source. Base64
  // carries the exact fixed program, including Python string escapes.
  program = `import base64; exec(base64.b64decode('${Buffer.from(program).toString('base64')}'))`;
  return execFileSync(wslDistribution ? 'wsl.exe' : 'python3', wslDistribution ? ['-d', wslDistribution, '--', 'python3', '-I', '-c', program, ...args] : ['-I', '-c', program, ...args], {
    input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30_000,
  });
}

test('real Linux archives round-trip Unicode, nested and empty folders, and reject unsafe contents', { skip: !supportsLinux, timeout: 120_000 }, async t => {
  const root = python('import tempfile; print(tempfile.mkdtemp(prefix="gooeshell-archive-test-"))').trim();
  assert.match(root, /^\/tmp\/gooeshell-archive-test-[A-Za-z0-9_-]+$/);
  function fixture(program: string, values: unknown[] = []) {
    return python('import os, pathlib, json, sys, io, tarfile, shutil; root=sys.argv[1]; values=json.loads(sys.stdin.read()); ' + program, [root], JSON.stringify(values));
  }
  function operation(op: string, payload: Record<string, unknown>, program = REMOTE_ARCHIVE_PYTHON): any {
    const output = python(program, ['TEST_ARCHIVE'], JSON.stringify({ op, payload }) + '\n');
    const result = output.split('\n').find(line => line.startsWith('TEST_ARCHIVE:RESULT:'));
    assert.ok(result, output);
    return JSON.parse(Buffer.from(result.slice('TEST_ARCHIVE:RESULT:'.length), 'base64').toString('utf8'));
  }
  function prepare(directory: string, name?: string): RemoteArchiveContext {
    const value = operation('prepare', { directory, ...(name ? { name } : {}), token: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '') });
    assert.equal(value.ok, true, value.error);
    return value.value;
  }
  function makeArchive(job: RemoteArchiveContext, members: Array<{ name: string; type?: string; value?: string }>) {
    fixture(`archive=tarfile.open(values[0], 'w:gz');\nfor item in values[1]:\n info=tarfile.TarInfo(item['name']); info.mode=0o755; data=item.get('value','contents').encode(); info.type={'directory':tarfile.DIRTYPE,'symlink':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'fifo':tarfile.FIFOTYPE}.get(item.get('type'),tarfile.REGTYPE); info.linkname='../outside/keep'; info.size=len(data) if info.isreg() else 0; archive.addfile(info,io.BytesIO(data) if info.isreg() else None)\narchive.close()`, [job.archivePath, members]);
  }
  try {
    fixture('os.mkdir(root+"/source"); os.mkdir(root+"/destination"); os.mkdir(root+"/outside"); pathlib.Path(root+"/outside/keep").write_text("untouched")');
    await t.test('pack and extract preserve data, modes, names and empty folders', () => {
      fixture('os.mkdir(root+"/source/树"); os.mkdir(root+"/source/树/空目录"); pathlib.Path(root+"/source/树/中文 空格.txt").write_text("你好世界",encoding="utf8"); pathlib.Path(root+"/source/树/empty").touch(); os.chmod(root+"/source/树/中文 空格.txt",0o640)');
      const job = prepare(root + '/destination', '树');
      const packed = operation('pack', { context: job, source: root + '/source/树' });
      assert.equal(packed.ok, true, packed.error);
      assert.deepEqual([packed.value.total, packed.value.entries], [12, 4]);
      const unpacked = operation('extract', { context: job, expectedName: '树', total: 12 });
      assert.equal(unpacked.ok, true, unpacked.error);
      assert.deepEqual(JSON.parse(fixture('print(json.dumps([pathlib.Path(root+"/destination/树/中文 空格.txt").read_text(),os.path.isdir(root+"/destination/树/空目录"),os.stat(root+"/destination/树/中文 空格.txt").st_mode&0o777]))')), ['你好世界', true, 0o640]);
      assert.equal(operation('cleanup', { context: job }).ok, true);
      assert.equal(operation('cleanup', { context: job }).ok, true);
    });
    await t.test('existing files, empty directories and late publication races are never overwritten', () => {
      assert.equal(operation('prepare', { directory: root + '/destination', name: '树', token }).ok, false);
      const job = prepare(root + '/destination', 'race');
      makeArchive(job, [{ name: 'race', type: 'directory' }, { name: 'race/new' }]);
      const raceProgram = REMOTE_ARCHIVE_PYTHON.replace('publish(stage, expected, parent)', "os.mkdir(expected, dir_fd=parent)\n        publish(stage, expected, parent)");
      const result = operation('extract', { context: job, expectedName: 'race', total: 8 }, raceProgram);
      assert.equal(result.ok, false);
      assert.match(result.error, /已存在/);
      assert.equal(fixture('print(os.listdir(root+"/destination/race"))').trim(), '[]');
      assert.equal(operation('cleanup', { context: job }).ok, true);
    });
    await t.test('source links, filesystem root, changed source, and archive nested in source are refused', () => {
      fixture('os.symlink(root+"/outside/keep",root+"/source/link")');
      const job = prepare(root + '/destination');
      for (const source of [root + '/source/link', '/', root]) {
        const result = operation('pack', { context: job, source });
        assert.equal(result.ok, false, source);
      }
      assert.equal(operation('cleanup', { context: job }).ok, true);
    });
    await t.test('path traversal, duplicate paths, symlinks, hardlinks and devices never publish', () => {
      const cases = [
        [{ name: '../outside/keep' }], [{ name: '/outside' }], [{ name: 'root/../outside' }],
        [{ name: 'root\\outside' }], [{ name: 'different' }], [{ name: 'root' }, { name: 'root' }],
        [{ name: 'root', type: 'symlink' }], [{ name: 'root', type: 'hardlink' }], [{ name: 'root', type: 'fifo' }],
      ];
      for (const members of cases) {
        const job = prepare(root + '/destination');
        makeArchive(job, members);
        assert.equal(operation('extract', { context: job, expectedName: 'root', total: 8 }).ok, false, JSON.stringify(members));
        assert.equal(fixture('print(os.path.lexists(root+"/destination/root"))').trim(), 'False');
        assert.equal(fixture('print(pathlib.Path(root+"/outside/keep").read_text())').trim(), 'untouched');
        assert.equal(operation('cleanup', { context: job }).ok, true);
      }
    });
    await t.test('gzip corruption and size mismatch keep final paths absent', () => {
      for (const corrupt of [true, false]) {
        const job = prepare(root + '/destination');
        makeArchive(job, [{ name: 'broken' }]);
        if (corrupt) fixture('p=pathlib.Path(values[0]); b=bytearray(p.read_bytes()); b[-8]^=0xff; p.write_bytes(b)', [job.archivePath]);
        assert.equal(operation('extract', { context: job, expectedName: 'broken', total: corrupt ? 8 : 9 }).ok, false);
        assert.equal(fixture('print(os.path.lexists(root+"/destination/broken"))').trim(), 'False');
        assert.equal(operation('cleanup', { context: job }).ok, true);
      }
    });
    await t.test('cleanup requires ownership and never follows descendant links', () => {
      const job = prepare(root + '/destination');
      fixture('os.symlink(root+"/outside",values[0]+"/link")', [job.workDir]);
      assert.equal(operation('cleanup', { context: { ...job, workDir: root + '/outside' } }).ok, false);
      fixture('pathlib.Path(values[0]+"/.owner").write_text("wrong")', [job.workDir]);
      assert.equal(operation('cleanup', { context: job }).ok, false);
      fixture('pathlib.Path(values[0]+"/.owner").write_text(values[1])', [job.workDir, job.token]);
      assert.equal(operation('cleanup', { context: job }).ok, true);
      assert.equal(fixture('print(pathlib.Path(root+"/outside/keep").read_text())').trim(), 'untouched');
    });
    await t.test('Python and Node archives interoperate with long Unicode paths in both directions', async () => {
      const local = await fs.mkdtemp(path.join(os.tmpdir(), 'gooeshell-remote-interop-'));
      const localIdentity = await fs.lstat(local);
      const name = '跨语言-' + 'root'.repeat(25), leaf = '子目录-' + 'a'.repeat(60);
      let job: RemoteArchiveContext | undefined;
      try {
        fixture('os.mkdir(root+"/source/"+values[0]); os.mkdir(root+"/source/"+values[0]+"/"+values[1]); pathlib.Path(root+"/source/"+values[0]+"/"+values[1]+"/中文.txt").write_text("互通",encoding="utf8")', [name, leaf]);
        job = prepare(root + '/destination');
        const packed = operation('pack', { context: job, source: root + '/source/' + name });
        assert.equal(packed.ok, true, packed.error);
        const pythonArchive = path.join(local, 'python.tar.gz');
        await fs.writeFile(pythonArchive, Buffer.from(fixture('import base64; print(base64.b64encode(pathlib.Path(values[0]).read_bytes()).decode())', [job.archivePath]).trim(), 'base64'));
        await extractLocalArchive(pythonArchive, local, name, new AbortController().signal, () => {}, 6);
        assert.equal(await fs.readFile(path.join(local, name, leaf, '中文.txt'), 'utf8'), '互通');
        assert.equal(operation('cleanup', { context: job }).ok, true);
        const nodeArchive = path.join(local, 'node.tar.gz');
        await packLocalArchive(path.join(local, name), nodeArchive, new AbortController().signal, () => {});
        job = prepare(root + '/destination', name);
        fixture('import base64; pathlib.Path(values[0]).write_bytes(base64.b64decode(values[1]))', [job.archivePath, (await fs.readFile(nodeArchive)).toString('base64')]);
        const extracted = operation('extract', { context: job, expectedName: name, total: 6 });
        assert.equal(extracted.ok, true, extracted.error);
        assert.equal(fixture('print(pathlib.Path(root+"/destination/"+values[0]+"/"+values[1]+"/中文.txt").read_text())', [name, leaf]).trim(), '互通');
      } finally {
        if (job) assert.equal(operation('cleanup', { context: job }).ok, true);
        const current = await fs.lstat(local);
        assert.equal(path.dirname(path.resolve(local)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(local).startsWith('gooeshell-remote-interop-'));
        assert.equal(current.dev, localIdentity.dev); assert.equal(current.ino, localIdentity.ino);
        assert.ok(current.isDirectory() && !current.isSymbolicLink());
        await fs.rm(local, { recursive: true, force: true });
      }
    });
    await t.test('real helper TERM cancellation unwinds packing and extraction before owned cleanup', () => {
      fixture('pathlib.Path(root+"/source/cancel.bin").write_bytes(b"a"*(8*1024*1024))');
      const job = prepare(root + '/destination', 'cancel.bin');
      function cancelOperation(op: string, program: string, payload: Record<string, unknown>) {
        const value = fixture(`import subprocess, signal; child=subprocess.Popen([sys.executable,'-I','-u','-c',values[0],'CANCEL_FRAME'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True); assert child.stdout.readline().strip()=='CANCEL_FRAME:READY'; child.stdin.write(json.dumps({'op':values[1],'payload':values[2]})+'\\n'); child.stdin.close(); lines=[]; sent=False\nfor line in child.stdout:\n lines.append(line)\n if ':PROGRESS:' in line and not sent:\n  import base64\n  progress=json.loads(base64.b64decode(line.split(':PROGRESS:')[1]))\n  if progress['done']>0:\n   child.send_signal(signal.SIGTERM); sent=True\nassert sent; child.wait(timeout=10); print(json.dumps(lines))`, [program, op, payload]);
        const lines = JSON.parse(value) as string[];
        const response = lines.find(line => line.startsWith('CANCEL_FRAME:RESULT:'))!;
        assert.ok(response);
        const result = JSON.parse(Buffer.from(response.split(':RESULT:')[1].trim(), 'base64').toString('utf8'));
        assert.equal(result.ok, false);
        assert.match(result.error, /已取消/);
      }
      try {
        cancelOperation('pack', REMOTE_ARCHIVE_PYTHON.replace('data = self.source.read(size)', 'time.sleep(0.01)\n        data = self.source.read(size)'), { context: job, source: root + '/source/cancel.bin' });
        assert.equal(fixture('print(os.path.exists(values[0]+"/payload.tar.gz.building") or os.path.exists(values[0]+"/payload.tar.gz"))', [job.workDir]).trim(), 'False');
        assert.equal(operation('pack', { context: job, source: root + '/source/cancel.bin' }).ok, true);
        cancelOperation('extract', REMOTE_ARCHIVE_PYTHON.replace('block = source.read(min(remaining, 1024 * 1024))', 'time.sleep(0.06)\n                                        block = source.read(min(remaining, 1024 * 1024))'), { context: job, expectedName: 'cancel.bin', total: 8 * 1024 * 1024 });
        assert.equal(fixture('print(os.path.lexists(root+"/destination/cancel.bin"))').trim(), 'False');
      } finally {
        assert.equal(operation('cleanup', { context: job }).ok, true);
      }
    });
  } finally {
    const cleanupProgram = REMOTE_ARCHIVE_PYTHON.split("print(FRAME + ':READY', flush=True)")[0] + '\nroot=os.path.realpath(sys.argv[1]); assert os.path.dirname(root)=="/tmp" and os.path.basename(root).startswith("gooeshell-archive-test-"); handle=open_directory(root)\ntry: remove_contents(handle)\nfinally: os.close(handle)\nos.rmdir(root)';
    python(cleanupProgram, [root]);
  }
});
