import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { Client, ClientChannel } from 'ssh2';

export interface RemoteArchiveContext {
  directory: string;
  workDir: string;
  archivePath: string;
  token: string;
}

export interface RemoteArchiveProgress { done: number; total: number; entries: number }
export interface RemoteArchivePacked { name: string; total: number; entries: number; archiveSize: number }
export interface RemoteArchiveExtracted { destination: string; total: number; entries: number }

/** The only shell source sent to the server. All paths arrive as framed stdin JSON. */
export const REMOTE_ARCHIVE_PYTHON = String.raw`
import base64, ctypes, errno, gzip, json, os, signal, stat, sys, tarfile, tempfile, time

FRAME = sys.argv[1]
MAX_ENTRIES, MAX_DEPTH, MAX_REQUEST = 50000, 64, 256 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0)

def interrupted(signum, frame):
    raise InterruptedError('操作已取消')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGHUP, interrupted)

def emit(kind, value):
    data = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    print(FRAME + ':' + kind + ':' + base64.b64encode(data).decode('ascii'), flush=True)

class Progress:
    def __init__(self, total=0):
        self.done, self.total, self.entries, self.last = 0, total, 0, 0
    def send(self, force=False):
        now = time.monotonic()
        if force or now - self.last >= 0.2:
            emit('PROGRESS', {'done': self.done, 'total': self.total, 'entries': self.entries})
            self.last = now

def path_value(value):
    if not isinstance(value, str) or not value or '\0' in value or len(value.encode('utf-8')) > 65536:
        raise ValueError('路径不能为空，也不能包含 NUL 字符或超过长度限制')
    return os.path.abspath(value)

def name_value(value):
    if not isinstance(value, str) or not value or value in ('.', '..') or any(c in value for c in ('/', '\\', '\0', '\r', '\n')):
        raise ValueError('打包传输需要有效的文件名，不能选择根目录')
    if len(value.encode('utf-8')) > 4096:
        raise ValueError('文件名超过长度限制')
    return value

def open_directory(path):
    path = path_value(path)
    fd = os.open('/', DIR_FLAGS)
    try:
        for component in path.split('/'):
            if component:
                next_fd = os.open(component, DIR_FLAGS, dir_fd=fd)
                os.close(fd)
                fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise

def exists(parent, name):
    try:
        os.stat(name, dir_fd=parent, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False

def ensure_absent(parent, name):
    if exists(parent, name):
        raise FileExistsError('目标已存在，打包传输不会覆盖已有文件或目录')

def same(a, b):
    return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)

def snapshot_same(a, b):
    return same(a, b) and (a.st_size, a.st_mtime_ns, a.st_ctime_ns, a.st_mode) == (b.st_size, b.st_mtime_ns, b.st_ctime_ns, b.st_mode)

def token_value(token):
    if not isinstance(token, str) or len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
        raise ValueError('临时传输目录凭据无效')
    return token

def prepare(payload):
    base = os.path.realpath(path_value(payload.get('directory') or tempfile.gettempdir()))
    token = token_value(payload.get('token'))
    folder = '.gooeshell-archive-' + token
    parent = open_directory(base)
    created, work = False, None
    try:
        if payload.get('name') is not None:
            ensure_absent(parent, name_value(payload['name']))
        os.mkdir(folder, 0o700, dir_fd=parent)
        created = True
        work = os.open(folder, DIR_FLAGS, dir_fd=parent)
        marker = os.open('.owner', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=work)
        with os.fdopen(marker, 'wb') as output:
            output.write(token.encode('ascii'))
        directory = os.path.join(base, folder)
        return {'directory': base, 'workDir': directory, 'archivePath': os.path.join(directory, 'payload.tar.gz'), 'token': token}
    except BaseException:
        if created:
            if work is not None and exists(work, '.owner'):
                os.unlink('.owner', dir_fd=work)
            os.rmdir(folder, dir_fd=parent)
        raise
    finally:
        if work is not None:
            os.close(work)
        os.close(parent)

def context_handles(context):
    token = token_value(context.get('token'))
    base = path_value(context.get('directory'))
    folder = '.gooeshell-archive-' + token
    expected = os.path.join(base, folder)
    if context.get('workDir') != expected or context.get('archivePath') != os.path.join(expected, 'payload.tar.gz'):
        raise ValueError('临时传输目录不属于当前任务，已停止操作')
    parent = open_directory(base)
    work = None
    try:
        before = os.stat(folder, dir_fd=parent, follow_symlinks=False)
        work = os.open(folder, DIR_FLAGS, dir_fd=parent)
        opened = os.fstat(work)
        if not same(before, opened) or opened.st_uid != os.geteuid() or stat.S_IMODE(opened.st_mode) != 0o700:
            raise ValueError('临时传输目录已发生变化，已停止操作')
        marker = os.open('.owner', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=work)
        with os.fdopen(marker, 'rb') as owner:
            info = os.fstat(owner.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or owner.read(65) != token.encode('ascii'):
                raise ValueError('临时传输目录凭据不匹配，已停止操作')
        return parent, work, folder, opened
    except BaseException:
        if work is not None:
            os.close(work)
        os.close(parent)
        raise

def safe_member(name, expected):
    if not isinstance(name, str) or not name or name.startswith('/') or any(c in name for c in ('\\', '\0', '\r', '\n')):
        raise ValueError('压缩包包含不安全的路径')
    clean = name[:-1] if name.endswith('/') else name
    parts = clean.split('/')
    if len(parts) > MAX_DEPTH or len(clean.encode('utf-8')) > 65536 or any(part in ('', '.', '..') for part in parts) or parts[0] != expected:
        raise ValueError('压缩包路径越界或目录层级过深')
    return parts

def source_entries(source, progress):
    absolute = path_value(source)
    parent_path, name = os.path.split(absolute)
    name_value(name)
    parent = open_directory(os.path.realpath(parent_path))
    manifest = []
    def walk(parent_fd, leaf, components):
        if len(components) > MAX_DEPTH or len(manifest) >= MAX_ENTRIES:
            raise ValueError('打包传输最多支持 50000 个条目和 64 层目录')
        safe_member('/'.join(components), name)
        info = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) and not stat.S_ISDIR(info.st_mode):
            raise ValueError('打包传输不支持符号链接或特殊文件，请选择普通文件或目录')
        manifest.append((components, info))
        if stat.S_ISREG(info.st_mode):
            progress.total += info.st_size
        progress.send()
        if stat.S_ISDIR(info.st_mode):
            child = os.open(leaf, DIR_FLAGS, dir_fd=parent_fd)
            try:
                if not same(info, os.fstat(child)):
                    raise RuntimeError('打包期间源目录发生变化，请重新传输')
                with os.scandir(child) as entries:
                    for entry in entries:
                        walk(child, entry.name, components + [entry.name])
            finally:
                os.close(child)
    try:
        walk(parent, name, [name])
        return parent, name, manifest
    except BaseException:
        os.close(parent)
        raise

def relative_parent(parent, components):
    current = os.dup(parent)
    try:
        for component in components[:-1]:
            next_fd = os.open(component, DIR_FLAGS, dir_fd=current)
            os.close(current)
            current = next_fd
        return current
    except BaseException:
        os.close(current)
        raise

class CountingReader:
    def __init__(self, source, progress):
        self.source, self.progress = source, progress
    def read(self, size):
        data = self.source.read(size)
        self.progress.done += len(data)
        self.progress.send()
        return data

def pack(payload):
    parent, work, folder, identity = context_handles(payload['context'])
    source_parent = None
    partial = 'payload.tar.gz.building'
    progress = Progress()
    created = False
    try:
        source = path_value(payload.get('source'))
        # A temporary archive must never become part of its own source tree.
        resolved_source = os.path.realpath(source)
        if os.path.commonpath([resolved_source, payload['context']['workDir']]) == resolved_source:
            raise ValueError('临时压缩包不能位于待打包目录内')
        ensure_absent(work, 'payload.tar.gz')
        source_parent, name, manifest = source_entries(source, progress)
        progress.send(True)
        output_fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=work)
        created = True
        with os.fdopen(output_fd, 'wb') as output:
            with tarfile.open(fileobj=output, mode='w|gz', format=tarfile.PAX_FORMAT, bufsize=1024*1024) as archive:
                for components, before in manifest:
                    handle = relative_parent(source_parent, components)
                    try:
                        info = os.stat(components[-1], dir_fd=handle, follow_symlinks=False)
                        if not snapshot_same(before, info):
                            raise RuntimeError('打包期间源文件发生变化，请重新传输')
                        member = tarfile.TarInfo('/'.join(components))
                        member.mode, member.mtime = stat.S_IMODE(info.st_mode) & 0o777, int(info.st_mtime)
                        if stat.S_ISDIR(info.st_mode):
                            member.type = tarfile.DIRTYPE
                            archive.addfile(member)
                        else:
                            fd = os.open(components[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=handle)
                            with os.fdopen(fd, 'rb') as input_file:
                                if not snapshot_same(before, os.fstat(input_file.fileno())):
                                    raise RuntimeError('打包期间源文件发生变化，请重新传输')
                                member.size = info.st_size
                                archive.addfile(member, CountingReader(input_file, progress))
                                if not snapshot_same(before, os.fstat(input_file.fileno())):
                                    raise RuntimeError('打包期间源文件发生变化，请重新传输')
                        progress.entries += 1
                        progress.send()
                    finally:
                        os.close(handle)
            output.flush()
            os.fsync(output.fileno())
        os.link(partial, 'payload.tar.gz', src_dir_fd=work, dst_dir_fd=work, follow_symlinks=False)
        os.unlink(partial, dir_fd=work)
        created = False
        progress.send(True)
        return {'name': name, 'total': progress.total, 'entries': progress.entries, 'archiveSize': os.stat('payload.tar.gz', dir_fd=work, follow_symlinks=False).st_size}
    finally:
        if created:
            os.unlink(partial, dir_fd=work)
        if source_parent is not None:
            os.close(source_parent)
        os.close(work)
        os.close(parent)

def publish(source, name, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    flags = 1
    if rename is None and sys.platform == 'darwin':
        rename, flags = getattr(libc, 'renameatx_np', None), 4
    if rename is None:
        raise RuntimeError('服务器缺少不覆盖发布支持，未覆盖目标，请使用普通传输')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(source, os.fsencode(name), destination, os.fsencode(name), flags) != 0:
        code = ctypes.get_errno()
        if code in (errno.EEXIST, errno.ENOTEMPTY):
            raise FileExistsError('目标已存在，打包传输不会覆盖已有文件或目录')
        raise OSError(code, os.strerror(code))

class SafeTarInfo(tarfile.TarInfo):
    # tarfile processes extended headers before yielding an entry. Bound them
    # before their allocation, and refuse sparse formats before reading maps.
    def _proc_pax(self, archive):
        if self.size < 0 or self.size > 65536:
            raise ValueError('压缩包扩展信息超过大小限制')
        return super()._proc_pax(archive)
    def _proc_gnulong(self, archive):
        if self.size < 0 or self.size > 65536:
            raise ValueError('压缩包文件名超过大小限制')
        return super()._proc_gnulong(archive)
    def _proc_sparse(self, archive):
        raise ValueError('打包传输不支持稀疏压缩包')
    def _proc_gnusparse_00(self, *args):
        raise ValueError('打包传输不支持稀疏压缩包')
    def _proc_gnusparse_01(self, *args):
        raise ValueError('打包传输不支持稀疏压缩包')
    def _proc_gnusparse_10(self, *args):
        raise ValueError('打包传输不支持稀疏压缩包')

def extract(payload):
    parent, work, folder, identity = context_handles(payload['context'])
    stage = None
    progress = Progress(payload.get('total') or 0)
    expected = name_value(payload.get('expectedName'))
    seen, directories = set(), []
    try:
        ensure_absent(parent, expected)
        os.mkdir('unpacked', 0o700, dir_fd=work)
        stage = os.open('unpacked', DIR_FLAGS, dir_fd=work)
        archive_fd = os.open('payload.tar.gz', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=work)
        with os.fdopen(archive_fd, 'rb') as compressed:
            before = os.fstat(compressed.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise ValueError('压缩包必须是普通文件')
            with gzip.GzipFile(fileobj=compressed, mode='rb') as gzip_input:
                with tarfile.open(fileobj=gzip_input, mode='r|', bufsize=1024*1024, tarinfo=SafeTarInfo) as archive:
                    for member in archive:
                        parts = safe_member(member.name, expected)
                        relative = '/'.join(parts)
                        if relative in seen or len(seen) >= MAX_ENTRIES:
                            raise ValueError('压缩包包含重复路径或超过 50000 个条目')
                        if not member.isdir() and not member.isreg() or member.issparse() or member.size < 0:
                            raise ValueError('压缩包包含链接、稀疏文件或特殊文件，已停止解压')
                        if len(parts) > 1 and '/'.join(parts[:-1]) not in seen:
                            raise ValueError('压缩包缺少父目录条目')
                        target_parent = relative_parent(stage, parts)
                        try:
                            if member.isdir():
                                if member.size != 0:
                                    raise ValueError('压缩包目录条目无效')
                                os.mkdir(parts[-1], 0o700, dir_fd=target_parent)
                                directories.append((parts, member.mode & 0o777, member.mtime))
                            else:
                                if payload.get('total') is not None and progress.done + member.size > payload['total']:
                                    raise ValueError('解压数据超过原始大小，压缩包可能已损坏')
                                fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target_parent)
                                with os.fdopen(fd, 'wb') as output:
                                    source = archive.extractfile(member)
                                    remaining = member.size
                                    while remaining:
                                        block = source.read(min(remaining, 1024 * 1024))
                                        if not block:
                                            raise ValueError('压缩包内容不完整')
                                        output.write(block)
                                        remaining -= len(block)
                                        progress.done += len(block)
                                        progress.send()
                                    source.close()
                                    output.flush()
                                    os.fchmod(output.fileno(), member.mode & 0o777)
                                    os.utime(output.fileno(), (member.mtime, member.mtime))
                            seen.add(relative)
                            progress.entries += 1
                            progress.send()
                        finally:
                            os.close(target_parent)
                # tar stops at its end marker; drain gzip as well to verify its CRC/trailer.
                padding = 0
                while True:
                    trailer = gzip_input.read(1024 * 1024)
                    if not trailer:
                        break
                    padding += len(trailer)
                    if padding > 1024 * 1024 or any(trailer):
                        raise ValueError('压缩包结束标记后包含异常数据')
            if not snapshot_same(before, os.fstat(compressed.fileno())):
                raise RuntimeError('解压期间压缩包发生变化，已停止发布')
        if expected not in seen or (payload.get('total') is not None and progress.done != payload['total']):
            raise ValueError('压缩包内容与原始文件不一致')
        for parts, mode, modified in reversed(directories):
            handle = relative_parent(stage, parts)
            try:
                directory = os.open(parts[-1], DIR_FLAGS, dir_fd=handle)
                try:
                    os.fchmod(directory, mode)
                    os.utime(directory, (modified, modified))
                finally:
                    os.close(directory)
            finally:
                os.close(handle)
        publish(stage, expected, parent)
        progress.total = progress.done
        progress.send(True)
        return {'destination': os.path.join(payload['context']['directory'], expected), 'total': progress.done, 'entries': progress.entries}
    finally:
        if stage is not None:
            os.close(stage)
        os.close(work)
        os.close(parent)

def remove_contents(directory, keep_owner=False):
    with os.scandir(directory) as entries:
        for entry in entries:
            if keep_owner and entry.name == '.owner':
                continue
            before = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(before.st_mode):
                # Extraction may have restored read-only modes before publication failed.
                os.chmod(entry.name, 0o700, dir_fd=directory, follow_symlinks=False)
                child = os.open(entry.name, DIR_FLAGS, dir_fd=directory)
                try:
                    if not same(before, os.fstat(child)):
                        raise RuntimeError('临时目录发生变化，已停止清理')
                    remove_contents(child)
                    if not same(before, os.stat(entry.name, dir_fd=directory, follow_symlinks=False)):
                        raise RuntimeError('临时目录发生变化，已停止清理')
                    os.rmdir(entry.name, dir_fd=directory)
                finally:
                    os.close(child)
            else:
                os.unlink(entry.name, dir_fd=directory)

def cleanup(payload):
    try:
        parent, work, folder, identity = context_handles(payload['context'])
    except FileNotFoundError:
        # A missing job is already clean; a missing owner in an existing job is not.
        if os.path.lexists(payload['context'].get('workDir', '')):
            raise ValueError('临时传输目录凭据缺失，未执行清理')
        return None
    try:
        remove_contents(work, True)
        if not same(identity, os.stat(folder, dir_fd=parent, follow_symlinks=False)):
            raise RuntimeError('临时目录发生变化，已停止清理')
        os.unlink('.owner', dir_fd=work)
        os.rmdir(folder, dir_fd=parent)
        return None
    finally:
        os.close(work)
        os.close(parent)

print(FRAME + ':READY', flush=True)
try:
    line = sys.stdin.buffer.readline(MAX_REQUEST + 1)
    if len(line) > MAX_REQUEST or not line.endswith(b'\n'):
        raise ValueError('打包传输请求过长或不完整')
    request = json.loads(line)
    operations = {'prepare': prepare, 'pack': pack, 'extract': extract, 'cleanup': cleanup}
    if request.get('op') not in operations:
        raise ValueError('不支持的打包传输操作')
    result = operations[request['op']](request['payload'])
    emit('RESULT', {'ok': True, 'value': result})
except Exception as error:
    emit('RESULT', {'ok': False, 'error': str(error), 'code': type(error).__name__})
`;

function checkedPath(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > 65536) throw new Error('路径不能为空，也不能包含 NUL 字符或超过长度限制');
  return value;
}

function checkedName(value: string): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[/\\\0\r\n]/.test(value)) throw new Error('打包传输需要有效的文件名，不能选择根目录');
  return value;
}

function checkedContext(context: RemoteArchiveContext): RemoteArchiveContext {
  if (!context || !/^[a-f0-9]{64}$/.test(context.token)) throw new Error('临时传输目录凭据无效');
  const directory = checkedPath(context.directory), workDir = checkedPath(context.workDir), archivePath = checkedPath(context.archivePath);
  if (!posix.isAbsolute(directory) || posix.normalize(directory) !== directory
    || workDir !== posix.join(directory, `.gooeshell-archive-${context.token}`)
    || archivePath !== posix.join(workDir, 'payload.tar.gz')) throw new Error('临时传输目录不属于当前任务');
  return { directory, workDir, archivePath, token: context.token };
}

function cancelled(): Error { return Object.assign(new Error('操作已取消'), { name: 'AbortError' }); }
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

async function runArchive<T>(client: Client, op: string, payload: Record<string, unknown>, onProgress?: (progress: RemoteArchiveProgress) => void, signal?: AbortSignal, operationTimeoutMs?: number): Promise<T> {
  if (signal?.aborted) throw cancelled();
  const request = JSON.stringify({ op, payload }) + '\n';
  if (Buffer.byteLength(request) > 256 * 1024) throw new Error('打包传输请求过长');
  const frame = `GOOESHELL_ARCHIVE_${randomBytes(18).toString('hex')}`;
  const command = `python3 -I -u -c ${shellQuote(REMOTE_ARCHIVE_PYTHON)} ${frame}`;
  return new Promise<T>((resolve, reject) => {
    let channel: ClientChannel | undefined;
    let settled = false, sentRequest = false, aborting = false, stdout = '', stderr = '';
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let stopReason: Error | undefined;
    // Only startup is timed: a large archive may legitimately take hours.
    let timer = setTimeout(() => finish(new Error('远程打包功能启动超时，请检查服务器连接')), 30_000);
    const stop = (reason: Error) => {
      if (settled || aborting) return;
      aborting = true;
      stopReason = reason;
      if (!channel) return finish(reason);
      try { channel.signal('TERM'); } catch { /* Close below if the server cannot signal. */ }
      // Wait for Python to unwind before the caller starts deleting its staging directory.
      abortTimer = setTimeout(() => {
        try { channel?.signal('KILL'); } catch { /* Peer may already be closed. */ }
        try { channel?.close(); } catch { /* Peer may already be closed. */ }
        finish(reason);
      }, 5000);
    };
    const abort = () => stop(cancelled());
    const transportClosed = () => finish(stopReason ?? new Error('SSH 连接已断开，打包传输已停止'));
    client.once('close', transportClosed);
    signal?.addEventListener('abort', abort, { once: true });
    function finish(error?: Error, value?: T) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(abortTimer);
      client.removeListener('close', transportClosed);
      signal?.removeEventListener('abort', abort);
      if (error && channel && !aborting) {
        try { channel.signal('TERM'); } catch { /* Peer may already be closed. */ }
        try { channel.close(); } catch { /* Peer may already be closed. */ }
      }
      if (error) reject(error); else resolve(value!);
    }
    client.exec(command, { pty: false }, (error, stream) => {
      if (error) return finish(error);
      channel = stream;
      if (settled) { try { stream.signal('TERM'); } catch {} stream.close(); return; }
      stream.on('error', (error: Error) => finish(stopReason ?? error));
      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf8');
        if (stderr.length > 65536) finish(new Error('服务器错误信息超过大小限制'));
      });
      stream.on('data', (data: Buffer) => {
        if (settled) return;
        stdout += data.toString('ascii');
        if (!sentRequest) {
          const ready = `${frame}:READY\n`, position = stdout.indexOf(ready);
          if (position < 0) {
            if (stdout.length > 65536) finish(new Error('服务器启动输出超过大小限制'));
            return;
          }
          sentRequest = true;
          clearTimeout(timer);
          if (operationTimeoutMs !== undefined) timer = setTimeout(() => stop(new Error('远程打包准备超时，已停止本次传输')), operationTimeoutMs);
          stdout = stdout.slice(position + ready.length);
          stream.end(request);
        }
        // Bound each buffered frame, not the lifetime output of a long-running job.
        let newline: number;
        while (!settled && (newline = stdout.indexOf('\n')) >= 0) {
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          if (line.length > 65536) return finish(new Error('远程打包响应超过大小限制'));
          try {
            const prefix = `${frame}:`, progressPrefix = `${prefix}PROGRESS:`, resultPrefix = `${prefix}RESULT:`;
            const isProgress = line.startsWith(progressPrefix);
            if (!isProgress && !line.startsWith(resultPrefix)) throw new Error('无效响应');
            const encoded = line.slice((isProgress ? progressPrefix : resultPrefix).length);
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('无效编码');
            const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
            if (isProgress) {
              if (![value.done, value.total, value.entries].every(number => Number.isSafeInteger(number) && number >= 0)) throw new Error('无效进度');
              if (!aborting) onProgress?.(value);
            } else if (aborting) finish(stopReason);
            else if (value.ok === true) finish(undefined, value.value);
            else if (value.ok === false && typeof value.error === 'string') finish(value.code === 'InterruptedError' ? cancelled() : new Error(value.code === 'PermissionError' ? '权限不足，无法在所选目录执行打包传输' : value.error));
            else throw new Error('无效结果');
          } catch { finish(new Error('服务器返回的打包传输结果无法解析')); }
        }
        if (stdout.length > 65536) finish(new Error('远程打包响应超过大小限制'));
      });
      stream.on('close', (code: number | null) => {
        if (!settled) finish(stopReason ?? new Error(/python3[^\n]*(not found|command not found)/i.test(stderr) ? '服务器未安装 Python 3，打包传输需要 python3' : `远程打包传输未返回完整结果${code == null ? '' : `（退出码 ${code}）`}`));
      });
    });
  });
}

export function prepareRemoteArchive(client: Client, options: { directory?: string; name?: string } = {}, signal?: AbortSignal): Promise<RemoteArchiveContext> {
  if (signal?.aborted) return Promise.reject(cancelled());
  const payload = { ...(options.directory === undefined ? {} : { directory: checkedPath(options.directory) }), token: randomBytes(32).toString('hex'), ...(options.name === undefined ? {} : { name: checkedName(options.name) }) };
  // Finish allocating before observing cancellation so callers always receive the
  // ownership context and can clean the just-created job in their finally block.
  return runArchive<RemoteArchiveContext>(client, 'prepare', payload, undefined, undefined, 15_000).then(value => {
    const context = checkedContext(value);
    if (context.token !== payload.token) throw new Error('服务器返回的临时目录凭据不匹配');
    return context;
  });
}

export function packRemoteArchive(client: Client, options: { source: string; context: RemoteArchiveContext }, onProgress?: (progress: RemoteArchiveProgress) => void, signal?: AbortSignal): Promise<RemoteArchivePacked> {
  return runArchive<RemoteArchivePacked>(client, 'pack', { source: checkedPath(options.source), context: checkedContext(options.context) }, onProgress, signal).then(value => {
    checkedName(value?.name);
    if (![value.total, value.entries, value.archiveSize].every(size => Number.isSafeInteger(size) && size >= 0)
      || value.entries < 1 || value.entries > 50000 || value.archiveSize < 1) throw new Error('服务器返回的压缩包信息无效');
    return value;
  });
}

export function extractRemoteArchive(client: Client, options: { context: RemoteArchiveContext; expectedName: string; total?: number }, onProgress?: (progress: RemoteArchiveProgress) => void, signal?: AbortSignal): Promise<RemoteArchiveExtracted> {
  if (options.total !== undefined && (!Number.isSafeInteger(options.total) || options.total < 0)) throw new Error('原始文件大小无效');
  return runArchive<RemoteArchiveExtracted>(client, 'extract', { context: checkedContext(options.context), expectedName: checkedName(options.expectedName), ...(options.total === undefined ? {} : { total: options.total }) }, onProgress, signal).then(value => {
    if (!value || value.destination !== posix.join(options.context.directory, options.expectedName)
      || ![value.total, value.entries].every(size => Number.isSafeInteger(size) && size >= 0)
      || value.entries < 1 || value.entries > 50000 || options.total !== undefined && value.total !== options.total) throw new Error('服务器返回的解压结果无效');
    return value;
  });
}

export async function cleanupRemoteArchive(client: Client, context: RemoteArchiveContext): Promise<void> {
  await runArchive(client, 'cleanup', { context: checkedContext(context) }, undefined, AbortSignal.timeout(10_000));
}
