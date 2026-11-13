"""POSIX, per-user managed task fallback. Payloads containing sudo secrets use stdin only."""
import json
import os
import selectors
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid

LIMIT = 2 * 1024 * 1024
KEEP = 1024 * 1024
READ_LIMIT = 8192


def task_id(value):
    parsed = uuid.UUID(value, version=4)
    if str(parsed) != value:
        raise ValueError('后台任务编号无效')
    return value


def private_dir(parent, name, create):
    path = os.path.join(parent, name)
    if create:
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            pass
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('后台任务目录权限不安全，请检查后重试')
    return path


def task_path(task, create=False):
    home = os.path.expanduser('~')
    root = private_dir(home, '.gooeshell', create)
    root = private_dir(root, 'tasks', create)
    task = task_id(task)
    if create:
        os.mkdir(os.path.join(root, task), 0o700)
    return private_dir(root, task, False)


def write_json(path, value):
    temp = path + '.tmp'
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False)
    os.replace(temp, path)


def send_ready(fd, text):
    try:
        os.write(fd, (text + '\n').encode())
    except OSError:
        pass
    finally:
        os.close(fd)


def feed_secret(stream, secret):
    try:
        stream.write((secret + '\n').encode('utf-8'))
        stream.flush()
    except (BrokenPipeError, OSError, ValueError):
        pass
    finally:
        try:
            stream.close()
        except OSError:
            pass


def stop_group(pid, elevated, password, sig):
    if not elevated:
        os.killpg(pid, sig)
        return
    helper = 'import os,signal,sys;os.killpg(int(sys.argv[1]),int(sys.argv[2]))'
    args = ['sudo', '-n' if password is None else '-S']
    if password is not None:
        args += ['-p', '']
    args += ['--', sys.executable, '-c', helper, str(pid), str(int(sig))]
    result = subprocess.run(args, input=None if password is None else (password + '\n').encode(),
                            stdin=subprocess.DEVNULL if password is None else None,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
    if result.returncode:
        raise RuntimeError('无法使用 sudo 停止任务，请检查权限或凭据')


def supervise(payload, directory, ready_fd):
    listener = None
    control_dir = None
    child = None
    try:
        os.setsid()
        null = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(null, fd)
        if null > 2:
            os.close(null)
        os.umask(0o077)
        control_dir = tempfile.mkdtemp(prefix='gooeshell-task-', dir='/tmp')
        control = os.path.join(control_dir, 'control')
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(control)
        os.chmod(control, 0o600)
        listener.listen(4)
        listener.setblocking(False)
        secret = payload.pop('password', None)
        elevated = payload['sudo']
        args = ['/bin/sh', '-c', payload['script']]
        if elevated:
            args = ['sudo', '-n' if secret is None else '-S'] + ([] if secret is None else ['-p', '']) + ['--'] + args
        child = subprocess.Popen(args, stdin=subprocess.PIPE if elevated and secret is not None else subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
        if elevated and secret is not None:
            threading.Thread(target=feed_secret, args=(child.stdin, secret), daemon=True).start()
        secret = None
        metadata = {'version': 1, 'taskId': payload['taskId'], 'control': control, 'sudo': elevated}
        write_json(os.path.join(directory, 'meta.json'), metadata)
        log = open(os.path.join(directory, 'output.log'), 'w+b', buffering=0)
        os.chmod(log.name, 0o600)
        selector = selectors.DefaultSelector()
        selector.register(listener, selectors.EVENT_READ, 'control')
        selector.register(child.stdout, selectors.EVENT_READ, 'output')
        send_ready(ready_fd, 'READY')
        ready_fd = None
        log_error = False
        deadline = None
        stop_password = None
        while True:
            for key, _ in selector.select(0.2):
                if key.data == 'output':
                    data = os.read(child.stdout.fileno(), 65536)
                    if not data:
                        selector.unregister(child.stdout)
                    elif not log_error:
                        try:
                            log.seek(0, os.SEEK_END)
                            if log.tell() + len(data) > LIMIT:
                                log.seek(-min(KEEP, log.tell()), os.SEEK_END)
                                tail = log.read()
                                log.seek(0)
                                log.write(tail)
                                log.truncate()
                            log.seek(0, os.SEEK_END)
                            log.write(data)
                        except OSError:
                            log_error = True
                else:
                    conn, _ = listener.accept()
                    with conn:
                        try:
                            conn.settimeout(3)
                            data = b''
                            while b'\n' not in data and len(data) <= 262144:
                                part = conn.recv(4096)
                                if not part:
                                    break
                                data += part
                            request = json.loads(data)
                            if request.get('action') == 'status':
                                reply = {'state': 'running'}
                            elif request.get('action') == 'stop':
                                stop_password = request.get('password')
                                stop_group(child.pid, elevated, stop_password, signal.SIGTERM)
                                deadline = time.monotonic() + 3
                                reply = {'requested': True}
                            else:
                                raise RuntimeError('未知任务操作')
                        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                            reply = {'error': str(error)}
                        try:
                            conn.sendall((json.dumps(reply) + '\n').encode())
                        except OSError:
                            pass
            if deadline is not None and time.monotonic() >= deadline:
                try:
                    stop_group(child.pid, elevated, stop_password, signal.SIGKILL)
                except (OSError, RuntimeError, subprocess.SubprocessError):
                    pass
                stop_password = None
                deadline = None
            code = child.poll()
            if code is not None:
                # Drain data already in the pipe without waiting for detached descendants.
                os.set_blocking(child.stdout.fileno(), False)
                while True:
                    try:
                        data = os.read(child.stdout.fileno(), 65536)
                    except BlockingIOError:
                        break
                    if not data:
                        break
                    if not log_error:
                        try:
                            log.seek(0, os.SEEK_END)
                            log.write(data)
                        except OSError:
                            log_error = True
                result = {'version': 1, 'exitCode': code if code >= 0 else 128 - code,
                          'signal': signal.Signals(-code).name if code < 0 else None, 'logError': log_error}
                write_json(os.path.join(directory, 'result.json'), result)
                break
        log.close()
    except BaseException:
        if ready_fd is not None:
            send_ready(ready_fd, 'ERROR')
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except OSError:
                pass
    finally:
        if listener is not None:
            listener.close()
        if control_dir:
            try:
                os.unlink(os.path.join(control_dir, 'control'))
                os.rmdir(control_dir)
            except OSError:
                pass


def communicate(control, payload):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(10)
        conn.connect(control)
        conn.sendall((json.dumps(payload) + '\n').encode())
        data = b''
        while b'\n' not in data and len(data) < 32768:
            part = conn.recv(4096)
            if not part:
                break
            data += part
    result = json.loads(data)
    if 'error' in result:
        raise RuntimeError(result['error'])
    return result


def read(task, lines, encoding):
    try:
        directory = task_path(task)
    except FileNotFoundError:
        sys.exit(42)
    with open(os.path.join(directory, 'meta.json'), encoding='utf-8') as stream:
        meta = json.load(stream)
    try:
        with open(os.path.join(directory, 'result.json'), encoding='utf-8') as stream:
            result = json.load(stream)
        state = 'exited'
    except FileNotFoundError:
        result = {'exitCode': None, 'signal': None}
        try:
            communicate(meta['control'], {'action': 'status'})
            state = 'running'
        except (OSError, ValueError, RuntimeError):
            # The supervisor may have written the result while its socket closed.
            try:
                with open(os.path.join(directory, 'result.json'), encoding='utf-8') as stream:
                    result = json.load(stream)
                state = 'exited'
            except FileNotFoundError:
                state = 'unknown'
    with open(os.path.join(directory, 'output.log'), 'rb') as stream:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        stream.seek(max(0, size - READ_LIMIT))
        text = stream.read().decode(encoding, errors='replace')
    split = text.splitlines()
    output = '\n'.join(split[-lines:])
    if result.get('logError'):
        output += '\n[日志写入失败，部分输出可能缺失]'
    print('GOOESHELL_PROCESS ' + json.dumps({'taskId': task, 'backend': 'process', 'sessionName': '',
          'windowId': '', 'paneId': '', 'state': state, 'exitCode': result['exitCode'], 'signal': result['signal'],
          'output': output, 'truncated': size > READ_LIMIT or len(split) > lines,
          'logPath': os.path.join(directory, 'output.log')}))


def main():
    action = sys.argv[1]
    if action == 'start':
        payload = json.loads(sys.stdin.buffer.readline(262144).decode('utf-8'))
        directory = task_path(payload['taskId'], True)
        read_fd, write_fd = os.pipe()
        pid = os.fork()
        if pid == 0:
            os.close(read_fd)
            supervise(payload, directory, write_fd)
            os._exit(0)
        os.close(write_fd)
        ready = os.read(read_fd, 256).decode().strip()
        os.close(read_fd)
        if ready != 'READY':
            raise RuntimeError('后台任务启动失败；请检查服务器权限及 Python 环境')
        print('GOOESHELL_PROCESS_STARTED')
    elif action == 'read':
        encoding = sys.argv[4] if len(sys.argv) > 4 else 'utf8'
        if encoding not in ('utf8', 'gb18030', 'big5'):
            raise ValueError('不支持的任务日志编码')
        read(task_id(sys.argv[2]), int(sys.argv[3]), encoding)
    elif action == 'stop':
        directory = task_path(task_id(sys.argv[2]))
        with open(os.path.join(directory, 'meta.json'), encoding='utf-8') as stream:
            meta = json.load(stream)
        password = json.loads(sys.stdin.buffer.readline(262144).decode('utf-8')).get('password')
        communicate(meta['control'], {'action': 'stop', 'password': password})
        print('GOOESHELL_PROCESS_STOP_REQUESTED')
    else:
        raise ValueError('未知任务操作')


try:
    main()
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
