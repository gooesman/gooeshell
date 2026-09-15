import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Header, Pax, type HeaderData } from 'tar';
import { extractLocalArchive, packLocalArchive } from '../src/main/local-archive';

const signal = () => new AbortController().signal;
type FixtureEntry = HeaderData & { contents?: Buffer | string };

function archiveBytes(entries: FixtureEntry[], end = true): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? '');
    const header = new Header({ mode: 0o755, uid: 0, gid: 0, type: 'File', ...entry, size: entry.size ?? contents.length });
    if (header.encode()) parts.push(new Pax({ path: entry.path, size: header.size }).encode());
    parts.push(header.block!, contents);
    if (contents.length % 512) parts.push(Buffer.alloc(512 - contents.length % 512));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

test('local packed transfers validate and publish archives safely', { timeout: 30_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gooeshell-local-archive-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('gooeshell-local-archive-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  let id = 0;
  const workspace = async () => {
    const base = path.join(root, String(id++));
    const source = path.join(base, 'source');
    const destination = path.join(base, 'destination');
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(destination);
    return { base, source, destination, archive: path.join(base, 'payload.tar.gz') };
  };
  const assertClean = async (destination: string) => assert.deepEqual((await fs.readdir(destination)).filter(name => name.startsWith('.gooeshell-unpack-')), []);

  await t.test('streams Unicode files, long paths, empty directories and empty files', async () => {
    const { source, destination, archive } = await workspace();
    const longName = '长'.repeat(55);
    const selected = path.join(source, '资料 空格');
    await fs.mkdir(path.join(selected, longName, 'empty'), { recursive: true });
    const contents = randomBytes(3 * 64 * 1024 + 71);
    await fs.writeFile(path.join(selected, longName, '内容.bin'), contents);
    await fs.writeFile(path.join(selected, '空文件.txt'), '');
    const updates: number[] = [];
    const packed = await packLocalArchive(selected, archive, signal(), done => updates.push(done));
    assert.deepEqual(packed, { name: '资料 空格', originalBytes: contents.length, entries: 5 });
    assert.equal(updates[0], 0);
    assert.equal(updates.at(-1), contents.length);
    const extracted = await extractLocalArchive(archive, destination, packed.name, signal(), undefined, packed.originalBytes);
    assert.deepEqual(extracted, packed);
    assert.deepEqual(await fs.readFile(path.join(destination, packed.name, longName, '内容.bin')), contents);
    assert.ok((await fs.stat(path.join(destination, packed.name, longName, 'empty'))).isDirectory());
    assert.equal((await fs.stat(path.join(destination, packed.name, '空文件.txt'))).size, 0);
    await assertClean(destination);
  });

  await t.test('single files publish without overwriting and strip special permission bits', async () => {
    const { source, destination, archive } = await workspace();
    const file = path.join(source, 'script.sh');
    await fs.writeFile(file, '#!/bin/sh\necho hello\n');
    if (process.platform !== 'win32') await fs.chmod(file, 0o4751);
    const packed = await packLocalArchive(file, archive, signal());
    await extractLocalArchive(archive, destination, packed.name, signal());
    assert.equal(await fs.readFile(path.join(destination, packed.name), 'utf8'), '#!/bin/sh\necho hello\n');
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(destination, packed.name))).mode & 0o7777, 0o751);
    await assert.rejects(extractLocalArchive(archive, destination, packed.name, signal()), /已存在/);
  });

  await t.test('staging cleanup preserves the published file read-only mode', async () => {
    const { destination, archive } = await workspace();
    await fs.writeFile(archive, archiveBytes([{ path: 'root', mode: 0o444, contents: 'read only' }]));
    await extractLocalArchive(archive, destination, 'root', signal());
    assert.equal((await fs.stat(path.join(destination, 'root'))).mode & 0o200, 0);
    await assertClean(destination);
  });

  await t.test('publishes on filesystems without hard-link support using exclusive streaming copies', async t => {
    const { destination, archive } = await workspace();
    const contents = randomBytes(128 * 1024);
    await fs.writeFile(archive, archiveBytes([{ path: 'root', contents }]));
    t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('Unsupported hard links'), { code: 'ENOTSUP' }); });
    await extractLocalArchive(archive, destination, 'root', signal());
    assert.deepEqual(await fs.readFile(path.join(destination, 'root')), contents);
    await assertClean(destination);
  });

  await t.test('existing archive and selected source contents remain untouched', async () => {
    const { source, archive } = await workspace();
    await fs.writeFile(path.join(source, 'keep'), 'source');
    await fs.writeFile(archive, 'existing archive');
    await assert.rejects(packLocalArchive(source, archive, signal()), { code: 'EEXIST' });
    assert.equal(await fs.readFile(archive, 'utf8'), 'existing archive');
    await assert.rejects(packLocalArchive(source, path.join(source, 'inside.tar.gz'), signal()), /不能放在/);
    assert.equal(await fs.readFile(path.join(source, 'keep'), 'utf8'), 'source');
  });

  await t.test('rejects an existing empty root and a target created during extraction', async () => {
    const { source, destination, archive } = await workspace();
    await fs.writeFile(path.join(source, 'payload'), randomBytes(128 * 1024));
    await packLocalArchive(source, archive, signal());
    const target = path.join(destination, 'source');
    await fs.mkdir(target);
    const original = await fs.stat(target);
    await assert.rejects(extractLocalArchive(archive, destination, 'source', signal()), /已存在/);
    assert.equal((await fs.stat(target)).ino, original.ino);
    await fs.rmdir(target);
    let created = false;
    await assert.rejects(extractLocalArchive(archive, destination, 'source', signal(), () => {
      if (!created) { created = true; mkdirSync(target); writeFileSync(path.join(target, 'user.txt'), 'keep me'); }
    }), /已存在/);
    assert.equal(await fs.readFile(path.join(target, 'user.txt'), 'utf8'), 'keep me');
    assert.deepEqual(await fs.readdir(target), ['user.txt']);
    await assertClean(destination);
  });

  await t.test('cancelling compression stops writing and removes only its temporary archive', async () => {
    const { source, archive } = await workspace();
    const contents = randomBytes(512 * 1024);
    await fs.writeFile(path.join(source, 'payload'), contents);
    const controller = new AbortController();
    await assert.rejects(packLocalArchive(source, archive, controller.signal, done => {
      if (done >= 64 * 1024) controller.abort();
    }), /已取消/);
    await assert.rejects(fs.stat(archive), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(path.join(source, 'payload')), contents);
  });

  await t.test('cancelling extraction removes staging and leaves no published root', async () => {
    const { source, destination, archive } = await workspace();
    await fs.writeFile(path.join(source, 'payload'), randomBytes(512 * 1024));
    await packLocalArchive(source, archive, signal());
    const controller = new AbortController();
    await assert.rejects(extractLocalArchive(archive, destination, 'source', controller.signal, done => {
      if (done >= 64 * 1024) controller.abort();
    }), /已取消/);
    assert.deepEqual(await fs.readdir(destination), []);
    assert.ok((await fs.stat(archive)).isFile());
  });

  await t.test('rejects source mutation while streaming', async () => {
    const { source, archive } = await workspace();
    const file = path.join(source, 'payload');
    await fs.writeFile(file, randomBytes(256 * 1024));
    let changed = false;
    await assert.rejects(packLocalArchive(source, archive, signal(), done => {
      if (done && !changed) { changed = true; writeFileSync(file, 'changed source'); }
    }), /发生变化/);
    await assert.rejects(fs.stat(archive), { code: 'ENOENT' });
    assert.equal(await fs.readFile(file, 'utf8'), 'changed source');
  });

  await t.test('rejects source directory links instead of following them', async () => {
    const { source, archive, base } = await workspace();
    const other = path.join(base, 'other');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'keep'), 'outside');
    await fs.symlink(other, path.join(source, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(packLocalArchive(source, archive, signal()), /符号链接/);
    assert.equal(await fs.readFile(path.join(other, 'keep'), 'utf8'), 'outside');
  });

  const invalid: [string, FixtureEntry[]][] = [
    ['traversal', [{ path: 'root/../escape', contents: 'bad' }]],
    ['absolute', [{ path: '/escape', contents: 'bad' }]],
    ['drive', [{ path: 'C:/escape', contents: 'bad' }]],
    ['backslash', [{ path: 'root/..\\escape', contents: 'bad' }]],
    ['empty component', [{ path: 'root//escape', contents: 'bad' }]],
    ['dot component', [{ path: 'root/./escape', contents: 'bad' }]],
    ['another root', [{ path: 'another/file', contents: 'bad' }]],
    ['duplicate', [{ path: 'root/same', contents: 'one' }, { path: 'root/same', contents: 'two' }]],
    ['symlink', [{ path: 'root/link', type: 'SymbolicLink', linkpath: '../escape' }]],
    ['hardlink', [{ path: 'root/link', type: 'Link', linkpath: 'root/file' }]],
    ['device', [{ path: 'root/device', type: 'CharacterDevice' }]],
    ['fifo', [{ path: 'root/fifo', type: 'FIFO' }]],
    ['missing parent', [{ path: 'root/missing/file', contents: 'bad' }]],
    ['file as parent', [{ path: 'root/file', contents: 'one' }, { path: 'root/file/child', contents: 'two' }]],
    ['too deep', [{ path: `root/${'d/'.repeat(64)}file`, contents: 'bad' }]],
    ['malformed PAX path', [{ path: 'PaxHeader/bad', type: 'ExtendedHeader', contents: '999 path=root/wrong\n' }, { path: 'root/file', contents: 'bad' }]],
    ['sparse PAX file', [{ path: 'PaxHeader/sparse', type: 'ExtendedHeader', contents: '26 GNU.sparse.realsize=99\n' }, { path: 'root/file', contents: 'bad' }]],
  ];
  if (process.platform === 'win32') invalid.push(
    ['case alias', [{ path: 'root/Name', contents: 'one' }, { path: 'root/name', contents: 'two' }]],
    ['reserved name', [{ path: 'root/CON.txt', contents: 'bad' }]],
    ['reserved superscript', [{ path: 'root/COM¹.txt', contents: 'bad' }]],
    ['alternate stream', [{ path: 'root/file:stream', contents: 'bad' }]],
    ['trailing period', [{ path: 'root/file.', contents: 'bad' }]],
  );
  for (const [name, contents] of invalid) await t.test(`rejects ${name} before publishing`, async () => {
    const { destination, archive } = await workspace();
    await fs.writeFile(archive, archiveBytes([{ path: 'root/', type: 'Directory' }, ...contents]));
    await assert.rejects(extractLocalArchive(archive, destination, 'root', signal()));
    assert.deepEqual(await fs.readdir(destination), []);
  });

  await t.test('verifies gzip checksum, truncation, tar checksum and end markers before publishing', async () => {
    const validEntries: FixtureEntry[] = [{ path: 'root/', type: 'Directory' }, { path: 'root/file', contents: 'contents' }];
    const valid = archiveBytes(validEntries);
    const corrupt = Buffer.from(valid);
    corrupt[corrupt.length - 8] ^= 0xff;
    const brokenHeader = new Header({ path: 'root/', type: 'Directory', size: 0 });
    brokenHeader.encode();
    brokenHeader.block![0] ^= 1;
    for (const data of [corrupt, valid.subarray(0, valid.length - 4), archiveBytes(validEntries, false), gzipSync(brokenHeader.block!)]) {
      const { destination, archive } = await workspace();
      await fs.writeFile(archive, data);
      await assert.rejects(extractLocalArchive(archive, destination, 'root', signal()));
      assert.deepEqual(await fs.readdir(destination), []);
    }
  });

  await t.test('enforces the declared uncompressed total', async () => {
    const { destination, archive } = await workspace();
    await fs.writeFile(archive, archiveBytes([{ path: 'root', contents: '12345' }]));
    for (const expected of [4, 6]) {
      await assert.rejects(extractLocalArchive(archive, destination, 'root', signal(), undefined, expected), /预期大小/);
      assert.deepEqual(await fs.readdir(destination), []);
    }
  });
});
