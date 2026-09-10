import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { TransferInfo, TransferRequest } from '../shared/types';

const CHUNK = 64 * 1024;
const MAX_ENTRIES = 50_000;
const activeTargets = new Set<string>();
const closedSftp = new WeakSet<SFTPWrapper>();
const trackedSftp = new WeakSet<SFTPWrapper>();

export function trackSftp(sftp: SFTPWrapper): void {
  if (trackedSftp.has(sftp)) return;
  trackedSftp.add(sftp);
  sftp.once('end', () => closedSftp.add(sftp));
  sftp.once('close', () => closedSftp.add(sftp));
}

export function isSftpClosed(sftp: SFTPWrapper): boolean { return closedSftp.has(sftp); }

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('已取消，未完成的 .gooeshell.part 文件已保留');
}

export function sftpCall<T>(invoke: (callback: (error: Error | undefined | null, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => invoke((error, value) => error ? reject(error) : resolve(value)));
}

export async function remoteStat(sftp: SFTPWrapper, remote: string): Promise<Stats | undefined> {
  try { return await sftpCall<Stats>(cb => sftp.lstat(remote, cb)); }
  catch (error) { if ((error as { code?: number }).code === 2) return undefined; throw error; }
}

function validateSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('文件大小超过当前客户端可安全处理的范围');
  return value;
}

function entryName(name: string, local = false): string {
  if (!name || name === '.' || name === '..' || /[\0/]/.test(name)) throw new Error('服务器返回无效文件名');
  if (local && process.platform === 'win32' && (/[<>:"\\|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))) {
    throw new Error(`此远程文件名无法安全保存到 Windows：${JSON.stringify(name)}`);
  }
  return name;
}

async function localExists(name: string): Promise<boolean> {
  try { await fs.lstat(name); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

export async function remoteClose(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  // ssh2 silently queues requests submitted after channel EOF. Never enqueue cleanup
  // on a dead channel, or a cancelled job could retain its local file handle forever.
  if (isSftpClosed(sftp)) return;
  await new Promise<void>((resolve, reject) => {
    const ended = () => { cleanup(); resolve(); };
    const cleanup = () => { sftp.removeListener('end', ended); sftp.removeListener('close', ended); };
    sftp.once('end', ended); sftp.once('close', ended);
    try { sftp.close(handle, error => { cleanup(); error ? reject(error) : resolve(); }); }
    catch (error) { cleanup(); reject(error); }
  });
}

async function remoteRead(sftp: SFTPWrapper, handle: Buffer, buffer: Buffer, position: number, length: number): Promise<number> {
  let received = 0;
  while (received < length) {
    const count = await new Promise<number>((resolve, reject) => {
      sftp.read(handle, buffer, received, length - received, position + received,
        (error, bytesRead) => error ? reject(error) : resolve(bytesRead));
    });
    if (count === 0) break;
    received += count;
  }
  return received;
}

async function localRead(handle: FileHandle, buffer: Buffer, position: number, length: number): Promise<number> {
  let received = 0;
  while (received < length) {
    const { bytesRead } = await handle.read(buffer, received, length - received, position + received);
    if (bytesRead === 0) break;
    received += bytesRead;
  }
  return received;
}

async function localWrite(handle: FileHandle, buffer: Buffer, position: number, length: number): Promise<void> {
  let written = 0;
  while (written < length) {
    const { bytesWritten } = await handle.write(buffer, written, length - written, position + written);
    if (bytesWritten === 0) throw new Error('本地文件写入没有取得进展');
    written += bytesWritten;
  }
}

async function compare(
  local: FileHandle, sftp: SFTPWrapper, remote: Buffer, length: number,
  signal: AbortSignal, update: () => void,
): Promise<void> {
  const left = Buffer.allocUnsafe(CHUNK);
  const right = Buffer.allocUnsafe(CHUNK);
  for (let position = 0; position < length;) {
    cancelled(signal); update();
    const count = Math.min(CHUNK, length - position);
    const [a, b] = await Promise.all([localRead(local, left, position, count), remoteRead(sftp, remote, right, position, count)]);
    if (a !== count || b !== count || !left.subarray(0, count).equals(right.subarray(0, count))) {
      throw new Error('已有内容或校验内容不一致，保留 .gooeshell.part；请改用新目标或检查源文件');
    }
    position += count;
  }
}

interface Item { source: string; destination: string; directory: boolean; size: number; }

async function plan(sftp: SFTPWrapper, request: TransferRequest, signal: AbortSignal): Promise<Item[]> {
  const items: Item[] = [];
  const add = (item: Item) => {
    if (items.length >= MAX_ENTRIES) throw new Error(`单次目录任务最多支持 ${MAX_ENTRIES} 个条目，请分批传输`);
    items.push(item);
  };
  if (request.direction === 'upload') {
    const target = await sftpCall<string>(cb => sftp.realpath(request.destinationDir, cb));
    const stat = await remoteStat(sftp, target);
    if (!stat?.isDirectory()) throw new Error('上传目标必须是远程目录');
    const visit = async (source: string, destination: string, depth: number): Promise<void> => {
      cancelled(signal);
      if (depth > 64) throw new Error('目录层级超过 64 层，请分批传输');
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) throw new Error(`目录包含符号链接，首版不会自动跟随：${source}`);
      if (stat.isDirectory()) {
        add({ source, destination, directory: true, size: 0 });
        const children = await fs.readdir(source);
        for (const name of children) await visit(path.join(source, name), path.posix.join(destination, entryName(name)), depth + 1);
      } else if (stat.isFile()) add({ source, destination, directory: false, size: validateSize(stat.size) });
      else throw new Error(`只支持普通文件和目录：${source}`);
    };
    const source = path.resolve(request.source);
    await visit(source, path.posix.join(target, entryName(path.basename(source))), 0);
  } else {
    const destination = await fs.realpath(request.destinationDir);
    if (!(await fs.stat(destination)).isDirectory()) throw new Error('下载目标必须是本地目录');
    const source = await sftpCall<string>(cb => sftp.realpath(request.source, cb));
    const visit = async (remote: string, local: string, depth: number): Promise<void> => {
      cancelled(signal);
      if (depth > 64) throw new Error('目录层级超过 64 层，请分批传输');
      const stat = await remoteStat(sftp, remote);
      if (!stat) throw new Error(`远程文件不存在：${remote}`);
      if (stat.isSymbolicLink()) throw new Error(`目录包含符号链接，首版不会自动跟随：${remote}`);
      if (stat.isDirectory()) {
        add({ source: remote, destination: local, directory: true, size: 0 });
        const children = await sftpCall<import('ssh2').FileEntry[]>(cb => sftp.readdir(remote, cb));
        for (const child of children) {
          if (child.filename === '.' || child.filename === '..') continue;
          const name = entryName(child.filename, true);
          await visit(path.posix.join(remote, name), path.join(local, name), depth + 1);
        }
      } else if (stat.isFile()) add({ source: remote, destination: local, directory: false, size: validateSize(stat.size) });
      else throw new Error(`只支持普通文件和目录：${remote}`);
    };
    // Refuse a selected symbolic link instead of silently following realpath.
    if ((await remoteStat(sftp, request.source))?.isSymbolicLink()) throw new Error('请选择链接指向的实际文件或目录');
    await visit(source, path.join(destination, entryName(path.posix.basename(source), true)), 0);
  }
  return items;
}

export async function performSftpTransfer(
  sftp: SFTPWrapper, request: TransferRequest, info: TransferInfo,
  signal: AbortSignal, emit: (force?: boolean) => void, endpointKey: string,
): Promise<void> {
  trackSftp(sftp);
  info.state = 'checking'; emit(true);
  const items = await plan(sftp, request, signal);
  info.total = validateSize(items.reduce((sum, item) => sum + item.size, 0));
  if (items[0]) info.destination = items[0].destination;
  emit(true);
  for (const item of items) {
    cancelled(signal);
    if (item.directory) {
      if (request.direction === 'upload') {
        const existing = await remoteStat(sftp, item.destination);
        if (existing && !existing.isDirectory()) throw new Error(`目标不是目录：${item.destination}`);
        if (!existing) await new Promise<void>((resolve, reject) => sftp.mkdir(item.destination, { mode: 0o755 }, error => error ? reject(error) : resolve()));
      } else {
        if (await localExists(item.destination)) {
          const existing = await fs.lstat(item.destination);
          if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`本地目标不是普通目录：${item.destination}`);
        } else await fs.mkdir(item.destination);
      }
      continue;
    }
    const targetKey = `${endpointKey}:${request.direction}:${item.destination}`;
    if (activeTargets.has(targetKey)) throw new Error('另一个任务正在写入同一目标，请等待该任务结束');
    activeTargets.add(targetKey);
    try {
      if (request.direction === 'upload') await upload(sftp, item, request.resume, info, signal, emit);
      else await download(sftp, item, request.resume, info, signal, emit);
    } finally { activeTargets.delete(targetKey); }
  }
}

async function upload(sftp: SFTPWrapper, item: Item, resume: boolean, info: TransferInfo, signal: AbortSignal, emit: (force?: boolean) => void): Promise<void> {
  if (await remoteStat(sftp, item.destination)) throw new Error(`目标文件已存在，不会覆盖：${item.destination}`);
  const partial = `${item.destination}.gooeshell.part`;
  const existing = await remoteStat(sftp, partial);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('远程 .part 不是普通文件');
  if (existing && !resume) throw new Error('已有 .gooeshell.part；请选择“校验后续传”，或改用新目标');
  const offset = existing ? validateSize(existing.size) : 0;
  if (offset > item.size) throw new Error('远程 .part 比本地源文件大，请改用新目标');
  const local = await fs.open(item.source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let remote: Buffer | undefined;
  try {
    const before = await local.stat();
    if (!before.isFile() || before.size !== item.size) throw new Error('本地源文件在准备任务后发生变化');
    // SSH_FXF_READ | WRITE | CREAT | EXCL. No TRUNC, including when resuming.
    remote = await sftpCall<Buffer>(cb => sftp.open(partial, existing ? 'r+' : 0x2b, { mode: 0o600 }, cb));
    info.state = 'checking'; emit(true);
    await compare(local, sftp, remote, offset, signal, emit);
    const completedBefore = info.done;
    info.done += offset;
    info.state = 'transferring'; emit(true);
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (let position = offset; position < before.size;) {
      cancelled(signal);
      const count = Math.min(CHUNK, before.size - position);
      if (await localRead(local, buffer, position, count) !== count) throw new Error('本地源文件提前结束，保留 .part');
      await new Promise<void>((resolve, reject) => sftp.write(remote!, buffer, 0, count, position, error => error ? reject(error) : resolve()));
      position += count; info.done = completedBefore + position; emit();
    }
    info.state = 'checking'; emit(true);
    await compare(local, sftp, remote, before.size, signal, emit);
    const after = await local.stat();
    const remoteAfter = await sftpCall<Stats>(cb => sftp.fstat(remote!, cb));
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || remoteAfter.size !== before.size) throw new Error('文件在传输/校验期间改变，保留 .part');
    await remoteClose(sftp, remote); remote = undefined;
    cancelled(signal);
    if (await remoteStat(sftp, item.destination)) throw new Error('目标文件已被另一个任务创建，保留 .part');
    // Standard SFTP v3 rename does not overwrite. Do not use posix-rename extension.
    await new Promise<void>((resolve, reject) => sftp.rename(partial, item.destination, error => error ? reject(error) : resolve()));
  } finally {
    if (remote) await remoteClose(sftp, remote).catch(() => undefined);
    await local.close();
  }
}

async function download(sftp: SFTPWrapper, item: Item, resume: boolean, info: TransferInfo, signal: AbortSignal, emit: (force?: boolean) => void): Promise<void> {
  if (await localExists(item.destination)) throw new Error(`目标文件已存在，不会覆盖：${item.destination}`);
  const partial = `${item.destination}.gooeshell.part`;
  const existing = await localExists(partial) ? await fs.lstat(partial) : undefined;
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('本地 .part 不是普通文件');
  if (existing && !resume) throw new Error('已有 .gooeshell.part；请选择“校验后续传”，或改用新目标');
  const offset = existing ? validateSize(existing.size) : 0;
  if (offset > item.size) throw new Error('本地 .part 比远程源文件大，请改用新目标');
  const local = await fs.open(partial, existing ? 'r+' : 'wx+');
  let remote: Buffer | undefined;
  try {
    const opened = await local.stat();
    if (existing && (existing.ino !== opened.ino || existing.dev !== opened.dev || existing.size !== opened.size)) throw new Error('.part 在打开时发生变化');
    remote = await sftpCall<Buffer>(cb => sftp.open(item.source, 'r', cb));
    const before = await sftpCall<Stats>(cb => sftp.fstat(remote!, cb));
    if (!before.isFile() || before.size !== item.size) throw new Error('远程源文件在准备任务后发生变化');
    info.state = 'checking'; emit(true);
    await compare(local, sftp, remote, offset, signal, emit);
    const completedBefore = info.done;
    info.done += offset; info.state = 'transferring'; emit(true);
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (let position = offset; position < before.size;) {
      cancelled(signal);
      const count = Math.min(CHUNK, before.size - position);
      if (await remoteRead(sftp, remote, buffer, position, count) !== count) throw new Error('远程源文件提前结束，保留 .part');
      await localWrite(local, buffer, position, count);
      position += count; info.done = completedBefore + position; emit();
    }
    await local.sync();
    info.state = 'checking'; emit(true);
    await compare(local, sftp, remote, before.size, signal, emit);
    const after = await sftpCall<Stats>(cb => sftp.fstat(remote!, cb));
    const currentPath = await fs.lstat(partial);
    if (before.size !== after.size || before.mtime !== after.mtime || currentPath.ino !== opened.ino || currentPath.dev !== opened.dev || currentPath.size !== before.size) throw new Error('文件在传输/校验期间改变，保留 .part');
    cancelled(signal);
    // Atomic no-replace publication on NTFS/ext4. Retain .part on unsupported FS.
    await fs.link(partial, item.destination).catch(error => { throw new Error(`无法发布下载文件（完整 .part 已保留）：${(error as Error).message}`); });
    await fs.unlink(partial).catch(() => undefined);
  } finally {
    if (remote) await remoteClose(sftp, remote).catch(() => undefined);
    await local.close();
  }
}
