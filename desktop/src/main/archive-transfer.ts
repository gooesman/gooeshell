import { promises as fs, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client, SFTPWrapper } from 'ssh2';
import type { TransferInfo, TransferRequest } from '../shared/types';
import { extractLocalArchive, packLocalArchive } from './local-archive';
import { cleanupRemoteArchive, extractRemoteArchive, packRemoteArchive, prepareRemoteArchive,
  type RemoteArchiveContext } from './remote-archive';
import { isSftpClosed, performSftpTransfer, trackSftp } from './sftp-transfer';

const operations = { packLocalArchive, extractLocalArchive, prepareRemoteArchive, packRemoteArchive,
  extractRemoteArchive, cleanupRemoteArchive, performSftpTransfer };
export type ArchiveTransferOperations = typeof operations;

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('打包传输已取消');
}

function sourceName(request: TransferRequest): string {
  const source = request.direction === 'upload' ? path.resolve(request.source) : path.posix.normalize(request.source);
  const name = request.direction === 'upload' ? path.basename(source) : path.posix.basename(source);
  if (!name || name === '.' || name === '..' || /[\0/\\]/.test(name)) throw new Error('打包传输需要选择文件或文件夹，不能选择根目录');
  return name;
}

async function downloadDestination(directory: string, name: string): Promise<{ directory: string; stat: Stats }> {
  const canonical = await fs.realpath(directory);
  const stat = await fs.lstat(canonical);
  if (!stat.isDirectory()) throw new Error('下载目标不是目录');
  const destination = path.resolve(canonical, name);
  if (path.dirname(destination) !== canonical) throw new Error('下载文件名无效');
  try { await fs.lstat(destination); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { directory: canonical, stat }; throw error; }
  throw new Error('目标已存在，打包传输不会覆盖已有文件或目录');
}

/** Pack and unpack surround the existing verified SFTP transport. Scratch paths
 * never replace the original source/destination in the visible queue or retry. */
export async function performArchiveTransfer(
  client: Client, sftp: SFTPWrapper, request: TransferRequest, info: TransferInfo,
  userSignal: AbortSignal, emit: (force?: boolean) => void, endpointKey: string,
  notice: (message: string) => void = () => {}, ops: ArchiveTransferOperations = operations,
): Promise<void> {
  checkCancelled(userSignal);
  const name = sourceName(request);
  const disconnected = new AbortController();
  const signal = AbortSignal.any([userSignal, disconnected.signal]);
  let connectionError: Error | undefined;
  let transportClosed = false;
  let remote: RemoteArchiveContext | undefined;
  let local: { directory: string; parent: string; stat: Stats } | undefined;
  const phase = (state: TransferInfo['state'], total = 0) => {
    info.state = state; info.done = 0; info.total = total; emit(true);
  };
  const progress = (done: number, total?: number) => {
    info.done = done;
    if (total !== undefined) info.total = total;
    emit();
  };
  // Aborting the data channel unblocks pending SFTP calls while leaving the SSH
  // transport available for stopping helpers and cleaning their private files.
  const stopData = () => { try { sftp.destroy(); } catch { /* Already closed. */ } };
  const dataClosed = () => {
    if (userSignal.aborted || connectionError) return;
    connectionError = new Error('SSH 连接已断开，请重新连接后再尝试打包传输');
    disconnected.abort(connectionError);
  };
  const connectionClosed = () => { transportClosed = true; dataClosed(); };
  trackSftp(sftp);
  sftp.on('end', dataClosed); sftp.on('close', dataClosed);
  client.on('end', connectionClosed); client.on('close', connectionClosed); client.on('error', connectionClosed);
  signal.addEventListener('abort', stopData, { once: true });
  if (isSftpClosed(sftp) || (sftp as SFTPWrapper & { destroyed?: boolean }).destroyed) dataClosed();
  try {
    checkCancelled(signal);
    info.mode = 'archive';
    const target = request.direction === 'download' ? await downloadDestination(request.destinationDir, name) : undefined;
    const destinationDir = target?.directory ?? request.destinationDir;
    checkCancelled(signal);
    phase('packing');
    remote = await ops.prepareRemoteArchive(client, request.direction === 'upload'
      ? { directory: destinationDir, name } : {}, signal);
    checkCancelled(signal);
    const parent = await fs.realpath(os.tmpdir());
    const directory = await fs.mkdtemp(path.join(parent, 'gooeshell-archive-'));
    local = { directory, parent, stat: await fs.lstat(directory) };
    await fs.chmod(directory, 0o700);
    const archivePath = path.join(directory, 'payload.tar.gz');
    let originalBytes: number;
    if (request.direction === 'upload') {
      const packed = await ops.packLocalArchive(request.source, archivePath, signal, progress);
      originalBytes = packed.originalBytes;
      if (packed.name !== name) throw new Error('源文件名在打包期间发生变化');
    } else {
      const packed = await ops.packRemoteArchive(client, { source: request.source, context: remote },
        value => progress(value.done, value.total), signal);
      originalBytes = packed.total;
      if (packed.name !== name) throw new Error('服务器返回的压缩包名称与所选文件不符');
    }
    checkCancelled(signal);
    if (!Number.isSafeInteger(originalBytes) || originalBytes < 0) throw new Error('打包文件大小无效');
    const wireRequest: TransferRequest = {
      sessionId: request.sessionId, direction: request.direction, mode: 'direct', resume: false,
      source: request.direction === 'upload' ? archivePath : remote.archivePath,
      destinationDir: request.direction === 'upload' ? remote.workDir : directory,
    };
    phase('checking');
    const wireInfo: TransferInfo = { ...info, name: 'payload.tar.gz', source: wireRequest.source,
      destination: wireRequest.destinationDir, mode: 'direct' };
    await ops.performSftpTransfer(sftp, wireRequest, wireInfo, signal, force => {
      info.state = wireInfo.state; info.done = wireInfo.done; info.total = wireInfo.total; emit(force);
    }, endpointKey);
    checkCancelled(signal);
    phase('extracting', originalBytes);
    if (request.direction === 'upload') {
      const result = await ops.extractRemoteArchive(client, { context: remote, expectedName: name, total: originalBytes },
        value => progress(value.done, value.total), signal);
      info.destination = result.destination;
    } else {
      const currentTarget = await fs.lstat(destinationDir);
      if (!currentTarget.isDirectory() || currentTarget.isSymbolicLink()
        || currentTarget.dev !== target!.stat.dev || currentTarget.ino !== target!.stat.ino) {
        throw new Error('下载目标目录在传输期间发生变化，请重新选择目录');
      }
      await ops.extractLocalArchive(archivePath, destinationDir, name, signal,
        done => progress(done, originalBytes), originalBytes, target!.stat);
      info.destination = path.join(destinationDir, name);
    }
    info.done = originalBytes; info.total = originalBytes;
  } catch (error) {
    if (connectionError && !userSignal.aborted) throw connectionError;
    throw error;
  } finally {
    signal.removeEventListener('abort', stopData);
    sftp.removeListener('end', dataClosed); sftp.removeListener('close', dataClosed);
    client.removeListener('end', connectionClosed); client.removeListener('close', connectionClosed); client.removeListener('error', connectionClosed);
    // Cleanup failures must not turn an already published result into a failed
    // retry. Show the exact owned temporary path when the connection was lost.
    if (remote) {
      try {
        if (transportClosed) throw new Error('SSH 连接已关闭');
        await ops.cleanupRemoteArchive(client, remote);
      }
      catch { notice(`临时压缩包未能清理，请在连接恢复后检查：${remote.workDir}`); }
    }
    if (local) {
      try {
        const resolved = path.resolve(local.directory);
        const current = await fs.lstat(resolved);
        if (path.dirname(resolved) !== local.parent || !path.basename(resolved).startsWith('gooeshell-archive-')
          || !current.isDirectory() || current.isSymbolicLink()
          || current.dev !== local.stat.dev || current.ino !== local.stat.ino) throw new Error('临时目录发生变化');
        await fs.rm(resolved, { recursive: true, force: true });
      } catch { notice(`本地临时压缩包未能清理，请检查：${local.directory}`); }
    }
  }
}
