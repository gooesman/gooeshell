"""One disposable tmux socket behind a real Linux PTY; test data on stdin as JSON."""
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios

socket_name = sys.argv[1]
if not socket_name.startswith('gooeshell-test-') or not socket_name.replace('-', '').isalnum():
    raise ValueError('An isolated test socket is required')
columns, rows = int(sys.argv[2]), int(sys.argv[3])
pid, master = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.environ['LC_ALL'] = 'C.UTF-8'
    os.environ.pop('TMUX', None)
    os.execvp('tmux', ['tmux', '-L', socket_name, '-f', '/dev/null',
        'new-session', '-s', 'gooeshell-test', 'bash --noprofile --norc',
        ';', 'set-option', '-g', 'default-command', 'bash --noprofile --norc'])

def resize(cols, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

resize(columns, rows)
pending = b''
try:
    while True:
        readable, _, _ = select.select([master, 0], [], [], 30)
        if not readable:
            break
        if master in readable:
            try:
                output = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not output:
                break
            os.write(1, output)
        if 0 in readable:
            incoming = os.read(0, 65536)
            if not incoming:
                break
            pending += incoming
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                packet = json.loads(line)
                if 'input' in packet:
                    data = base64.b64decode(packet['input'])
                    while data:
                        count = os.write(master, data)
                        data = data[count:]
                elif 'resize' in packet:
                    resize(*packet['resize'])
finally:
    # -L identifies only this test's server; never touches the user's default server.
    subprocess.run(['tmux', '-L', socket_name, 'kill-server'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.close(master)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
