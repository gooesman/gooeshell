import { randomBytes } from 'node:crypto';
import type { Client, ClientChannel } from 'ssh2';

export interface RemoteTransferHashResult { sha256: string; size: number; mtime: number }
export interface RemoteTransferHashProof { path: string; token: string }
export type RemoteTransferHash = (path: string, length: number, signal: AbortSignal, onProgress?: (done: number) => void, proof?: RemoteTransferHashProof) => Promise<RemoteTransferHashResult | undefined>;

/** Constant shell source. File names and prefix lengths are sent only through JSON stdin. */
export const REMOTE_TRANSFER_HASH_PYTHON = String.raw`
import errno, hashlib, json, os, stat, sys, time

def snapshot(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def proof_matches(path, proof):
    if proof is None:
        return True
    if not isinstance(proof, dict) or not isinstance(proof.get('path'), str) or not isinstance(proof.get('token'), str):
        return False
    token, proof_path = proof['token'], proof['path']
    if len(token) not in (48, 64) or any(c not in '0123456789abcdef' for c in token):
        return False
    if not proof_path or '\0' in proof_path or len(proof_path.encode('utf-8')) > 65536:
        return False
    if os.path.dirname(os.path.abspath(proof_path)) != os.path.dirname(os.path.abspath(path)):
        return False
    descriptor = None
    try:
        descriptor = os.open(proof_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, 'O_CLOEXEC', 0))
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size != len(token):
            return False
        data = os.read(descriptor, 65)
        after, after_path = os.fstat(descriptor), os.stat(proof_path, follow_symlinks=False)
        return data == token.encode('ascii') and snapshot(before) == snapshot(after) == snapshot(after_path)
    except OSError:
        return False
    finally:
        if descriptor is not None:
            os.close(descriptor)

def hash_file(path, length, progress, proof=None):
    if not isinstance(path, str) or not path or '\0' in path or len(path.encode('utf-8')) > 65536:
        raise ValueError('文件路径无效')
    if type(length) is not int or length < 0 or length > 9007199254740991:
        raise ValueError('校验长度无效')
    if not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_NONBLOCK'):
        return {'unsupported': 'environment'}
    if not proof_matches(path, proof):
        return {'unsupported': 'path'}
    descriptor = None
    try:
        # Do not follow the final component or block opening a pipe/device.
        before_path = os.stat(path, follow_symlinks=False)
        if not stat.S_ISREG(before_path.st_mode):
            return {'unsupported': 'path'}
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, 'O_CLOEXEC', 0))
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or snapshot(before_path) != snapshot(before):
            raise RuntimeError('校验期间远程文件发生变化，请重新传输')
        if before.st_size < length:
            raise RuntimeError('远程文件长度不足，校验失败')
        digest, done, last = hashlib.sha256(), 0, 0
        progress(0)
        while done < length:
            data = os.read(descriptor, min(1024 * 1024, length - done))
            if not data:
                raise RuntimeError('远程文件提前结束，校验失败')
            digest.update(data)
            done += len(data)
            now = time.monotonic()
            if now - last >= 0.2:
                progress(done)
                last = now
        # For a full-file request, require EOF as well as matching metadata.
        if length == before.st_size and os.read(descriptor, 1):
            raise RuntimeError('校验期间远程文件长度发生变化，请重新传输')
        after = os.fstat(descriptor)
        try:
            after_path = os.stat(path, follow_symlinks=False)
        except OSError:
            raise RuntimeError('校验期间远程文件路径发生变化，请重新传输')
        if snapshot(before) != snapshot(after) or snapshot(before) != snapshot(after_path):
            raise RuntimeError('校验期间远程文件发生变化，请重新传输')
        if not proof_matches(path, proof):
            return {'unsupported': 'path'}
        progress(done)
        return {'sha256': digest.hexdigest(), 'size': before.st_size, 'mtime': before.st_mtime_ns // 1000000000}
    except OSError as error:
        if descriptor is None and error.errno in (errno.ENOENT, errno.ENOTDIR, errno.EACCES, errno.EPERM, errno.ELOOP, errno.ENOSYS, errno.ENOTSUP):
            return {'unsupported': 'path'}
        raise
    finally:
        if descriptor is not None:
            os.close(descriptor)

if __name__ == '__main__':
    frame = sys.argv[1]
    def emit(kind, value):
        print(frame + ':' + kind + ':' + json.dumps(value, separators=(',', ':')), flush=True)
    print(frame + ':READY', flush=True)
    try:
        request = sys.stdin.buffer.readline(256 * 1024 + 1)
        if len(request) > 256 * 1024 or not request.endswith(b'\n'):
            raise ValueError('校验请求过长或不完整')
        request = json.loads(request)
        result = hash_file(request['path'], request['length'], lambda done: emit('PROGRESS', done), request.get('proof'))
        emit('RESULT', {'ok': True, 'value': result})
    except Exception as error:
        emit('RESULT', {'ok': False, 'error': str(error)})
`;

function cancelled(): Error { return Object.assign(new Error('校验已取消'), { name: 'AbortError' }); }
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
const MAX_FRAME = 65536;

/** Capability failures are cached only for this SSH connection; per-path failures are not. */
export function createRemoteTransferHash(client: Client): RemoteTransferHash {
  let unsupported = false;
  return async (path, length, signal, onProgress, proof) => {
    if (signal.aborted) throw cancelled();
    if (typeof path !== 'string' || !path || path.includes('\0') || Buffer.byteLength(path) > 65536) throw new Error('文件路径无效');
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('校验长度无效');
    if (unsupported) return undefined;
    const request = JSON.stringify({ path, length, ...(proof ? { proof } : {}) }) + '\n';
    if (Buffer.byteLength(request) > 256 * 1024) throw new Error('校验请求过长');
    const frame = `GOOESHELL_HASH_${randomBytes(18).toString('hex')}`;
    return new Promise<RemoteTransferHashResult | undefined>((resolve, reject) => {
      let stream: ClientChannel | undefined;
      let settled = false, ready = false, resultSeen = false, stdout = '', stderr = '', lastProgress = 0, startupBytes = 0;
      let result: RemoteTransferHashResult | undefined;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const startupTimer = setTimeout(() => finish(undefined, undefined, true), 15_000);
      const abort = () => finish(cancelled(), undefined, true);
      const disconnected = () => finish(new Error('SSH 连接已断开，校验已停止'), undefined, true);
      const streamError = (error: Error) => finish(error, undefined, true);
      const stderrData = (data: Buffer) => {
        stderr += data.toString('utf8');
        if (stderr.length > MAX_FRAME) finish(new Error('远程校验错误输出超过限制'), undefined, true);
      };
      function terminate(channel: ClientChannel) {
        // An exec callback can arrive after cancellation. Drain its late errors too.
        const sink = () => {};
        channel.on('error', sink);
        channel.once('close', () => channel.removeListener('error', sink));
        try { channel.signal('TERM'); } catch { /* Unsupported on some SSH servers. */ }
        try { channel.close(); } catch { /* Already disconnected. */ }
        try { channel.destroy(); } catch { /* Already destroyed. */ }
      }
      function finish(error?: Error, value?: RemoteTransferHashResult, stop = false) {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer); clearTimeout(closeTimer);
        signal.removeEventListener('abort', abort);
        client.removeListener('close', disconnected);
        if (stream) {
          stream.removeListener('data', stdoutData);
          stream.stderr.removeListener('data', stderrData);
          stream.removeListener('close', streamClose);
          stream.removeListener('error', streamError);
          if (stop) terminate(stream);
        }
        if (error) reject(error); else resolve(value);
      }
      function consume(line: string) {
        if (line.length > MAX_FRAME) throw new Error('远程校验响应超过限制');
        if (!ready) {
          if (line !== `${frame}:READY`) return; // A login banner may precede Python.
          ready = true;
          clearTimeout(startupTimer);
          stream!.end(request);
          return;
        }
        if (resultSeen) throw new Error('远程校验返回重复结果');
        const progressPrefix = `${frame}:PROGRESS:`, resultPrefix = `${frame}:RESULT:`;
        if (line.startsWith(progressPrefix)) {
          const done: unknown = JSON.parse(line.slice(progressPrefix.length));
          if (typeof done !== 'number' || !Number.isSafeInteger(done) || done < lastProgress || done > length) throw new Error('远程校验进度无效');
          lastProgress = done;
          onProgress?.(done);
        } else if (line.startsWith(resultPrefix)) {
          const envelope = JSON.parse(line.slice(resultPrefix.length));
          if (envelope?.ok === false && typeof envelope.error === 'string') throw new Error(envelope.error);
          if (envelope?.ok !== true || !envelope.value) throw new Error('远程校验结果无效');
          const value = envelope.value;
          if (value.unsupported === 'environment' || value.unsupported === 'path') {
            if (value.unsupported === 'environment') unsupported = true;
          } else {
            if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)
              || !Number.isSafeInteger(value.size) || value.size < length
              || !Number.isSafeInteger(value.mtime) || value.mtime < 0) throw new Error('远程校验结果无效');
            result = { sha256: value.sha256, size: value.size, mtime: value.mtime };
          }
          resultSeen = true;
          // A finished helper should close promptly, independently of hash duration.
          closeTimer = setTimeout(() => finish(new Error('远程校验未正常结束'), undefined, true), 10_000);
        } else throw new Error('远程校验响应无法解析');
      }
      function stdoutData(data: Buffer) {
        if (settled) return;
        if (!ready && (startupBytes += data.length) > MAX_FRAME) return finish(new Error('远程校验启动输出超过限制'), undefined, true);
        stdout += data.toString('ascii');
        try {
          let newline: number;
          while (!settled && (newline = stdout.indexOf('\n')) >= 0) {
            const line = stdout.slice(0, newline).replace(/\r$/, '');
            stdout = stdout.slice(newline + 1);
            consume(line);
          }
          if (stdout.length > MAX_FRAME) throw new Error('远程校验响应超过限制');
        } catch (error) { finish(error instanceof Error ? error : new Error('远程校验响应无法解析'), undefined, true); }
      }
      function streamClose(code: number | null) {
        if (settled) return;
        if (!ready) {
          if (code === 127 || /python3[^\n]*(not found|not recognized|command not found)/i.test(stderr)) unsupported = true;
          return finish();
        }
        if (!resultSeen || stdout.trim() || code !== 0) return finish(new Error('远程校验未返回完整结果'));
        finish(undefined, result);
      }
      signal.addEventListener('abort', abort, { once: true });
      client.once('close', disconnected);
      if (signal.aborted) return abort();
      try {
        client.exec(`python3 -I -u -c ${shellQuote(REMOTE_TRANSFER_HASH_PYTHON)} ${frame}`, { pty: false }, (error, channel) => {
          if (error) {
            if (/administratively prohibited|exec.*(?:denied|unsupported|not supported)|session request failed|^Unable to exec$/i.test(error.message)) {
              unsupported = true;
              return finish();
            }
            return finish(error);
          }
          if (settled) { terminate(channel); return; }
          stream = channel;
          stream.on('data', stdoutData);
          stream.on('error', streamError);
          stream.on('close', streamClose);
          stream.stderr.on('data', stderrData);
        });
      } catch (error) { finish(error instanceof Error ? error : new Error('无法启动远程校验')); }
    });
  };
}
