import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FileEntry, FileListing } from '../shared/types';

const collator = new Intl.Collator('zh-CN');
const CONCURRENCY = 32;

/** Avoid flooding the main process and the filesystem pool with one pending
 * promise per directory entry. Keep the original order until the final sort. */
export async function listLocalDirectory(directory: string, filesystem = fs): Promise<FileListing> {
  const actual = path.resolve(directory);
  const entries = await filesystem.readdir(actual, { withFileTypes: true });
  const result: Array<FileEntry | undefined> = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++, entry = entries[index], target = path.join(actual, entry.name);
      try {
        const stat = await filesystem.lstat(target);
        result[index] = { name: entry.name, path: target,
          type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
          size: stat.size, modified: stat.mtimeMs, mode: stat.mode };
      } catch { /* Entries may disappear or be inaccessible while browsing. */ }
    }
  }));
  return { path: actual, entries: result.filter((entry): entry is FileEntry => entry !== undefined)
    .sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || collator.compare(a.name, b.name)) };
}
