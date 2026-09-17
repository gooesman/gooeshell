import { randomBytes } from 'node:crypto';
import type { Client, ClientChannel } from 'ssh2';
import { canonicalPublicKey } from './local-keys';

/** Append under an advisory lock: existing bytes/options are never rewritten or relaxed. */
export const INSTALL_PUBLIC_KEY_PYTHON = String.raw`
import base64, fcntl, json, os, pwd, shlex, stat, struct, sys, time

def install(public_key):
    fields = public_key.split()
    if len(fields) != 2 or len(public_key) > 32768:
        raise ValueError('公钥格式无效')
    kind, blob = fields
    raw = base64.b64decode(blob, validate=True)
    length = struct.unpack('>I', raw[:4])[0]
    if raw[4:4+length].decode('ascii') != kind:
        raise ValueError('公钥类型不匹配')
    uid = os.geteuid()
    home = pwd.getpwuid(uid).pw_dir
    home_fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    directory = target = None
    try:
        home_info = os.fstat(home_fd)
        if home_info.st_uid != uid or home_info.st_mode & 0o022:
            raise ValueError('用户主目录所有者或权限不安全，请先修复主目录权限')
        try:
            os.mkdir('.ssh', 0o700, dir_fd=home_fd)
        except FileExistsError:
            pass
        directory = os.open('.ssh', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=home_fd)
        if os.fstat(directory).st_uid != uid:
            raise ValueError('.ssh 不属于当前登录用户，未修改')
        os.fchmod(directory, 0o700)
        target = os.open('authorized_keys', os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
        deadline = time.monotonic() + 10
        while True:
            try:
                fcntl.flock(target, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError('授权文件正在被其他操作使用，请稍后重试')
                time.sleep(0.05)
        before = os.fstat(target)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != uid or before.st_nlink != 1:
            raise ValueError('authorized_keys 必须是当前用户拥有的普通文件，不能是链接')
        if before.st_size > 4 * 1024 * 1024:
            raise ValueError('authorized_keys 超过 4 MiB，请手动检查')
        data = b''
        while True:
            chunk = os.read(target, 65536)
            if not chunk:
                break
            data += chunk
            if len(data) > 4 * 1024 * 1024:
                raise ValueError('授权文件过大或正在变化，请稍后重试')
        duplicate = False
        for line in data.decode('utf-8', errors='surrogateescape').splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            try:
                tokens = shlex.split(line, comments=False, posix=True)
            except ValueError:
                # Do not risk relaxing an existing restricted key on an ambiguous malformed line.
                if blob in line:
                    raise ValueError('已有相同公钥的条目格式不明确，请手动检查授权文件')
                continue
            for index in (0, 1):
                if len(tokens) > index + 1 and tokens[index] == kind:
                    try:
                        stored = tokens[index+1]
                        if base64.b64decode(stored + '=' * (-len(stored) % 4), validate=True) == raw:
                            duplicate = True
                    except (ValueError, TypeError):
                        pass
        current = os.stat('authorized_keys', dir_fd=directory, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError('授权文件在操作期间被替换，请重试')
        os.fchmod(target, 0o600)
        if not duplicate:
            suffix = (b'\n' if data and not data.endswith(b'\n') else b'') + public_key.encode('ascii') + b' gooeshell\n'
            if os.write(target, suffix) != len(suffix):
                raise ValueError('公钥追加未完成，请检查授权文件后重试')
            os.fsync(target)
        return {'installed': True, 'alreadyPresent': duplicate}
    finally:
        for fd in (target, directory, home_fd):
            if fd is not None:
                os.close(fd)

if __name__ == '__main__':
    frame = sys.argv[1]
    try:
        request = json.loads(sys.stdin.readline(65537))
        result = {'ok': True, 'value': install(request['publicKey'])}
    except Exception as error:
        result = {'ok': False, 'error': str(error)}
    print(frame + ':' + base64.b64encode(json.dumps(result).encode('utf-8')).decode('ascii'), flush=True)
`;

export function installPublicKey(client: Client, publicKey: string, signal: AbortSignal): Promise<{ installed: true; alreadyPresent: boolean }> {
  const canonical = canonicalPublicKey(publicKey).publicKey;
  const frame = `GOOESHELL_KEY_${randomBytes(16).toString('hex')}`;
  const script = Buffer.from(INSTALL_PUBLIC_KEY_PYTHON).toString('base64');
  const command = `python3 -c 'import base64;exec(compile(base64.b64decode("${script}"),"<gooeshell-key>","exec"))' ${frame}`;
  return new Promise((resolve, reject) => {
    let channel: ClientChannel | undefined, settled = false, output = '', errors = '';
    const finish = (error?: Error, value?: { installed: true; alreadyPresent: boolean }) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancelled);
      client.removeListener('close', closed); client.removeListener('error', failed);
      channel?.close(); error ? reject(error) : resolve(value!);
    };
    const cancelled = () => { channel?.signal('TERM'); finish(new Error('KEY_PUSH_CANCELLED: 已取消公钥推送')); };
    const closed = () => finish(new Error('公钥推送连接已关闭，可能已写入；重试会自动去重'));
    const failed = (error: Error) => finish(error);
    const timer = setTimeout(() => { channel?.signal('TERM'); finish(new Error('公钥安装超时，请检查服务器是否支持 Python 3')); }, 30_000);
    timer.unref();
    if (signal.aborted) { cancelled(); return; }
    signal.addEventListener('abort', cancelled, { once: true });
    client.once('close', closed); client.once('error', failed);
    client.exec(command, { pty: false }, (error, stream) => {
      if (settled) { stream?.close(); return; }
      if (error) { finish(error); return; }
      channel = stream;
      stream.on('error', failed);
      stream.on('data', (bytes: Buffer) => {
        output += bytes.toString('utf8');
        if (output.length > 128 * 1024) { finish(new Error('服务器响应过大')); return; }
        const match = output.split(/\r?\n/).find(line => line.startsWith(`${frame}:`));
        if (!match) return;
        try {
          const result = JSON.parse(Buffer.from(match.slice(frame.length + 1), 'base64').toString('utf8'));
          if (!result.ok) throw new Error(`公钥安装失败：${String(result.error)}`);
          if (result.value?.installed !== true || typeof result.value.alreadyPresent !== 'boolean') throw new Error('公钥安装返回无效结果');
          finish(undefined, result.value);
        } catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
      });
      stream.stderr.on('data', (bytes: Buffer) => { errors = (errors + bytes.toString('utf8')).slice(-4096); });
      stream.on('close', () => finish(new Error(errors.includes('python3') ? '服务器需要 Python 3 才能安全安装公钥，请先安装后重试' : '服务器未返回公钥安装结果，请检查 Python 3 与目录权限')));
      stream.end(JSON.stringify({ publicKey: canonical }) + '\n');
    });
  });
}
