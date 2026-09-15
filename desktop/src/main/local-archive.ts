import { constants, createReadStream, promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { Header, Parser, Pax, type ReadEntry } from 'tar';

const MAX_ENTRIES = 50_000;
const MAX_DEPTH = 64;
const CHUNK = 64 * 1024;
export type ArchiveProgress = (doneBytes: number, totalBytes?: number) => void;
export interface LocalArchiveInfo { name: string; originalBytes: number; entries: number }
interface SourceEntry { absolute: string; name: string; stat: Stats }
interface ExtractedEntry { name: string; directory: boolean; mode: number; mtime?: Date }
interface OwnedPath { absolute: string; stat: Stats }

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('已取消打包传输');
}

function safeSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('压缩包中的文件大小无效或超过安全范围');
  return size;
}

function validateComponent(name: string): void {
  if (!name || name === '.' || name === '..' || /[\0\r\n/\\]/.test(name)) throw new Error('压缩包包含不安全的文件路径');
  if (process.platform === 'win32' && (/[\x00-\x1f<>:"|?*]/.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name))) {
    throw new Error(`此文件名无法安全保存到 Windows：${JSON.stringify(name)}`);
  }
}

function archiveParts(name: string, expectedName: string, directory: boolean): string[] {
  if (directory && name.endsWith('/')) name = name.slice(0, -1);
  if (/^[a-z]:/i.test(name)) throw new Error('压缩包包含绝对路径');
  const parts = name.split('/');
  parts.forEach(validateComponent);
  if (parts.length > MAX_DEPTH || parts[0] !== expectedName) throw new Error('压缩包的根目录或路径层级无效');
  return parts;
}

function sameIdentity(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.isDirectory() === second.isDirectory()
    && first.isFile() === second.isFile() && !second.isSymbolicLink();
}

function sameSnapshot(first: Stats, second: Stats): boolean {
  return sameIdentity(first, second) && first.size === second.size && first.mtimeMs === second.mtimeMs
    && first.ctimeMs === second.ctimeMs && first.mode === second.mode;
}

async function statIfPresent(absolute: string): Promise<Stats | undefined> {
  try { return await fs.lstat(absolute); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function verifyOwned(owned: OwnedPath): Promise<void> {
  const current = await fs.lstat(owned.absolute);
  if (!sameIdentity(owned.stat, current)) throw new Error('传输目标在操作期间发生变化');
}

async function unlinkOwned(owned: OwnedPath): Promise<void> {
  const current = await statIfPresent(owned.absolute);
  if (current && sameIdentity(owned.stat, current)) await fs.unlink(owned.absolute);
}

function childPath(parent: string, child: string): string {
  const absolute = path.resolve(parent, child);
  const relative = path.relative(parent, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('压缩包包含越界路径');
  }
  return absolute;
}

async function snapshotSource(source: string, signal: AbortSignal): Promise<SourceEntry[]> {
  const result: SourceEntry[] = [];
  const visit = async (absolute: string, name: string, depth: number): Promise<void> => {
    cancelled(signal);
    if (depth > MAX_DEPTH || result.length >= MAX_ENTRIES) throw new Error('打包内容超过 50000 项或 64 层目录限制');
    validateComponent(path.basename(absolute));
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('打包传输不支持符号链接或特殊文件');
    safeSize(stat.size);
    result.push({ absolute, name, stat });
    if (stat.isDirectory()) {
      for (const child of (await fs.readdir(absolute)).sort()) {
        validateComponent(child);
        await visit(path.join(absolute, child), `${name}/${child}`, depth + 1);
      }
    }
  };
  await visit(source, path.basename(source), 1);
  return result;
}

async function verifySnapshot(entry: SourceEntry, handle?: FileHandle): Promise<void> {
  if (!sameSnapshot(entry.stat, await fs.lstat(entry.absolute)) || (handle && !sameSnapshot(entry.stat, await handle.stat()))) {
    throw new Error(`打包期间源文件发生变化：${entry.name}`);
  }
}

/** Streams a snapshot into a new tar.gz. Existing archives are never overwritten. */
export async function packLocalArchive(source: string, archivePath: string, signal: AbortSignal, progress: ArchiveProgress = () => {}): Promise<LocalArchiveInfo> {
  cancelled(signal);
  source = path.resolve(source);
  archivePath = path.resolve(archivePath);
  const relativeArchive = path.relative(source, archivePath);
  if (!relativeArchive || (!path.isAbsolute(relativeArchive) && relativeArchive !== '..' && !relativeArchive.startsWith(`..${path.sep}`))) {
    throw new Error('临时压缩包不能放在待打包内容中');
  }
  const entries = await snapshotSource(source, signal);
  const originalBytes = safeSize(entries.reduce((sum, entry) => sum + (entry.stat.isFile() ? entry.stat.size : 0), 0));
  const info = { name: path.basename(source), originalBytes, entries: entries.length };
  const directories = new Map(entries.filter(entry => entry.stat.isDirectory()).map(entry => [entry.absolute, entry]));
  let done = 0;
  progress(0, originalBytes);
  cancelled(signal);
  const output = await fs.open(archivePath, 'wx', 0o600);
  const owned = { absolute: archivePath, stat: await output.stat() };
  let complete = false;
  async function* contents(): AsyncGenerator<Buffer> {
    for (const entry of entries) {
      cancelled(signal);
      let ancestor = path.dirname(entry.absolute);
      while (directories.has(ancestor)) {
        await verifySnapshot(directories.get(ancestor)!);
        ancestor = path.dirname(ancestor);
      }
      await verifySnapshot(entry);
      const directory = entry.stat.isDirectory();
      const mode = process.platform === 'win32'
        ? directory ? 0o755 : (entry.stat.mode & 0o200) ? 0o644 : 0o444
        : entry.stat.mode & 0o777;
      const header = new Header({ path: `${entry.name}${directory ? '/' : ''}`, type: directory ? 'Directory' : 'File',
        size: directory ? 0 : entry.stat.size, mode, uid: 0, gid: 0,
        mtime: new Date(Math.floor(entry.stat.mtimeMs / 1000) * 1000) });
      if (header.encode()) yield new Pax({ path: header.path, size: header.size, mtime: header.mtime }).encode();
      yield header.block!;
      if (directory) continue;
      const input = await fs.open(entry.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        await verifySnapshot(entry, input);
        let offset = 0;
        while (offset < entry.stat.size) {
          cancelled(signal);
          const buffer = Buffer.allocUnsafe(Math.min(CHUNK, entry.stat.size - offset));
          const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) throw new Error(`打包期间源文件发生变化：${entry.name}`);
          offset += bytesRead;
          done += bytesRead;
          progress(done, originalBytes);
          cancelled(signal);
          yield buffer.subarray(0, bytesRead);
        }
        await verifySnapshot(entry, input);
      } finally { await input.close(); }
      if (entry.stat.size % 512) yield Buffer.alloc(512 - entry.stat.size % 512);
    }
    for (const entry of entries) { cancelled(signal); await verifySnapshot(entry); }
    yield Buffer.alloc(1024);
  }
  try {
    await pipeline(Readable.from(contents()), createGzip(), output.createWriteStream(), { signal });
    cancelled(signal);
    complete = true;
    return info;
  } catch (error) {
    cancelled(signal);
    throw error;
  } finally {
    await output.close().catch(() => {});
    if (!complete) await unlinkOwned(owned);
  }
}

async function rollbackPublished(paths: OwnedPath[]): Promise<void> {
  // Never recursively remove the destination: unrelated files added by the user survive.
  for (const owned of paths.reverse()) {
    try {
      const current = await statIfPresent(owned.absolute);
      if (!current || !sameIdentity(owned.stat, current)) continue;
      if (current.isDirectory()) await fs.rmdir(owned.absolute);
      else {
        if (process.platform === 'win32') await fs.chmod(owned.absolute, 0o600);
        await fs.unlink(owned.absolute);
      }
    } catch { /* Preserve changed targets and nonempty directories. */ }
  }
}

async function publish(stage: OwnedPath, destination: OwnedPath, entries: ExtractedEntry[], signal: AbortSignal): Promise<void> {
  const owned: OwnedPath[] = [];
  const ownedDirectories = new Map<string, OwnedPath>([[destination.absolute, destination]]);
  try {
    for (const entry of entries) {
      cancelled(signal);
      await verifyOwned(stage);
      const target = childPath(destination.absolute, entry.name);
      const parent = ownedDirectories.get(path.dirname(target));
      if (!parent) throw new Error('压缩包缺少父目录');
      // Check every published ancestor before using a pathname below it.
      let ancestor: OwnedPath | undefined = parent;
      while (ancestor) { await verifyOwned(ancestor); ancestor = ownedDirectories.get(path.dirname(ancestor.absolute)); }
      if (entry.directory) {
        await fs.mkdir(target, { mode: 0o700 });
        const record = { absolute: target, stat: await fs.lstat(target) };
        owned.push(record);
        ownedDirectories.set(target, record);
      } else {
        const staged = childPath(stage.absolute, entry.name);
        const stat = await fs.lstat(staged);
        // A hard link publishes without replacing any existing destination, on the same volume.
        try {
          await fs.link(staged, target);
          owned.push({ absolute: target, stat });
        } catch (error) {
          if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          // FAT/exFAT and some network drives do not support hard links.
          const output = await fs.open(target, 'wx', 0o600);
          owned.push({ absolute: target, stat: await output.stat() });
          try {
            await pipeline(createReadStream(staged), output.createWriteStream(), { signal });
            await verifyOwned(owned[owned.length - 1]);
            if (entry.mtime) await fs.utimes(target, entry.mtime, entry.mtime);
            await fs.chmod(target, entry.mode);
          } finally { await output.close().catch(() => {}); }
        }
        await verifyOwned(owned[owned.length - 1]);
        if (process.platform === 'win32') {
          // Clearing a read-only staging hard link during rm would also change its
          // published twin. Unlink staging while writable, then apply permissions.
          await fs.unlink(staged);
          await fs.chmod(target, entry.mode);
        }
      }
    }
    for (const entry of [...entries].reverse()) {
      cancelled(signal);
      if (!entry.directory) continue;
      const target = childPath(destination.absolute, entry.name);
      await verifyOwned(ownedDirectories.get(target)!);
      if (entry.mtime) await fs.utimes(target, entry.mtime, entry.mtime);
      await fs.chmod(target, entry.mode);
    }
    cancelled(signal);
  } catch (error) {
    // Restore owner access before removing only the paths that this operation created.
    for (const directory of ownedDirectories.values()) {
      if (directory === destination) continue;
      try { await verifyOwned(directory); await fs.chmod(directory.absolute, 0o700); } catch { /* Changed path. */ }
    }
    await rollbackPublished(owned);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('目标已存在，打包传输不会覆盖现有文件或目录');
    throw error;
  }
}

/** Validates the complete gzip/tar in private staging before publishing a new root. */
export async function extractLocalArchive(archivePath: string, destinationDir: string, expectedName: string, signal: AbortSignal, progress: ArchiveProgress = () => {}, expectedBytes?: number, expectedDestination?: Pick<Stats, 'dev' | 'ino'>): Promise<LocalArchiveInfo> {
  cancelled(signal);
  if (expectedBytes !== undefined) safeSize(expectedBytes);
  validateComponent(expectedName);
  destinationDir = await fs.realpath(destinationDir);
  const destination = { absolute: destinationDir, stat: await fs.lstat(destinationDir) };
  if (!destination.stat.isDirectory()) throw new Error('解压目标不是目录');
  if (expectedDestination && (expectedDestination.dev !== destination.stat.dev || expectedDestination.ino !== destination.stat.ino)) {
    throw new Error('下载目标目录在传输期间发生变化，请重新选择目录');
  }
  if (await statIfPresent(childPath(destinationDir, expectedName))) throw new Error('目标已存在，打包传输不会覆盖现有文件或目录');
  const stagePath = await fs.mkdtemp(path.join(destinationDir, '.gooeshell-unpack-'));
  const stage = { absolute: stagePath, stat: await fs.lstat(stagePath) };
  await fs.chmod(stagePath, 0o700);
  const entries: ExtractedEntry[] = [];
  const seen = new Map<string, boolean>();
  const active = new Set<ReadEntry>();
  let bytes = 0;
  let eof = false;
  let entryWork = Promise.resolve();
  let failure: Error | undefined;
  const input = createReadStream(archivePath);
  const gunzip = createGunzip();
  const parser = new Parser({ strict: true, maxMetaEntrySize: 1024 * 1024 });
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    input.destroy(error);
    gunzip.destroy(error);
    for (const entry of active) entry.destroy(error);
    parser.abort(error);
  };
  const abort = () => fail(new Error('已取消打包传输'));
  parser.on('error', error => fail(error instanceof Error ? error : new Error(String(error))));
  parser.on('eof', () => { eof = true; });
  parser.on('ignoredEntry', () => fail(new Error('压缩包包含不支持的条目')));
  parser.on('meta', (metadata: string) => {
    // PAX records must be interpreted identically by the remote and local readers.
    // In particular, node-tar otherwise ignores malformed records and sparse-file metadata.
    if (metadata.includes('\0') || !metadata.endsWith('\n') || metadata.slice(0, -1).split('\n').some(line => {
      const match = /^(\d+) ([^=]+)=/.exec(line);
      return !match || Number(match[1]) !== Buffer.byteLength(line) + 1 || /^(GNU\.sparse\.|SCHILY\.(realsize|filetype)$)/.test(match[2]);
    })) fail(new Error('压缩包包含不支持或损坏的扩展信息'));
  });
  parser.on('entry', (entry: ReadEntry) => {
    // Keep entries paused until their parents have been created and the previous write closed.
    active.add(entry);
    entry.on('error', error => fail(error instanceof Error ? error : new Error(String(error))));
    entryWork = entryWork.then(async () => {
      cancelled(signal);
      if (failure) throw failure;
      const directory = entry.type === 'Directory';
      if (!directory && entry.type !== 'File' && entry.type !== 'OldFile') throw new Error('压缩包包含链接或特殊文件，无法安全解压');
      // node-tar normalizes backslashes on Windows. Inspect the original header too,
      // but use the effective PAX path (the raw header may retain a ustar prefix).
      if (entry.header.path?.includes('\\')) throw new Error('压缩包包含不安全的文件路径');
      const parts = archiveParts(entry.path, expectedName, directory);
      if (entry.linkpath) throw new Error('压缩包包含链接');
      const name = parts.join('/');
      const key = process.platform === 'win32' || process.platform === 'darwin' ? name.toLowerCase() : name;
      if (seen.has(key)) throw new Error('压缩包包含重复或冲突的文件路径');
      if (entries.length >= MAX_ENTRIES) throw new Error('压缩包超过 50000 项限制');
      if (!entries.length && parts.length !== 1) throw new Error('压缩包缺少根目录');
      const parent = key.slice(0, key.lastIndexOf('/'));
      if (parts.length > 1 && seen.get(parent) !== true) throw new Error('压缩包缺少父目录或父路径不是目录');
      const size = safeSize(entry.size);
      safeSize(bytes + size);
      if (expectedBytes !== undefined && bytes + size > expectedBytes) throw new Error('压缩包内容超过预期大小');
      const record = { name, directory, mode: (entry.mode ?? (directory ? 0o755 : 0o644)) & 0o777,
        mtime: entry.mtime && Number.isFinite(entry.mtime.getTime()) ? entry.mtime : undefined };
      seen.set(key, directory);
      entries.push(record);
      const target = childPath(stagePath, name);
      if (directory) {
        await fs.mkdir(target, { mode: 0o700 });
        for await (const _chunk of entry) { /* Drain the empty directory entry. */ }
      } else {
        const file = await fs.open(target, 'wx', 0o600);
        try {
          let written = 0;
          for await (const chunk of entry) {
            cancelled(signal);
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
              if (!bytesWritten) throw new Error('解压文件写入失败');
              offset += bytesWritten;
            }
            written += chunk.length;
            bytes += chunk.length;
            progress(bytes);
            cancelled(signal);
          }
          if (written !== size) throw new Error('压缩包内容不完整');
          if (record.mtime) await file.utimes(record.mtime, record.mtime);
          if (process.platform !== 'win32') await file.chmod(record.mode);
        } finally { await file.close(); }
      }
      active.delete(entry);
    }).catch(error => { fail(error instanceof Error ? error : new Error(String(error))); });
  });
  signal.addEventListener('abort', abort, { once: true });
  try {
    cancelled(signal);
    await pipeline(input, gunzip, parser);
    await entryWork;
    if (failure) throw failure;
    cancelled(signal);
    if (!entries.length || !eof) throw new Error('压缩包内容不完整');
    if (expectedBytes !== undefined && bytes !== expectedBytes) throw new Error('压缩包内容与预期大小不一致');
    await publish(stage, destination, entries, signal);
    return { name: expectedName, originalBytes: bytes, entries: entries.length };
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
    await entryWork;
    cancelled(signal);
    throw failure ?? error;
  } finally {
    signal.removeEventListener('abort', abort);
    // Only the uniquely created staging directory, still with its original identity, is removed.
    const resolvedStage = path.resolve(stage.absolute);
    if (path.dirname(resolvedStage) === destinationDir && path.basename(resolvedStage).startsWith('.gooeshell-unpack-')) {
      await verifyOwned(destination);
      await verifyOwned(stage);
      await fs.rm(resolvedStage, { recursive: true, force: true });
    }
  }
}
