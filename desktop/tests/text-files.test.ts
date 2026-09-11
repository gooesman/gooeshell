import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import iconv from 'iconv-lite';
import { readLocalTextFile, readLocalTextRevision, writeLocalTextFile } from '../src/main/local-files';
import { decodeEditableText, encodeEditableText, MAX_EDITABLE_TEXT } from '../src/main/text-files';
import type { EditorEncoding } from '../src/shared/types';

async function fixture(run: (file: string, directory: string) => Promise<void>) {
  const root = path.resolve('test-output');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'text-editor-'));
  try { await run(path.join(directory, '文档.txt'), directory); }
  finally {
    assert.ok(directory.startsWith(root + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('editor roundtrips all supported encodings, BOMs and mixed line endings byte for byte', async () => fixture(async file => {
  const text = '中文 hello\r\n第二行\nthird\rfourth';
  for (const encoding of ['utf8', 'utf8-bom', 'utf16le', 'utf16be', 'gb18030', 'big5'] as EditorEncoding[]) {
    for (const bom of encoding.startsWith('utf16') ? [false, true] : [undefined]) {
      const expected = encodeEditableText(text, encoding, bom);
      await fs.writeFile(file, expected);
      const read = await readLocalTextFile({ path: file, encoding: ['gb18030', 'big5'].includes(encoding) || bom === false ? encoding : undefined });
      assert.equal(read.text, text);
      assert.equal(read.encoding, encoding);
      assert.equal(read.lineEnding, 'mixed');
      assert.equal(read.truncated, false);
      const saved = await writeLocalTextFile({ path: file, ...read, expectedRevision: read.revision });
      assert.deepEqual(await fs.readFile(file), expected, `${encoding} BOM=${bom}`);
      const updated = await readLocalTextFile({ path: file, encoding });
      assert.equal(updated.revision, saved.revision);
      const savedAgain = await writeLocalTextFile({ path: file, ...updated, text: text + '追加', expectedRevision: saved.revision });
      assert.equal(savedAgain.size, encodeEditableText(text + '追加', encoding, updated.bom).length);
    }
  }
}));

test('undetected legacy files require an explicit encoding and cannot be saved with unsupported characters', async () => fixture(async file => {
  const original = iconv.encode('繁體中文', 'big5');
  await fs.writeFile(file, original);
  await assert.rejects(readLocalTextFile({ path: file }), /TEXT_ENCODING_REQUIRED/);
  const read = await readLocalTextFile({ path: file, encoding: 'big5' });
  assert.equal(read.text, '繁體中文');
  await assert.rejects(writeLocalTextFile({ path: file, ...read, text: read.text + '😀', expectedRevision: read.revision }), /TEXT_ENCODING_UNREPRESENTABLE/);
  assert.deepEqual(await fs.readFile(file), original);
  await assert.rejects(writeLocalTextFile({ path: file, ...read, text: '\ud800', expectedRevision: read.revision }), /不完整的 Unicode/);
  assert.deepEqual(await fs.readFile(file), original);
}));

test('open-time revisions detect same-size external changes even with restored mtime', async () => fixture(async file => {
  await fs.writeFile(file, 'original');
  const read = await readLocalTextFile({ path: file });
  const info = await fs.stat(file);
  await fs.writeFile(file, 'external');
  await fs.utimes(file, info.atime, info.mtime);
  await assert.rejects(writeLocalTextFile({ path: file, ...read, text: 'my edit', expectedRevision: read.revision }), /TEXT_CONFLICT/);
  assert.equal(await fs.readFile(file, 'utf8'), 'external');
  const latest = await readLocalTextFile({ path: file });
  await writeLocalTextFile({ path: file, ...latest, text: 'merged edit', expectedRevision: latest.revision });
  assert.equal(await fs.readFile(file, 'utf8'), 'merged edit');
  await fs.unlink(file);
  await assert.rejects(writeLocalTextFile({ path: file, ...latest, text: 'must not recreate', expectedRevision: latest.revision }), /TEXT_CONFLICT/);
}));

test('concurrent saves from one baseline cannot silently overwrite each other and leave no staging files', async () => fixture(async (file, directory) => {
  await fs.writeFile(file, 'baseline');
  const read = await readLocalTextFile({ path: file });
  const results = await Promise.allSettled(['first edit', 'second edit'].map(text => writeLocalTextFile({ path: file, ...read, text, expectedRevision: read.revision })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.match(rejected.reason.message, /TEXT_CONFLICT/);
  assert.equal(await fs.readFile(file, 'utf8'), 'first edit');
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.startsWith('.gooeshell-edit-')), []);
}));

test('large previews stop before incomplete characters and cannot overwrite the full file', async () => fixture(async file => {
  const original = Buffer.from('x'.repeat(MAX_EDITABLE_TEXT - 1) + '你后续内容');
  await fs.writeFile(file, original);
  const read = await readLocalTextFile({ path: file });
  assert.equal(read.truncated, true);
  assert.equal(read.text, 'x'.repeat(MAX_EDITABLE_TEXT - 1));
  assert.equal(read.size, original.length);
  await assert.rejects(writeLocalTextFile({ path: file, ...read, expectedRevision: read.revision }), /预览不能保存/);
  assert.deepEqual(await fs.readFile(file), original);
  const legacy = iconv.encode('x'.repeat(MAX_EDITABLE_TEXT - 1) + '你好', 'big5');
  const preview = decodeEditableText(legacy.subarray(0, MAX_EDITABLE_TEXT), { encoding: 'big5', truncated: true, size: legacy.length, revision: 'preview:fixture' });
  assert.equal(preview.text, 'x'.repeat(MAX_EDITABLE_TEXT - 1));
}));

test('new-file saves never overwrite an existing path and cannot edit a directory', async () => fixture(async (file, directory) => {
  const saved = await writeLocalTextFile({ path: file, text: 'created', encoding: 'utf8', expectedRevision: 'missing' });
  assert.equal((await readLocalTextFile({ path: file })).revision, saved.revision);
  await assert.rejects(writeLocalTextFile({ path: file, text: 'overwrite', encoding: 'utf8', expectedRevision: 'missing' }), /TEXT_CONFLICT/);
  await assert.rejects(readLocalTextFile({ path: directory }), /普通文件/);
  await assert.rejects(writeLocalTextFile({ path: directory, text: 'overwrite', encoding: 'utf8', expectedRevision: 'missing' }), /普通文件/);
  assert.equal(await fs.readFile(file, 'utf8'), 'created');
}));

test('raw overwrite baselines do not decode existing bytes but still reject directories and large previews', async () => fixture(async (file, directory) => {
  const original = Buffer.from([0xff, 0, 0xfe, 0x81]);
  await fs.writeFile(file, original);
  const revision = await readLocalTextRevision(file);
  assert.match(revision, /^v1:/);
  await writeLocalTextFile({ path: file, text: '明确覆盖为文本', encoding: 'utf16le', expectedRevision: revision });
  assert.equal((await readLocalTextFile({ path: file })).text, '明确覆盖为文本');
  await assert.rejects(readLocalTextRevision(directory), /普通文件/);
  await fs.writeFile(file, Buffer.alloc(MAX_EDITABLE_TEXT + 1));
  const preview = await readLocalTextRevision(file);
  assert.match(preview, /^preview:/);
  await assert.rejects(writeLocalTextFile({ path: file, text: 'must not replace preview', encoding: 'utf8', expectedRevision: preview }), /预览不能保存/);
  assert.equal((await fs.stat(file)).size, MAX_EDITABLE_TEXT + 1);
}));

test('line-ending metadata reports every supported form without changing text', () => {
  for (const [text, expected] of [['a\nb', 'lf'], ['a\r\nb', 'crlf'], ['a\rb', 'cr'], ['abc', 'none'], ['\r\n\n', 'mixed']] as const) {
    const value = decodeEditableText(Buffer.from(text), { truncated: false, revision: 'fixture', size: text.length });
    assert.equal(value.lineEnding, expected);
    assert.equal(value.text, text);
  }
});

test('POSIX saves retain permissions and reject symbolic links without touching their targets', { skip: process.platform === 'win32' }, async () => fixture(async (file, directory) => {
  await fs.writeFile(file, 'owned text', { mode: 0o640 });
  const before = await fs.stat(file);
  const initial = await readLocalTextFile({ path: file });
  await writeLocalTextFile({ path: file, ...initial, text: 'updated', expectedRevision: initial.revision });
  const after = await fs.stat(file);
  assert.equal(after.mode & 0o7777, before.mode & 0o7777);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  const symlink = path.join(directory, 'linked.txt');
  await fs.symlink(file, symlink);
  await assert.rejects(readLocalTextFile({ path: symlink }), /普通文件/);
  await assert.rejects(readLocalTextRevision(symlink), /普通文件/);
  await assert.rejects(writeLocalTextFile({ path: symlink, text: 'bad replacement', encoding: 'utf8', expectedRevision: 'missing' }), /普通文件/);
  assert.equal(await fs.readFile(file, 'utf8'), 'updated');
}));
