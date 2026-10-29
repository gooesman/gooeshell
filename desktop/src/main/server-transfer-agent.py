"""Remote control helper. File payload travels only over the remote rsync SSH hop."""
import base64, ctypes, fcntl, hashlib, json, os, shutil, signal, stat, subprocess, sys, tempfile, time, shlex, queue, threading

PREFIX = 'GOOESHELL_REMOTE '

def send(value):
    print(PREFIX + json.dumps(value, ensure_ascii=True, separators=(',', ':')), flush=True)

class Agent:
    def __init__(self):
        self.temp = tempfile.mkdtemp(prefix='gooeshell-direct-')
        os.chmod(self.temp, 0o700)
        self.authorized = None
        self.lock = None
        self.process = None
        self.stage = None
        self.committed = False

    def emit(self, **value):
        send(dict(event=value))

    def run(self, args, timeout=15):
        return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=True).stdout.decode('utf-8', errors='replace')

    def tools(self, r):
        if sys.platform != 'linux': raise ValueError('服务器间传输首版需要 Linux 服务器')
        missing = [name for name in ('rsync', 'rrsync', 'ssh', 'ssh-keygen', 'ssh-keyscan') if not shutil.which(name)]
        if missing: raise ValueError('服务器缺少工具：' + ', '.join(missing))
        with open('/proc/sys/kernel/random/boot_id') as f: boot = f.read().strip()
        system = hashlib.sha256((boot+':'+str(os.stat('/proc/self/ns/mnt').st_ino)).encode()).hexdigest()
        return dict(ready=True, system=system)

    def entries(self, path):
        root = os.lstat(path)
        if stat.S_ISREG(root.st_mode): return [('', path, root)]
        if not stat.S_ISDIR(root.st_mode): raise ValueError('仅支持普通文件和目录，不传输链接、设备或管道')
        result = [('', path, root)]
        for parent, dirs, files in os.walk(path, followlinks=False):
            for name in sorted(dirs + files):
                if name == '.gooeshell-partial': raise ValueError('源目录包含保留名称 .gooeshell-partial')
                full = os.path.join(parent, name)
                s = os.lstat(full)
                if not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)): raise ValueError('源目录包含链接或特殊文件：' + full)
                result.append((os.path.relpath(full, path), full, s))
        return sorted(result, key=lambda x: x[0])

    def manifest(self, path, content=False):
        digest = hashlib.sha256()
        total = done = 0
        records = self.entries(path)
        total = sum(s.st_size for _, _, s in records if stat.S_ISREG(s.st_mode))
        last = 0
        for relative, full, s in records:
            directory = stat.S_ISDIR(s.st_mode)
            values = [relative, 'd' if directory else 'f']
            if content and not directory:
                h = hashlib.sha256()
                fd = os.open(full, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                try:
                    opened = os.fstat(fd)
                    if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns): raise ValueError('文件在校验前发生变化')
                    while True:
                        chunk = os.read(fd, 1024 * 1024)
                        if not chunk: break
                        h.update(chunk)
                        done += len(chunk)
                        if time.monotonic() - last > .2:
                            self.emit(stage='hash', done=done, total=total)
                            last = time.monotonic()
                    after = os.fstat(fd)
                    if (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (s.st_size, s.st_mtime_ns, s.st_ctime_ns): raise ValueError('文件在校验期间发生变化')
                finally: os.close(fd)
                values += [s.st_size, h.hexdigest()]
            elif not content:
                values += [s.st_dev, s.st_ino, s.st_size if not directory else 0, s.st_mtime_ns, s.st_ctime_ns]
            digest.update(json.dumps(values, ensure_ascii=True, separators=(',', ':')).encode() + b'\n')
        if content: self.emit(stage='hash', done=done, total=total)
        return dict(digest=digest.hexdigest(), total=total, directory=stat.S_ISDIR(records[0][2].st_mode), count=len(records))

    def inspect(self, r):
        path = os.path.abspath(r['path'])
        if path == '/' or os.path.islink(path): raise ValueError('不能传输根目录或链接')
        path = os.path.realpath(path)
        return dict(path=path, **self.manifest(path))

    def prepare(self, r):
        parent = os.path.realpath(r['destinationDir'])
        if not os.path.isdir(parent) or not os.access(parent, os.W_OK | os.X_OK): raise ValueError('目标目录不存在或没有写入权限')
        source = r.get('forbidSource')
        if source and (parent == source or parent.startswith(source+'/')): raise ValueError('同一服务器不能把目标放在源目录内部')
        name = r['name']
        if name in ('', '.', '..') or '/' in name or '\x00' in name: raise ValueError('目标名称无效')
        destination = os.path.join(parent, name)
        if os.path.lexists(destination): raise ValueError('目标已存在，未覆盖：' + destination)
        key = hashlib.sha256(json.dumps(r['identity'], sort_keys=True).encode()).hexdigest()[:32]
        self.stage = os.path.join(parent, '.gooeshell-transfer-' + key)
        try: os.mkdir(self.stage, 0o700)
        except FileExistsError: pass
        info = os.lstat(self.stage)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077: raise ValueError('断点目录所有者或权限无效')
        fd = os.open(os.path.join(self.stage, 'lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception: os.close(fd); raise ValueError('同一路径已有传输任务，请先停止它')
        self.lock = fd
        meta = os.path.join(self.stage, 'metadata.json')
        expected = dict(identity=r['identity'], snapshot=r['snapshot'])
        try:
            with open(meta, 'x', encoding='utf-8') as f: json.dump(expected, f)
        except FileExistsError:
            fdmeta = os.open(meta, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fdmeta, encoding='utf-8') as f:
                if json.load(f) != expected: raise ValueError('源文件已变化，旧断点不能复用；请移除该断点目录后重试：' + self.stage)
        if shutil.disk_usage(parent).free < max(0, r['total'] - self.payload_size()): raise ValueError('目标磁盘可用空间不足')
        payload = os.path.join(self.stage, 'payload')
        if r['directory'] and not os.path.exists(payload): os.mkdir(payload, 0o700)
        self.destination = destination
        return dict(stage=self.stage, payload=payload, destination=destination, resume=self.payload_size()>0)

    def payload_size(self):
        total = 0
        for parent, _, files in os.walk(self.stage):
            for name in files:
                if parent == self.stage and name in ('lock','metadata.json'): continue
                p = os.path.join(parent, name)
                if not os.path.islink(p): total += os.stat(p).st_size
        return total

    def key(self, r):
        self.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', os.path.join(self.temp, 'key')])
        with open(os.path.join(self.temp, 'key.pub')) as f: return dict(publicKey=' '.join(f.read().split()[:2]))

    def probe(self, r):
        host, port = r['host'], int(r['port'])
        if not host or host.startswith('-') or any(c in host for c in '\x00\r\n'): raise ValueError('直传地址无效')
        output = self.run(['ssh-keyscan', '-T', '4', '-p', str(port), host], timeout=8)
        for line in output.splitlines():
            fields = line.split()
            if len(fields) != 3: continue
            try: fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(base64.b64decode(fields[2], validate=True)).digest()).decode().rstrip('=')
            except Exception: continue
            if fingerprint == r['fingerprint']:
                with open(os.path.join(self.temp, 'known_hosts'), 'w') as f: f.write('gooeshell-transfer ' + fields[1] + ' ' + fields[2] + '\n')
                return dict(reachable=True)
        raise ValueError('远端不可达，或直传地址的 SSH 指纹与当前连接不同')

    def authorized_file(self):
        home = os.path.expanduser('~')
        hs = os.stat(home)
        if hs.st_uid != os.geteuid() or hs.st_mode & 0o022: raise ValueError('用户主目录所有者或权限不安全')
        directory = os.path.join(home, '.ssh')
        try: os.mkdir(directory, 0o700)
        except FileExistsError: pass
        d = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            ds = os.fstat(d)
            if ds.st_uid != os.geteuid() or ds.st_mode & 0o022: raise ValueError('.ssh 所有者或权限不安全')
            fd = os.open('authorized_keys', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=d)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
                s = os.fstat(fd)
                current = os.stat('authorized_keys', dir_fd=d, follow_symlinks=False)
                if not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or s.st_nlink != 1 or s.st_size > 4*1024*1024 or (current.st_dev,current.st_ino)!=(s.st_dev,s.st_ino): raise ValueError('authorized_keys 所有者、文件类型或路径无效')
                return fd,d
            except BaseException: os.close(fd); raise
        except BaseException: os.close(d); raise

    def read_keys(self, fd):
        chunks = []
        while True:
            data = os.read(fd, 65536)
            if not data: break
            chunks.append(data)
            if sum(map(len,chunks)) > 4*1024*1024: raise ValueError('authorized_keys 过大')
        return b''.join(chunks)

    def write_all(self, fd, data):
        remaining = memoryview(data)
        while remaining:
            written = os.write(fd, remaining)
            if written <= 0: raise OSError('authorized_keys 写入未完成')
            remaining = remaining[written:]

    def authorize(self, r):
        fields = r['publicKey'].split()
        if len(fields) != 2 or fields[0] != 'ssh-ed25519': raise ValueError('临时公钥无效')
        base64.b64decode(fields[1], validate=True)
        marker = 'GooeShell-transfer-' + r['taskId']
        if len(marker) != 55 or any(c not in 'abcdef0123456789-' for c in r['taskId']): raise ValueError('传输编号无效')
        expires = int(time.time()) + 86400
        expiry = time.strftime('%Y%m%d%H%M%SZ', time.gmtime(expires))
        argv = [shutil.which('rrsync'), '-ro' if r['readOnly'] else '-wo', '-no-del', os.path.realpath(r['root'])]
        # The expiry guard is independent of sshd's expiry-time support.
        guard = 'import os,sys,time; time.time()<' + str(expires) + ' or sys.exit(1); os.execv(' + repr(argv[0]) + ',' + repr(argv) + ')'
        forced = shlex.join([sys.executable, '-c', guard]).replace('\\', '\\\\').replace('"', '\\"')
        line = 'restrict,expiry-time="' + expiry + '",command="' + forced + '" ' + ' '.join(fields) + ' ' + marker + '\n'
        fd, directory = self.authorized_file()
        self.authorized = marker
        try:
            data = self.read_keys(fd)
            os.lseek(fd, 0, os.SEEK_END)
            self.write_all(fd, (('' if not data or data.endswith(b'\n') else '\n') + line).encode())
            os.fsync(fd)
        finally: os.close(fd); os.close(directory)
        return dict(authorized=True, expires=expires)

    def revoke(self, r=None):
        if not self.authorized: return dict(revoked=True)
        fd, directory = self.authorized_file()
        temporary = '.gooeshell-key-cleanup-' + os.urandom(16).hex()
        try:
            before = os.fstat(fd)
            data = self.read_keys(fd)
            marker = b' ' + self.authorized.encode()
            kept = b''.join(line for line in data.splitlines(keepends=True) if not line.rstrip(b'\r\n').endswith(marker))
            if kept != data:
                # Write and sync a replacement before the atomic rename. An I/O
                # error must not truncate unrelated authorized keys.
                replacement = os.open(temporary, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, stat.S_IMODE(before.st_mode), dir_fd=directory)
                try:
                    if os.fstat(replacement).st_gid != before.st_gid: os.fchown(replacement, before.st_uid, before.st_gid)
                    for name in os.listxattr(fd):
                        value = os.getxattr(fd,name)
                        try: current = os.getxattr(replacement,name)
                        except OSError: current = None
                        if current != value: os.setxattr(replacement,name,value)
                    os.fchmod(replacement, stat.S_IMODE(before.st_mode))
                    self.write_all(replacement, kept)
                    os.fsync(replacement)
                finally: os.close(replacement)
                after = os.fstat(fd)
                current = os.stat('authorized_keys', dir_fd=directory, follow_symlinks=False)
                if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or (current.st_dev,current.st_ino)!=(before.st_dev,before.st_ino): raise ValueError('authorized_keys 在撤销期间发生变化，请检查临时授权')
                os.replace(temporary, 'authorized_keys', src_dir_fd=directory, dst_dir_fd=directory)
                os.fsync(directory)
            self.authorized = None
        finally:
            try: os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError: pass
            os.close(fd); os.close(directory)
        return dict(revoked=True)

    def transfer(self, r):
        host = r['host']
        if host.startswith('-') or any(c in host for c in '\x00\r\n'): raise ValueError('直传地址无效')
        ssh = ['ssh', '-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'ClearAllForwardings=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlias=gooeshell-transfer', '-o', 'UserKnownHostsFile='+os.path.join(self.temp, 'known_hosts'), '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', '-i', os.path.join(self.temp, 'key'), '-p', str(r['port']), '-l', r['username']]
        remote = ('['+host+']' if ':' in host else host) + ':' + r['remotePath']
        pair = [remote, r['localPath']] if r['pull'] else [r['localPath'], remote]
        args = ['rsync', '-rlt', '--partial', '--partial-dir=.gooeshell-partial', '--info=progress2', '--outbuf=L', '--no-motd', '-e', shlex.join(ssh)]
        if r.get('resume'): args.append('--checksum')
        if r.get('dryRun'): args.append('--dry-run')
        args += ['--'] + pair
        env = dict(os.environ, LC_ALL='C', RSYNC_RSH='', RSYNC_PROTECT_ARGS='0')
        self.process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, start_new_session=True)
        pending = b''
        tail = ''
        try:
            while True:
                chunk = os.read(self.process.stdout.fileno(), 4096)
                if not chunk: break
                pending += chunk
                while b'\r' in pending or b'\n' in pending:
                    split = min(i for i in (pending.find(b'\r'), pending.find(b'\n')) if i >= 0)
                    text, pending = pending[:split].decode('utf-8', errors='replace'), pending[split+1:]
                    tail = (tail + text + '\n')[-4096:]
                    fields = text.split()
                    if not r.get('dryRun') and len(fields) >= 4 and fields[0].replace(',', '').isdigit() and fields[1].endswith('%'):
                        unit = fields[2]
                        speed = 0
                        for suffix, scale in [('GB/s', 1e9), ('MB/s', 1e6), ('kB/s', 1e3), ('B/s', 1)]:
                            if unit.endswith(suffix):
                                try: speed = float(unit[:-len(suffix)]) * scale
                                except ValueError: pass
                                break
                        self.emit(stage='transfer', done=int(fields[0].replace(',', '')), bytesPerSecond=speed)
            code = self.process.wait()
            if code != 0: raise ValueError('rsync 失败（退出码 '+str(code)+'）：' + (tail + pending.decode('utf-8', errors='replace'))[-2048:])
            return dict(transferred=True)
        finally:
            self.stop_process()

    def stop_process(self):
        p = self.process
        if p:
            try:
                # Let rsync tell its SSH peer to preserve partial files before
                # closing the transport. Killing ssh simultaneously loses that handshake.
                if p.poll() is None: p.send_signal(signal.SIGINT)
                try: p.wait(timeout=3)
                except subprocess.TimeoutExpired: os.killpg(p.pid, signal.SIGKILL); p.wait()
            except ProcessLookupError: pass
            self.process = None

    def hash(self, r):
        before = self.manifest(r['path'])
        value = self.manifest(r['path'], content=True)
        after = self.manifest(r['path'])
        if before != after or (r.get('snapshot') and after['digest'] != r['snapshot']): raise ValueError('源文件在传输或校验期间发生变化，未提交目标')
        return value

    def commit(self, r):
        if not self.stage: raise ValueError('没有准备目标目录')
        # Linux renameat2(RENAME_NOREPLACE): never overwrite a concurrently created destination.
        libc = ctypes.CDLL(None, use_errno=True)
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        if rename(-100, os.fsencode(os.path.join(self.stage, 'payload')), -100, os.fsencode(self.destination), 1):
            raise OSError(ctypes.get_errno(), '目标提交失败，目标可能已经存在')
        self.committed = True
        return dict(destination=self.destination)

    def close(self):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        self.stop_process()
        try: self.revoke()
        finally:
            if self.lock is not None: os.close(self.lock); self.lock = None
            try:
                if self.committed and self.stage: shutil.rmtree(self.stage); self.stage = None
            finally:
                if os.path.exists(self.temp): shutil.rmtree(self.temp)

    def finish(self, r):
        self.close()
        return dict(cleaned=True)

def main():
    agent = Agent()
    def interrupted(*_):
        # A simultaneous SSH EOF and explicit cancel must not interrupt cleanup.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    requests = queue.Queue()
    ended = threading.Event()
    def receive():
        try:
            for line in sys.stdin: requests.put(line)
        finally:
            ended.set()
            requests.put(None)
            # EOF must stop an in-progress rsync/hash too, not just the next RPC.
            os.kill(os.getpid(), signal.SIGTERM)
    threading.Thread(target=receive, daemon=True).start()
    try:
        while not ended.is_set():
            line = requests.get()
            if line is None: break
            r = json.loads(line)
            try:
                if r['op'] not in ('tools','inspect','prepare','key','probe','authorize','revoke','transfer','hash','commit','finish'): raise ValueError('未知操作')
                value = getattr(agent, r['op'])(r)
                send(dict(id=r['id'], value=value))
            except (Exception, KeyboardInterrupt) as e:
                send(dict(id=r['id'], error=str(e) or '传输已停止'))
                if isinstance(e, KeyboardInterrupt): break
    except (KeyboardInterrupt, BrokenPipeError): pass
    finally:
        agent.close()

if __name__ == '__main__': main()
