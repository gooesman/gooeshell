import { randomBytes } from 'node:crypto';
import type { Client, ClientChannel } from 'ssh2';

export interface TerminalDirectory { path: string; source: 'shell' | 'tmux' }

/** Observes the PTY belonging to this SSH transport. It never writes to the terminal. */
export const TERMINAL_CWD_PYTHON = String.raw`
import base64, json, os, stat, subprocess, sys, time

class Unsupported(Exception):
    pass

def process(pid):
    try:
        with open('/proc/%d/stat' % pid, 'r') as source:
            text = source.read(8192)
        left, right = text.index('('), text.rindex(')')
        fields = text[right + 2:].split()
        return {'pid': pid, 'comm': text[left + 1:right], 'ppid': int(fields[1]),
                'pgrp': int(fields[2]), 'sid': int(fields[3]), 'tty': int(fields[4]),
                'foreground': int(fields[5]), 'started': fields[19]}
    except (OSError, ValueError, IndexError):
        return None

def children(pid):
    try:
        with open('/proc/%d/task/%d/children' % (pid, pid), 'r') as source:
            return [int(value) for value in source.read(32768).split()]
    except (OSError, ValueError):
        return []

def descendants(pid):
    found, pending, visited = [], children(pid), {pid}
    while pending:
        child = pending.pop()
        if child in visited:
            continue
        visited.add(child)
        if len(visited) > 512:
            raise Unsupported('当前终端进程过多，暂时无法可靠识别目录')
        info = process(child)
        if info:
            found.append(info)
            pending.extend(children(child))
    return found

def connection_process():
    # The exec probe and the interactive PTY must descend from the same
    # unprivileged OpenSSH connection process, never a global sshd parent.
    pid = os.getpid()
    for _ in range(12):
        info = process(pid)
        if not info:
            break
        if info['comm'] in ('sshd', 'sshd-session'):
            return pid
        if info['ppid'] <= 1 or info['ppid'] == pid:
            break
        pid = info['ppid']
    raise Unsupported('此服务器暂不支持自动跟随；需要 Linux、OpenSSH 和可读取的 /proc')

def same_process(info):
    current = process(info['pid'])
    return current and current['started'] == info['started'] and current['tty'] == info['tty']

def terminal_process():
    if sys.platform != 'linux' or not os.path.isdir('/proc'):
        raise Unsupported('此服务器暂不支持自动跟随；目前支持 Linux OpenSSH')
    family = descendants(connection_process())
    leaders = [item for item in family if item['tty'] and item['sid'] == item['pid']]
    # tmux panes may remain descendants of a newly started tmux server. Only
    # a PTY leader with no PTY-bearing ancestor in this connection is ours.
    by_id = {item['pid']: item for item in family}
    roots = []
    for item in leaders:
        ancestor, nested, visited = item['ppid'], False, set()
        while ancestor in by_id and ancestor not in visited:
            visited.add(ancestor)
            if by_id[ancestor]['tty']:
                nested = True
                break
            ancestor = by_id[ancestor]['ppid']
        if not nested:
            roots.append(item)
    if len(roots) != 1:
        raise Unsupported('无法唯一识别此连接的终端目录；已停止跟随，避免跳到其他终端')
    leader = roots[0]
    foreground = [item for item in family if item['pid'] == leader['foreground']
                  and item['tty'] == leader['tty'] and item['sid'] == leader['sid']]
    if len(foreground) != 1 or not same_process(leader):
        raise Unsupported('终端正在切换前台进程，请稍后重新开启跟随')
    return foreground[0]

def cwd(info):
    try:
        result = os.readlink('/proc/%d/cwd' % info['pid'])
    except OSError:
        raise Unsupported('无法读取当前终端目录；当前进程可能已退出或权限不足')
    if not result.startswith('/') or result.endswith(' (deleted)') or not same_process(info):
        raise Unsupported('当前终端目录已失效，请切换到有效目录后重试')
    return result

def tmux_sockets(info):
    candidates, directories = [], ['/tmp']
    try:
        with open('/proc/%d/environ' % info['pid'], 'rb') as source:
            values = source.read(65536).split(b'\0')
        env = {}
        for value in values:
            name, _, data = value.partition(b'=')
            if name in (b'TMUX', b'TMUX_TMPDIR'):
                env[name] = os.fsdecode(data)
        if env.get(b'TMUX'):
            candidates.append(env[b'TMUX'].rsplit(',', 2)[0])
        if env.get(b'TMUX_TMPDIR', '').startswith('/'):
            directories.insert(0, env[b'TMUX_TMPDIR'])
    except OSError:
        pass
    try:
        with open('/proc/%d/cmdline' % info['pid'], 'rb') as source:
            args = [os.fsdecode(arg) for arg in source.read(65536).split(b'\0') if arg]
        for index, arg in enumerate(args[:-1]):
            if arg == '-S' and args[index + 1].startswith('/'):
                candidates.insert(0, args[index + 1])
    except OSError:
        pass
    for directory in directories:
        folder = os.path.join(directory, 'tmux-%d' % os.getuid())
        candidates.append(os.path.join(folder, 'default'))
        try:
            with os.scandir(folder) as entries:
                for index, entry in enumerate(entries):
                    if index >= 32:
                        break
                    if stat.S_ISSOCK(entry.stat(follow_symlinks=False).st_mode):
                        candidates.append(entry.path)
        except OSError:
            pass
    return list(dict.fromkeys(value for value in candidates if value.startswith('/')))[:36]

def tmux_directory(info):
    deadline = time.monotonic() + 2.0
    tty = None
    for fd in (0, 1, 2):
        try:
            candidate = os.readlink('/proc/%d/fd/%d' % (info['pid'], fd))
            if candidate.startswith('/dev/pts/') or candidate.startswith('/dev/tty'):
                tty = candidate
                break
        except OSError:
            pass
    if not tty:
        raise Unsupported('无法识别当前 tmux 客户端的终端设备')
    for socket in tmux_sockets(info):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            # Explicit client PID AND tty prevent following another tab's pane.
            result = subprocess.run(['tmux', '-S', socket, 'list-clients', '-F',
                '#{client_pid}|#{client_tty}|#{pane_pid}'], stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=min(.35, remaining),
                check=False, env={**os.environ, 'LC_ALL': 'C'})
            if result.returncode or len(result.stdout) > 65536:
                continue
            matches = []
            for line in result.stdout.decode('utf-8', 'replace').splitlines():
                fields = line.split('|')
                if len(fields) == 3 and fields[0] == str(info['pid']) and fields[1] == tty and fields[2].isdigit():
                    matches.append(int(fields[2]))
            if len(matches) != 1 or not same_process(info):
                continue
            pane = process(matches[0])
            if not pane:
                continue
            # Follow the pane's foreground shell (including a nested shell), not
            # just the directory in which tmux originally created the pane.
            front = process(pane['foreground'])
            if not front or front['tty'] != pane['tty'] or front['sid'] != pane['sid']:
                continue
            if front['comm'].startswith('tmux') or front['comm'] in ('ssh', 'mosh-client', 'telnet'):
                raise Unsupported('当前 tmux 面板内还连接了另一层终端，暂不支持继续跟随')
            return {'path': cwd(front), 'source': 'tmux'}
        except (OSError, subprocess.TimeoutExpired):
            continue
    raise Unsupported('无法定位此终端的 tmux 活动面板；请检查 tmux socket 或改用手动浏览')

def detect():
    info = terminal_process()
    if info['comm'].startswith('tmux'):
        return tmux_directory(info)
    if info['comm'] in ('ssh', 'mosh-client', 'telnet', 'screen'):
        raise Unsupported('当前终端内还连接了另一层终端，暂不支持自动跟随')
    return {'path': cwd(info), 'source': 'shell'}

def main():
    try:
        response = {'ok': True, 'value': detect()}
    except Unsupported as error:
        response = {'ok': False, 'error': str(error)}
    except BaseException:
        response = {'ok': False, 'error': '服务器暂时无法读取终端目录，请稍后重新开启跟随'}
    encoded = base64.b64encode(json.dumps(response, ensure_ascii=True).encode('ascii')).decode('ascii')
    print(sys.argv[1] + ':' + encoded, flush=True)

if __name__ == '__main__':
    main()
`;

export function readTerminalDirectory(client: Client, signal?: AbortSignal, timeoutMs = 5000): Promise<TerminalDirectory> {
  const marker = `GOOESHELL_CWD_${randomBytes(18).toString('hex')}`;
  const encoded = Buffer.from(TERMINAL_CWD_PYTHON, 'utf8').toString('base64');
  const command = `python3 -I -u -c 'import base64;exec(compile(base64.b64decode("${encoded}"),"<gooeshell-cwd>","exec"))' ${marker}`;
  return new Promise((resolve, reject) => {
    let stream: ClientChannel | undefined, finished = false, output = '', received = 0;
    const close = () => { try { stream?.close(); } catch { /* Channel is already gone. */ } };
    const finish = (error?: Error, value?: TerminalDirectory) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      if (error) { close(); reject(error); } else resolve(value!);
    };
    const aborted = () => finish(new Error('连接已关闭，目录跟随已停止'));
    const timer = setTimeout(() => finish(new Error('读取终端目录超时；目录跟随已停止')), timeoutMs);
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    try {
      client.exec(command, { pty: false }, (error, channel) => {
        if (error) { finish(new Error('此服务器无法查询终端目录：' + error.message)); return; }
        stream = channel;
        if (finished) { close(); return; }
        channel.on('error', () => finish(new Error('读取终端目录的通道已断开')));
        channel.stderr.on('data', (data: Buffer) => {
          received += data.length;
          if (received > 128 * 1024) finish(new Error('服务器目录查询输出过多，已停止跟随'));
        });
        channel.on('data', (data: Buffer) => {
          if (finished) return;
          received += data.length;
          if (received > 128 * 1024) { finish(new Error('服务器目录查询输出过多，已停止跟随')); return; }
          output += data.toString('ascii');
          const start = output.indexOf(marker + ':');
          if (start < 0) return;
          const end = output.indexOf('\n', start);
          if (end < 0) return;
          try {
            const payload = output.slice(start + marker.length + 1, end).trim();
            if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new Error('invalid base64');
            const response = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
            if (response.ok === false && typeof response.error === 'string') {
              finish(new Error(response.error.slice(0, 1000))); return;
            }
            const value = response.value;
            if (response.ok !== true || !value || typeof value.path !== 'string' || !value.path.startsWith('/') ||
                value.path.includes('\0') || value.path.length > 65536 || !['shell', 'tmux'].includes(value.source)) throw new Error('invalid result');
            finish(undefined, { path: value.path, source: value.source });
          } catch { finish(new Error('服务器返回的终端目录无效，已停止跟随')); }
        });
        channel.on('close', () => { if (!finished) finish(new Error('此服务器暂不支持目录跟随；需要 Linux、OpenSSH、Python 3 和可读取的 /proc')); });
        channel.end();
      });
    } catch { finish(new Error('无法建立目录查询通道')); }
  });
}
