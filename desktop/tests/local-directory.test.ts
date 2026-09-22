import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, type Dirent, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listLocalDirectory } from '../src/main/local-directory';

test('large directory metadata work is bounded and preserves folders, links, names and inaccessible entries', async () => {
  const count = 10000; let active = 0, peak = 0, completed = 0;
  const entries = Array.from({ length: count }, (_, index) => ({ name: `文件-${index}.txt` }) as Dirent);
  const mock = { ...fs,
    readdir: async () => entries,
    lstat: async (name: string) => {
      active++; peak = Math.max(active, peak); await new Promise(resolve => setImmediate(resolve)); active--; completed++;
      const index = Number(path.basename(name).match(/\d+/)![0]);
      if (index === 9) throw Object.assign(new Error('disappeared'), { code: 'ENOENT' });
      return { size: index, mtimeMs: index * 1000, mode: index < 2 ? 0o40755 : 0o100644,
        isDirectory: () => index < 2, isSymbolicLink: () => index === 2 } as Stats;
    },
  } as unknown as typeof fs;
  const result = await listLocalDirectory('.', mock);
  assert.equal(completed, count); assert.equal(active, 0); assert.equal(peak, 32);
  assert.equal(result.entries.length, count - 1); assert(result.entries.slice(0, 2).every(entry => entry.type === 'directory'));
  assert.equal(result.entries.find(entry => entry.name === '文件-2.txt')?.type, 'symlink');
  assert.equal(result.entries.find(entry => entry.name === '文件-8.txt')?.modified, 8000);
  const expected = [...result.entries].sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name, 'zh-CN'));
  assert.deepEqual(result.entries, expected);
});

test('local directory listing works with real files and propagates parent failures', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gooeshell-listing-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('gooeshell-listing-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, '目录')); await fs.writeFile(path.join(root, '文件.txt'), 'hello');
  const result = await listLocalDirectory(root);
  assert.equal(result.path, root); assert.deepEqual(result.entries.map(entry => entry.name), ['目录', '文件.txt']);
  assert.equal(result.entries[1].size, 5);
  assert.deepEqual((await listLocalDirectory(path.join(root, '目录'))).entries, []);
  await assert.rejects(listLocalDirectory(path.join(root, 'missing')), { code: 'ENOENT' });
});
