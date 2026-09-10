import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readLocalText, renameLocalPath } from '../src/main/local-files.ts';
import { Store } from '../src/main/store.ts';
import { defaultSettings } from '../src/shared/defaults.ts';
import type { HostProfile } from '../src/shared/types.ts';

async function fixture(run: (directory: string) => Promise<void>) {
  const base = path.resolve('test-output');
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'local-files-store-'));
  try { await run(directory); }
  finally {
    assert.ok(directory.startsWith(base + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('local text preserves valid UTF-8 and BOM, and refuses lossy decoding', async () => fixture(async directory => {
  const file = path.join(directory, 'text.txt');
  const text = '\ufeff中文 hello\r\n';
  await fs.writeFile(file, text, 'utf8');
  assert.deepEqual(await readLocalText(file), { text, truncated: false });
  const original = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
  await fs.writeFile(file, original);
  await assert.rejects(readLocalText(file), /不是 UTF-8/);
  assert.deepEqual(await fs.readFile(file), original);
  await fs.writeFile(file, Buffer.from([0x61, 0, 0x62]));
  await assert.rejects(readLocalText(file), /二进制/);
  await fs.writeFile(file, Buffer.from([0x61, 0xe4, 0xbd]));
  await assert.rejects(readLocalText(file), /不是 UTF-8/);
}));

test('large UTF-8 previews do not replace a character split at the size limit', async () => fixture(async directory => {
  const file = path.join(directory, 'large.txt');
  const prefix = 'x'.repeat(2 * 1024 * 1024 - 1);
  await fs.writeFile(file, prefix + '你suffix', 'utf8');
  assert.deepEqual(await readLocalText(file), { text: prefix, truncated: true });
}));

test('local rename rejects existing files and directories without modifying either side', async () => fixture(async directory => {
  const source = path.join(directory, 'source.txt');
  const destination = path.join(directory, 'existing.txt');
  await fs.writeFile(source, 'new content');
  await fs.writeFile(destination, 'original content');
  await assert.rejects(renameLocalPath(source, destination), /目标名称已存在/);
  assert.equal(await fs.readFile(source, 'utf8'), 'new content');
  assert.equal(await fs.readFile(destination, 'utf8'), 'original content');
  await renameLocalPath(source, source);
  assert.equal(await fs.readFile(source, 'utf8'), 'new content');
  const moved = path.join(directory, 'renamed 中文.txt');
  await renameLocalPath(source, moved);
  assert.equal(await fs.readFile(moved, 'utf8'), 'new content');
  const first = path.join(directory, 'first');
  const second = path.join(directory, 'second');
  await fs.mkdir(first); await fs.mkdir(second);
  await assert.rejects(renameLocalPath(first, second), /目标名称已存在/);
  assert.ok((await fs.stat(first)).isDirectory());
  assert.ok((await fs.stat(second)).isDirectory());
}));

test('rapid font setting writes all succeed and keep the latest requested value', async () => fixture(async directory => {
  const store = new Store(directory);
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.saveSettings({ ...defaultSettings, fontSize: 8 + index })));
  assert.equal((await store.settings()).fontSize, 27);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8')).fontSize, 27);
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')), []);
}));

test('theme settings migrate older files and persist without resetting fonts or shortcuts', async () => fixture(async directory => {
  const file = path.join(directory, 'settings.json');
  const legacy = {
    fontFamily: 'Consolas', chineseFont: 'SimSun', fontSize: 18,
    shortcuts: { ...defaultSettings.shortcuts, paste: 'MouseMiddle' },
  };
  for (const stored of [legacy, { ...legacy, theme: 'unrecognized' }]) {
    await fs.writeFile(file, JSON.stringify(stored));
    const settings = await new Store(directory).settings();
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.fontFamily, legacy.fontFamily);
    assert.equal(settings.chineseFont, legacy.chineseFont);
    assert.equal(settings.fontSize, legacy.fontSize);
    assert.deepEqual(settings.shortcuts, legacy.shortcuts);
  }
  const store = new Store(directory);
  const settings = await store.settings();
  await store.saveSettings({ ...settings, theme: 'light' });
  assert.deepEqual(await new Store(directory).settings(), { ...settings, theme: 'light' });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).theme, 'light');
}));

test('concurrent profile save/delete operations preserve every unrelated host', async () => fixture(async directory => {
  const store = new Store(directory);
  const profile = (id: string): HostProfile => ({ id, name: id, host: '127.0.0.1', port: 22, username: 'fixture', auth: 'agent', rememberHost: false, encoding: 'utf8' });
  const saves = Array.from({ length: 10 }, (_, index) => store.saveProfile(profile(String(index))));
  const deletes = [store.deleteProfile('2'), store.deleteProfile('7')];
  await Promise.all([...saves, ...deletes]);
  assert.deepEqual((await store.profiles()).map(item => item.id).sort(), ['0', '1', '3', '4', '5', '6', '8', '9']);
}));

test('a failed configuration write does not poison later writes', async () => fixture(async directory => {
  const store = new Store(directory);
  const blocker = path.join(directory, 'settings.json');
  await fs.mkdir(blocker);
  await assert.rejects(store.saveSettings(defaultSettings));
  await fs.rmdir(blocker);
  await store.saveSettings({ ...defaultSettings, fontSize: 19 });
  assert.equal((await store.settings()).fontSize, 19);
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')), []);
}));
