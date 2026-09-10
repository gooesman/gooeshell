import { randomBytes } from 'node:crypto';
import type { Client, ClientChannel } from 'ssh2';

const MAX_TEXT = 2 * 1024 * 1024;
const MAX_WIRE = MAX_TEXT * 8 + 128 * 1024;
const operations = new Set(['list', 'read', 'write', 'chmod', 'run', 'mkdir', 'rename']);

/** Fixed program: paths and contents arrive only over stdin, never in shell source. */
export const REMOTE_HELPER_PYTHON = String.raw`
import base64, errno, json, os, secrets, selectors, signal, stat, subprocess, sys, time

MAX_TEXT = 2 * 1024 * 1024
MAX_WIRE = MAX_TEXT * 8 + 128 * 1024
FRAME = sys.argv[1]

def interrupted(signum, frame):
    raise InterruptedError('操作已取消')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGHUP, interrupted)

def path_value(value):
    if not isinstance(value, str) or not value or '\0' in value:
        raise ValueError('路径不能为空，也不能包含 NUL 字符')
    if len(value.encode('utf-8')) > 65536:
        raise ValueError('路径过长')
    return os.path.abspath(value)

def parent_handle(path, elevated):
    path = path_value(path)
    parent, name = os.path.split(path)
    if not name:
        raise ValueError('此操作不能以文件系统根目录作为目标')
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, 'O_CLOEXEC', 0)
    if not elevated:
        return os.open(parent, flags), name, path
    # Pin every ancestor. Root writes must not traverse a user-controlled symlink.
    if not hasattr(os, 'O_NOFOLLOW') or os.open not in os.supports_dir_fd:
        raise RuntimeError('服务器不支持安全的目录句柄操作，不能执行提权写入')
    fd = os.open('/', flags | os.O_NOFOLLOW)
    try:
        for component in parent.split('/'):
            if component:
                next_fd = os.open(component, flags | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = next_fd
        return fd, name, path
    except BaseException:
        os.close(fd)
        raise

def open_target(path, elevated, allow_directory=False):
    parent, name, absolute = parent_handle(path, elevated)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) and not (allow_directory and stat.S_ISDIR(info.st_mode)):
            os.close(fd)
            raise ValueError('仅支持普通文件' + ('或目录' if allow_directory else ''))
        return fd, info, absolute
    finally:
        os.close(parent)

def listing(path):
    path = os.path.realpath(path_value(path))
    entries, encoded_size = [], 0
    with os.scandir(path) as directory:
        for entry in directory:
            info = entry.stat(follow_symlinks=False)
            kind = 'symlink' if stat.S_ISLNK(info.st_mode) else ('directory' if stat.S_ISDIR(info.st_mode) else 'file')
            item = {'name': entry.name, 'path': os.path.join(path, entry.name), 'type': kind,
                    'size': info.st_size, 'modified': int(info.st_mtime * 1000),
                    'mode': stat.S_IMODE(info.st_mode), 'owner': str(info.st_uid), 'group': str(info.st_gid)}
            encoded_size += len(json.dumps(item, ensure_ascii=False).encode('utf-8'))
            if encoded_size > MAX_TEXT:
                raise ValueError('目录信息超过 2 MiB，请进入更小的子目录')
            entries.append(item)
    entries.sort(key=lambda entry: (entry['type'] != 'directory', entry['name'].casefold()))
    return {'path': path, 'entries': entries}

def read_text(path):
    fd, info, _ = open_target(path, False)
    with os.fdopen(fd, 'rb') as source:
        data = source.read(MAX_TEXT + 1)
    truncated = len(data) > MAX_TEXT
    data = data[:MAX_TEXT]
    if b'\0' in data:
        raise ValueError('文件包含二进制内容，不能作为文本编辑')
    try:
        # A truncated preview may end between UTF-8 code units.
        import codecs
        text = codecs.getincrementaldecoder('utf-8')('strict').decode(data, final=not truncated)
    except UnicodeDecodeError:
        raise ValueError('文本不是 UTF-8 编码，首版编辑器暂不支持此编码')
    return {'text': text, 'truncated': truncated}

def write_text(path, text, elevated):
    if not isinstance(text, str) or '\0' in text:
        raise ValueError('请输入不含 NUL 字符的文本')
    data = text.encode('utf-8')
    if len(data) > MAX_TEXT:
        raise ValueError('文本写入不能超过 2 MiB')
    parent, name, _ = parent_handle(path, elevated)
    temporary = '.gooeshell-edit-' + secrets.token_hex(16)
    created = False
    try:
        try:
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(before.st_mode):
                raise ValueError('拒绝写入符号链接或非普通文件')
        except FileNotFoundError:
            before = None
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        created = True
        with os.fdopen(fd, 'wb') as target:
            target.write(data)
            target.flush()
            if before:
                current = os.fstat(target.fileno())
                if current.st_uid != before.st_uid or current.st_gid != before.st_gid:
                    os.fchown(target.fileno(), before.st_uid, before.st_gid)
                os.fchmod(target.fileno(), stat.S_IMODE(before.st_mode))
            os.fsync(target.fileno())
        try:
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            current = None
        if bool(current) != bool(before) or (before and (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino)):
            raise RuntimeError('保存期间目标发生变化，未覆盖目标，请重新打开')
        os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        created = False
        os.fsync(parent)
    finally:
        if created:
            os.unlink(temporary, dir_fd=parent)
        os.close(parent)

def chmod_target(path, mode, elevated):
    if isinstance(mode, bool) or not isinstance(mode, int) or mode < 0 or mode > 0o777:
        raise ValueError('权限必须在 000 至 777 之间，不能添加特殊权限位')
    fd, info, _ = open_target(path, elevated, True)
    try:
        os.fchmod(fd, (stat.S_IMODE(info.st_mode) & 0o7000) | mode)
    finally:
        os.close(fd)

def limit_text(data):
    text = data.decode('utf-8', errors='replace')
    return text.encode('utf-8')[:MAX_TEXT].decode('utf-8', errors='ignore')

def run_file(path, make_executable, elevated, timeout_ms):
    fd, info, absolute = open_target(path, elevated)
    changed = False
    mode = stat.S_IMODE(info.st_mode)
    try:
        if make_executable and not mode & stat.S_IXUSR:
            os.fchmod(fd, mode | stat.S_IXUSR)
            changed = True
            mode = stat.S_IMODE(os.fstat(fd).st_mode)
        first = os.read(fd, 4096)
        if not first.startswith(b'#!'):
            return {'output': '脚本缺少 #! 解释器声明；请添加 shebang 后再运行。', 'exitCode': 126,
                    'permissionsChanged': changed, 'mode': mode, 'executionStarted': False}
        if not mode & 0o111:
            return {'output': '文件没有执行权限。选择“添加用户执行权限并运行”后重试。', 'exitCode': 126,
                    'permissionsChanged': changed, 'mode': mode, 'executionStarted': False}
        # Execute directly so the kernel selects the shebang interpreter and $0
        # remains the real script path (scripts often locate resources via dirname).
        # Never interpolate the path or contents into a shell command.
        current = os.stat(absolute, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise RuntimeError('脚本在运行前发生变化，请重新选择')
        prefix = '权限：已仅添加所有者执行位 u+x。\n' if changed else ''
        process = None
        captured = bytearray()
        reason = None
        try:
            process = subprocess.Popen([absolute],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                cwd=os.path.dirname(absolute), start_new_session=True)
            deadline = time.monotonic() + timeout_ms / 1000
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        reason = '运行超时，已终止本次脚本。'
                        break
                    if not selector.select(min(remaining, 0.2)):
                        continue
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    room = MAX_TEXT - 1024 - len(captured)
                    captured.extend(chunk[:max(0, room)])
                    if len(chunk) > room:
                        reason = '输出达到 2 MiB 上限，已终止本次脚本。'
                        break
            if not reason:
                try:
                    process.wait(timeout=max(0.01, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    reason = '运行超时，已终止本次脚本。'
            if reason:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            code = process.wait()
            code = (124 if '超时' in reason else 125) if reason else (code if code >= 0 else 128 - code)
            output = prefix + limit_text(bytes(captured)) + ('\n' + reason if reason else '')
            return {'output': limit_text(output.encode('utf-8')), 'exitCode': code,
                    'permissionsChanged': changed, 'mode': mode, 'executionStarted': True}
        except OSError as error:
            return {'output': prefix + '运行失败：' + str(error), 'exitCode': 126,
                    'permissionsChanged': changed, 'mode': mode, 'executionStarted': False}
        finally:
            if process:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                if process.stdout:
                    process.stdout.close()
    finally:
        os.close(fd)

def operate(request):
    op, payload = request['op'], request['payload']
    elevated = request.get('elevated', False)
    path = path_value(payload.get('path'))
    if op == 'list':
        return listing(path)
    if op == 'read':
        return read_text(path)
    if op == 'write':
        return write_text(path, payload.get('text'), elevated)
    if op == 'chmod':
        return chmod_target(path, payload.get('mode'), elevated)
    if op == 'run':
        return run_file(path, payload.get('makeExecutable') is True, elevated, request['timeoutMs'])
    if op == 'mkdir':
        parent, name, _ = parent_handle(path, elevated)
        try:
            os.mkdir(name, 0o755, dir_fd=parent)
        finally:
            os.close(parent)
        return None
    if op == 'rename':
        source, name, _ = parent_handle(path, elevated)
        destination = None
        try:
            destination, new_name, _ = parent_handle(payload.get('destination'), elevated)
            # Linux renameat2 RENAME_NOREPLACE is atomic and supports files/directories.
            import ctypes
            libc = ctypes.CDLL(None, use_errno=True)
            rename = getattr(libc, 'renameat2', None)
            if rename is None:
                raise RuntimeError('服务器缺少不覆盖重命名支持，未改动文件')
            rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            rename.restype = ctypes.c_int
            if rename(source, os.fsencode(name), destination, os.fsencode(new_name), 1) != 0:
                code = ctypes.get_errno()
                raise OSError(code, os.strerror(code))
        finally:
            os.close(source)
            if destination is not None:
                os.close(destination)
        return None
    raise ValueError('不支持的远程操作')

sys.stdout.write(FRAME + ':READY\n')
sys.stdout.flush()
try:
    request_line = sys.stdin.buffer.readline(MAX_WIRE + 1)
    if len(request_line) > MAX_WIRE or not request_line.endswith(b'\n'):
        raise ValueError('请求超过大小限制或数据不完整')
    request = json.loads(request_line)
    result = {'ok': True, 'value': operate(request)}
except Exception as error:
    result = {'ok': False, 'error': str(error), 'code': type(error).__name__}
encoded = json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
sys.stdout.write(FRAME + ':RESULT:' + base64.b64encode(encoded).decode('ascii') + '\n')
sys.stdout.flush()
`;

export interface RemoteOperationOptions {
  elevated?: boolean;
  sudoPassword?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export async function runRemoteOperation(
  client: Client,
  op: string,
  payload: Record<string, unknown>,
  options: RemoteOperationOptions = {},
): Promise<any> {
  if (!operations.has(op)) throw new Error('不支持的远程操作');
  for (const key of ['path', ...(op === 'rename' ? ['destination'] : [])]) {
    if (typeof payload[key] !== 'string' || !payload[key] || payload[key].includes('\0')) {
      throw new Error('路径不能为空，也不能包含 NUL 字符');
    }
  }
  if (op === 'write' && (typeof payload.text !== 'string' || payload.text.includes('\0') || Buffer.byteLength(payload.text) > MAX_TEXT)) {
    throw new Error('文本写入必须是不含 NUL 字符、大小不超过 2 MiB 的文本');
  }
  if (op === 'chmod' && (!Number.isInteger(payload.mode) || (payload.mode as number) < 0 || (payload.mode as number) > 0o777)) {
    throw new Error('权限必须在 000 至 777 之间，不能添加特殊权限位');
  }
  if (options.sudoPassword?.includes('\n') || options.sudoPassword?.includes('\r') || options.sudoPassword?.includes('\0')) {
    throw new Error('sudo 密码不能包含换行或 NUL 字符');
  }
  if (options.signal?.aborted) throw Object.assign(new Error('操作已取消'), { name: 'AbortError' });
  const timeoutMs = Math.max(1000, Math.min(120_000, options.timeoutMs ?? (op === 'run' ? 60_000 : 30_000)));
  // Keep credentials out even if a caller accidentally passes an entire UI request.
  const cleanPayload: Record<string, unknown> = { path: payload.path };
  const extraFields: Record<string, string> = { write: 'text', chmod: 'mode', run: 'makeExecutable', rename: 'destination' };
  const extraField = extraFields[op];
  if (extraField) cleanPayload[extraField] = payload[extraField];
  const request = JSON.stringify({ op, payload: cleanPayload, elevated: !!options.elevated, timeoutMs }) + '\n';
  if (Buffer.byteLength(request) > MAX_WIRE) throw new Error('请求超过大小限制');
  const frame = `GOOESHELL_${randomBytes(18).toString('hex')}`;
  const prompt = `GOOESHELL_SUDO_${randomBytes(18).toString('hex')}:`;
  const python = `python3 -I -u -c ${shellQuote(REMOTE_HELPER_PYTHON)} ${frame}`;
  const command = options.elevated ? `sudo -S -p ${shellQuote(prompt)} -- ${python}` : python;

  return new Promise((resolve, reject) => {
    let channel: ClientChannel | undefined;
    let password = options.sudoPassword;
    let settled = false;
    let sentRequest = false;
    let sentPassword = false;
    let stdout = '';
    let stderr = '';
    let received = 0;
    const ready = `${frame}:READY\n`;
    const resultPrefix = `${frame}:RESULT:`;
    const timer = setTimeout(() => finish(new Error('远程操作超时；请检查服务器连接或 sudo 配置')), timeoutMs + 3000);
    const abort = () => finish(Object.assign(new Error('操作已取消'), { name: 'AbortError' }));
    options.signal?.addEventListener('abort', abort, { once: true });

    function finish(error?: Error, value?: any) {
      if (settled) return;
      settled = true;
      password = undefined;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error && channel) {
        try { channel.signal('TERM'); } catch { /* Peer may not support signal requests. */ }
        try { channel.close(); } catch { /* Already closed. */ }
      }
      if (error) reject(error); else resolve(value === null ? undefined : value);
    }

    function remoteError(exitCode?: number | null): Error {
      // Never expose the raw sudo prompt or password. stderr is diagnostic only;
      // authentication input is never sent to helper JSON or child process stdin.
      if (/requiretty|must have a tty|terminal is required|no tty present/i.test(stderr)) {
        return new Error('服务器 sudo 要求交互终端（requiretty），当前按次提权不支持此配置');
      }
      if (/python3[^\n]*(not found|command not found)|(?:not found|command not found)[^\n]*python3/i.test(stderr)) {
        return new Error('服务器未安装 Python 3；文件操作需要 python3，无需安装 gooeshell 服务');
      }
      if (options.elevated && /sudo[^\n]*(not found|command not found)/i.test(stderr)) return new Error('服务器未安装 sudo');
      if (options.elevated && !sentRequest) return new Error('sudo 提权失败：请核对密码及当前用户的 sudo 权限');
      return new Error(`远程操作未返回完整结果${exitCode == null ? '' : `（退出码 ${exitCode}）`}`);
    }

    client.exec(command, { pty: false }, (error, stream) => {
      if (error) return finish(error);
      channel = stream;
      if (settled) { stream.close(); return; }
      stream.on('error', (error: Error) => finish(error));
      stream.stderr.on('data', (data: Buffer) => {
        if (settled) return;
        stderr += data.toString('utf8');
        if (Buffer.byteLength(stderr) > 65536) return finish(new Error('服务器错误信息超过大小限制'));
        const position = stderr.indexOf(prompt);
        if (options.elevated && position >= 0) {
          stderr = stderr.slice(0, position) + stderr.slice(position + prompt.length);
          if (sentPassword) return finish(new Error('sudo 密码未被接受，本次操作已停止'));
          if (password === undefined) return finish(new Error('SUDO_PASSWORD_REQUIRED：此操作需要输入 sudo 密码'));
          sentPassword = true;
          stream.write(password + '\n');
          password = undefined;
        }
      });
      stream.on('data', (data: Buffer) => {
        if (settled) return;
        received += data.length;
        if (received > MAX_WIRE) return finish(new Error('远程输出超过大小限制'));
        stdout += data.toString('ascii');
        if (!sentRequest) {
          // Some login shells print a banner even for noninteractive exec. Only
          // the unpredictable helper READY marker permits sending request data.
          const position = stdout.indexOf(ready);
          if (position < 0) {
            if (stdout.length > 65536) return finish(new Error('服务器启动输出超过大小限制'));
            return;
          }
          sentRequest = true;
          password = undefined;
          stdout = stdout.slice(position + ready.length);
          stream.end(request);
        }
        if (stdout.length && !stdout.startsWith(resultPrefix) && !resultPrefix.startsWith(stdout)) {
          return finish(new Error('服务器返回了无效的文件操作数据'));
        }
        const end = stdout.indexOf('\n');
        if (end < 0) return;
        try {
          const encoded = stdout.slice(resultPrefix.length, end);
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('无效响应编码');
          const result = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
          if (result.ok === true) finish(undefined, result.value);
          else if (result.ok === false && typeof result.error === 'string') finish(new Error(result.error));
          else finish(new Error('服务器返回了无效的文件操作结果'));
        } catch { finish(new Error('服务器返回的文件操作结果无法解析')); }
      });
      stream.on('close', (code: number | null) => { if (!settled) finish(remoteError(code)); });
    });
  });
}
