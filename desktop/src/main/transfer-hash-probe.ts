import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Client, SFTPWrapper } from 'ssh2';
import { createRemoteTransferHash, type RemoteTransferHash } from './remote-transfer-hash';

const MIN_HASH_LENGTH = 256 * 1024;

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error('传输校验已取消'), { name: 'AbortError' });
}

function connectionClosed(): Error { return new Error('SFTP 连接已关闭，校验已停止'); }

function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(Object.assign(new Error('传输校验已取消'), { name: 'AbortError' }));
    signal.addEventListener('abort', aborted, { once: true });
    operation.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => {
      signal.removeEventListener('abort', aborted); reject(error);
    });
    if (signal.aborted) aborted();
  });
}

function probeUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  // Only a definite server refusal to create the optional probe is compatible
  // with falling back. A transport failure must still fail the transfer.
  return [2, 3, 4, 8, 'EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code as string | number);
}

/** Bind an exec checksum to the SFTP directory before trusting it. A custom
 * SFTP subsystem can expose an entirely different root from an SSH exec shell. */
export function createTransferHash(
  sftp: SFTPWrapper, client: Client, rawHash: RemoteTransferHash = createRemoteTransferHash(client),
): RemoteTransferHash {
  const unavailableDirectories = new Set<string>();
  let closed = !!(sftp as SFTPWrapper & { destroyed?: boolean }).destroyed;
  const ended = () => { closed = true; };
  sftp.once('end', ended); sftp.once('close', ended);
  const isClosed = () => closed || !!(sftp as SFTPWrapper & { destroyed?: boolean }).destroyed;

  // Every underlying operation settles on channel closure, even if ssh2 never
  // invokes its callback. Callers may stop waiting on cancellation while a
  // delayed callback still hands the newly created probe to owned cleanup.
  const call = <T>(invoke: (callback: (error?: Error | null, value?: T) => void) => void): Promise<T> => {
    if (isClosed()) return Promise.reject(connectionClosed());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => { sftp.removeListener('end', disconnected); sftp.removeListener('close', disconnected); };
      const finish = (error?: Error | null, value?: T) => {
        if (settled) return;
        settled = true; cleanup();
        if (error) reject(error); else resolve(value as T);
      };
      const disconnected = () => finish(connectionClosed());
      sftp.once('end', disconnected); sftp.once('close', disconnected);
      try { invoke(finish); } catch (error) { finish(error as Error); }
    });
  };

  return async (remote, length, signal, onProgress) => {
    cancelled(signal);
    if (isClosed()) throw connectionClosed();
    if (typeof remote !== 'string' || !remote || remote.includes('\0')
      || !Number.isSafeInteger(length) || length < 0) throw new Error('传输校验路径或长度无效');
    if (length < MIN_HASH_LENGTH) return undefined;
    const directory = path.posix.dirname(remote);
    if (unavailableDirectories.has(directory)) return undefined;
    const proofPath = path.posix.join(directory, `.gooeshell-verify-${randomUUID()}`);
    const token = randomBytes(32).toString('hex');
    let handle: Buffer | undefined;
    let created = false;
    let failed = false;
    const pending = new Set<Promise<unknown>>();
    const operation = <T>(invoke: (callback: (error?: Error | null, value?: T) => void) => void) => {
      const underlying = call(invoke);
      pending.add(underlying);
      void underlying.then(() => pending.delete(underlying), () => pending.delete(underlying));
      return waitFor(underlying, signal);
    };
    const cleanup = async () => {
      // Remove only the exact path created by this invocation. Cleanup failure
      // must not invalidate a successful checksum or hide its original error.
      if (handle && !isClosed()) await call<void>(callback => sftp.close(handle!, callback)).catch(() => {});
      if (created && !isClosed()) await call<void>(callback => sftp.unlink(proofPath, callback)).catch(() => {});
    };
    try {
      try {
        await operation<Buffer>(callback => sftp.open(proofPath, 'wx', { mode: 0o600 }, (error, value) => {
          if (!error) { handle = value; created = true; }
          callback(error, value);
        }));
      } catch (error) {
        cancelled(signal);
        if (!isClosed() && probeUnavailable(error)) {
          unavailableDirectories.add(directory);
          return undefined;
        }
        throw error;
      }
      cancelled(signal);
      const bytes = Buffer.from(token, 'ascii');
      await operation<void>(callback => sftp.write(handle!, bytes, 0, bytes.length, 0, callback));
      cancelled(signal);
      await operation<void>(callback => sftp.close(handle!, error => {
        if (!error) handle = undefined;
        callback(error);
      }));
      cancelled(signal);
      const result = await rawHash(remote, length, signal, onProgress, { path: proofPath, token });
      cancelled(signal);
      if (isClosed()) throw connectionClosed();
      if (result === undefined) unavailableDirectories.add(directory);
      return result;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // A cancellation can be internal (for example a local disk read error),
      // so it must not wait forever for a still-live server's OPEN response.
      // Drain late replies before closing handles/removing this owned probe.
      if (pending.size || signal.aborted) void Promise.allSettled([...pending]).then(cleanup);
      else {
        // Cancellation may arrive after cleanup has started. Keep cleaning in
        // the background, but never hold up cancellation (including a sibling
        // local checksum failure) while waiting for an UNLINK acknowledgement.
        await waitFor(cleanup(), signal).catch(error => {
          if (!failed) throw error;
        });
      }
    }
  };
}
