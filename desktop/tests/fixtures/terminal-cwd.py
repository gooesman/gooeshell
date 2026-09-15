"""Disposable Linux PTY trees; the real /proc query never reaches a user's SSH server."""
import base64
import ctypes
import json
import multiprocessing
import os
import pty
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

HELPER = sys.stdin.read()
ROOT = tempfile.mkdtemp(prefix='gooeshell-cwd-test-')
SOCKET = 'gooeshell-test-' + uuid.uuid4().hex

def worker(pipe, initial):
    # Emulate only the OpenSSH connection parent; PTYs, shell job control, proc
    # identities, independent exec processes and tmux are the actual Linux ones.
    ctypes.CDLL(None).prctl(15, b'sshd', 0, 0, 0)
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(initial)
        os.environ['TERM'] = 'xterm-256color'
        os.environ['PS1'] = 'fixture> '
        os.execvp('bash', ['bash', '--noprofile', '--norc'])
    extra = None
    def drain():
        while select.select([master], [], [], 0)[0]:
            try:
                os.read(master, 65536)
            except OSError:
                break
    time.sleep(.15)
    pipe.send(True)
    try:
        while True:
            action, value = pipe.recv()
            if action == 'exit':
                break
            if action == 'input':
                os.write(master, value.encode())
                time.sleep(.2)
                drain()
                pipe.send(True)
            elif action == 'probe':
                result = subprocess.run(['python3', '-I', '-c', HELPER, 'FIXTURE'], capture_output=True, timeout=6, check=True)
                line = next(line for line in result.stdout.decode().splitlines() if line.startswith('FIXTURE:'))
                pipe.send(json.loads(base64.b64decode(line.split(':', 1)[1])))
            elif action == 'ambiguous':
                second, extra = pty.fork()
                if second == 0:
                    os.execvp('bash', ['bash', '--noprofile', '--norc'])
                time.sleep(.1)
                pipe.send(True)
    finally:
        if extra is not None:
            os.close(extra)
        os.close(master)
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass

def tmux(*args):
    return subprocess.run(['tmux', '-L', SOCKET, '-f', '/dev/null', *args], stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, check=True, timeout=5).stdout.strip()

def send(pipe, action, value=None):
    pipe.send((action, value))
    assert pipe.poll(8), 'fixture response timed out: ' + action
    return pipe.recv()

workers = []
try:
    folders = [os.path.join(ROOT, name) for name in ('first', 'second', 'changed', 'split')]
    for folder in folders:
        os.mkdir(folder)
    connections = []
    for initial in folders[:2]:
        local, remote = multiprocessing.Pipe()
        child = multiprocessing.Process(target=worker, args=(remote, initial))
        child.start()
        workers.append((child, local))
        assert local.poll(5) and local.recv()
        connections.append(local)
    first, second = connections
    assert send(first, 'probe') == {'ok': True, 'value': {'path': folders[0], 'source': 'shell'}}
    assert send(second, 'probe') == {'ok': True, 'value': {'path': folders[1], 'source': 'shell'}}
    send(first, 'input', 'cd -- ' + folders[2] + '\r')
    assert send(first, 'probe')['value']['path'] == folders[2]
    assert send(second, 'probe')['value']['path'] == folders[1]
    tmux('new-session', '-d', '-s', 'one', '-c', folders[0], 'bash --noprofile --norc')
    tmux('new-session', '-d', '-s', 'two', '-c', folders[1], 'bash --noprofile --norc')
    send(first, 'input', 'tmux -L ' + SOCKET + ' attach-session -t one\r')
    send(second, 'input', 'tmux -L ' + SOCKET + ' attach-session -t two\r')
    for pipe, folder in [(first, folders[0]), (second, folders[1])]:
        actual = send(pipe, 'probe')
        assert actual == {'ok': True, 'value': {'path': folder, 'source': 'tmux'}}, (actual, tmux('list-clients', '-F', '#{client_pid}\t#{client_tty}\t#{pane_pid}\t#{client_session}'))
    tmux('split-window', '-t', 'one', '-c', folders[3], 'bash --noprofile --norc')
    time.sleep(.1)
    assert send(first, 'probe')['value']['path'] == folders[3]
    assert send(second, 'probe')['value']['path'] == folders[1]
    tmux('select-pane', '-t', 'one:0.0')
    assert send(first, 'probe')['value']['path'] == folders[0]
    tmux('detach-client', '-s', 'one')
    send(first, 'input', '')
    # A nested SSH foreground process must not masquerade as the outer shell cwd.
    fake_ssh = os.path.join(ROOT, 'nested.py')
    with open(fake_ssh, 'w') as target:
        target.write("import ctypes,time;ctypes.CDLL(None).prctl(15,b'ssh',0,0,0);time.sleep(20)")
    send(first, 'input', 'python3 ' + fake_ssh + '\r')
    assert '另一层终端' in send(first, 'probe')['error']
    send(first, 'input', '\x03')
    send(first, 'ambiguous')
    assert '唯一识别' in send(first, 'probe')['error']
    print(json.dumps({'shell': True, 'separateConnections': True, 'tmux': True, 'activePane': True, 'nestedSsh': True, 'ambiguousPty': True}))
finally:
    subprocess.run(['tmux', '-L', SOCKET, 'kill-server'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for child, pipe in workers:
        if child.is_alive():
            pipe.send(('exit', None))
        child.join(3)
        if child.is_alive():
            child.terminate()
            child.join(3)
    absolute = os.path.realpath(ROOT)
    assert os.path.dirname(absolute) == tempfile.gettempdir() and os.path.basename(absolute).startswith('gooeshell-cwd-test-')
    shutil.rmtree(absolute)
