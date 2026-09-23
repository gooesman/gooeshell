"""Run only isolated, temporary HOME shells; never touch the user's dotfiles."""
import json
import os
import pathlib
import pty
import re
import select
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import base64
import fcntl
import struct
import termios

request = json.load(sys.stdin)
checks = []
bash = request.get('bash', '/bin/bash')
version = re.search(r'version (\d+)\.(\d+)', subprocess.check_output([bash, '--version'], text=True))
prompt_arrays = (int(version[1]), int(version[2])) >= (5, 1)

class Shell:
    def __init__(self, rc='', launcher=None, default_shell=None):
        launcher = launcher or bash
        default_shell = default_shell or bash
        self.temp = tempfile.TemporaryDirectory(prefix='gooeshell-shell-marks-')
        pathlib.Path(self.temp.name, '.bashrc').write_text("PS1='fixture> '\nHISTFILE=/dev/null\n" + rc)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
            os.environ.update(HOME=self.temp.name, SHELL=default_shell, TERM='xterm-256color', LC_ALL='C.UTF-8')
            for name in ['BASH_ENV', 'ENV', 'PROMPT_COMMAND']:
                os.environ.pop(name, None)
            if launcher == bash:
                os.execl(launcher, 'bash', '--noprofile', '--norc', '-c', request['command'])
            os.execl(launcher, launcher, '-c', request['command'])
        self.buffer = b''

    def until(self, token=b'\x1b]133;B\x07', timeout=6):
        end = time.monotonic() + timeout
        while token not in self.buffer:
            if time.monotonic() >= end:
                raise AssertionError('shell prompt timeout: ' + repr(self.buffer))
            if select.select([self.fd], [], [], 0.1)[0]:
                self.buffer += os.read(self.fd, 65536)
        pos = self.buffer.index(token) + len(token)
        result, self.buffer = self.buffer[:pos], self.buffer[pos:]
        return result

    def run(self, command, status=0):
        os.write(self.fd, command.encode() + b'\n')
        result = self.until()
        statuses = re.findall(rb'\x1b\]133;D;([0-9]+)\x07', result)
        assert statuses == [str(status).encode()], (command, statuses, result)
        assert result.count(b'\x1b]133;C\x07') == 1, (command, result)
        return result

    def close(self):
        os.kill(self.pid, signal.SIGKILL)
        os.waitpid(self.pid, 0)
        os.close(self.fd)
        self.temp.cleanup()

if request.get('captureTranscripts'):
    replays = []
    pipeline = 'printf "pipeline\\n" | cat'
    wrapped = 'printf "%s\\n" "' + 'long-' * 20 + '" | cat'
    for name, rc, commands in [
        ('ignoreboth', 'HISTCONTROL=ignoreboth\n', [
            ('pwd', 'pwd', 'shell'), ('pwd', 'pwd', 'echo'),
            (pipeline, pipeline, 'shell'), (pipeline, pipeline, 'echo'),
            (' echo history-filtered', None, None),
        ]),
        ('history-disabled', 'set +o history\n', [
            ('pwd', 'pwd', 'echo'), (pipeline, pipeline, 'echo'),
            ('for n in a b; do\n printf "%s\\n" "$n"\ndone', None, None),
            (' echo intentionally-private', None, None),
        ]),
        ('histsize-zero', 'HISTSIZE=0\n', [
            ('pwd', 'pwd', 'echo'), (pipeline, pipeline, 'echo'),
            (' echo intentionally-private', None, None),
        ]),
        ('horizontal-scroll', "HISTCONTROL=ignoreboth\nbind 'set horizontal-scroll-mode on'\n", [
            (wrapped, wrapped, 'shell'), (wrapped, None, None),
        ]),
    ]:
        shell = Shell(rc)
        expected = []
        try:
            chunks = [shell.until()]
            for command, text, source in commands:
                data = shell.run(command)
                if name == 'horizontal-scroll':
                    assert b'\r<' in data, 'readline must actually erase the command prefix in this fixture'
                chunks.append(data)
                expected.append({'command': text, 'source': source})
            if name == 'horizontal-scroll':
                os.write(shell.fd, wrapped.encode())
                time.sleep(.05)
                os.write(shell.fd, b'\x01')
                time.sleep(.05)
                os.write(shell.fd, b'\n')
                # Readline may repaint A/B while editing; wait for completion D,
                # rather than confusing that redraw with the next ready prompt.
                data = shell.until(b'\x1b]133;D;0\x07') + shell.until()
                assert b'\x1b]633;E;' not in data
                assert re.search(rb'\x1b\]133;B\x07printf[^\r\n\x1b]*>', data), 'Home must leave the right end visibly clipped'
                chunks.append(data)
                expected.append({'command': None, 'source': None})
            secret = 'fixture-secret-never-collect-7419'
            password_command = 'read -rs -p "fixture-password: " password; printf "\\nread-done\\n"'
            os.write(shell.fd, password_command.encode() + b'\n')
            chunks.append(shell.until(b'\x1b]133;C\x07'))
            chunks.append(shell.until(b'fixture-password: '))
            # Only synthetic secret input; this does not connect to a real server.
            os.write(shell.fd, secret.encode() + b'\n')
            chunks.append(shell.until())
            expected.append({'command': password_command, 'source': 'shell' if name in ('ignoreboth', 'horizontal-scroll') else 'echo'})
            transcript = b''.join(chunks)
            assert secret.encode() not in transcript, 'read -rs must not echo the synthetic secret'
            assert transcript.count(b'\x1b]133;C\x07') == len(expected)
            replays.append({'name': name, 'cols': 80, 'rows': 24,
                            'transcript': base64.b64encode(transcript).decode(),
                            'expected': expected, 'secret': secret})
        finally:
            shell.close()
    print(json.dumps({'passed': True, 'bashVersion': version[0], 'replays': replays}))
    sys.exit(0)

shell = Shell()
try:
    initial = shell.until()
    assert b']133;D;' not in initial and b']133;C' not in initial, initial
    checks.append('initial prompt has no invented command')
    out = shell.run('echo hello')
    assert b'\x1b]633;E;echo hello\x07' in out and b'hello\r\n' in out, out
    shell.run('false', 1)
    out = shell.run('printf "previous=%s\\n" "$?"')
    assert b'previous=1\r\n' in out, out
    checks.append('echo, false and original exit status')
    out = shell.run('false | true')
    assert b'\x1b]633;E;false | true\x07' in out, out
    shell.run('set -o pipefail')
    shell.run('false | true', 1)
    checks.append('pipeline whole command and pipefail exit')
    out = shell.run('for n in a b; do\n  printf "%s\\n" "$n"\ndone')
    assert b'a\r\nb\r\n' in out and b']633;E;for n in a b' in out, out
    checks.append('multiline compound command emits one start and completion')
    out = shell.run("printf 'a;b\\nc\\n'")
    assert b'\\x3b' in out and b'\\\\n' in out, out
    checks.append('command text escapes protocol delimiters')
    shell.run('HISTCONTROL=ignorespace')
    out = shell.run(' echo filtered')
    assert b']633;E;' not in out, out
    checks.append('filtered history hides command text but retains position and status')
    shell.run('set +o history')
    out = shell.run('false | true', 1)
    assert b']633;E;' not in out, out
    shell.run('set -o history')
    shell.run('HISTCONTROL=ignoredups')
    shell.run('echo duplicate')
    out = shell.run('echo duplicate')
    assert b']633;E;' not in out, out
    checks.append('disabled history and duplicate filtering never copy a partial command')
    os.write(shell.fd, b'sleep 20\n')
    started = shell.until(b'\x1b]133;C\x07')
    os.write(shell.fd, b'\x03')
    out = shell.until()
    assert b'\x1b]133;D;130\x07' in out, out
    os.write(shell.fd, b'\x03')
    out = shell.until()
    assert b']133;D;' not in out, out
    shell.run('echo resumed')
    checks.append('Ctrl+C during command and at prompt preserve next command')
    os.write(shell.fd, b'\n')
    out = shell.until()
    assert b']133;D;' not in out and b']133;C' not in out, out
    # Do not offer a truncated command as if it were safe to copy verbatim.
    out = shell.run(': ' + 'x' * 8300)
    assert b']633;E;' not in out, out
    checks.append('empty input produces no command; oversized command text is not truncated')
    if request.get('tmux'):
        assert shutil.which('tmux'), 'tmux compatibility check was requested but tmux is unavailable'
        socket = 'gooeshell-marks-' + str(os.getpid())
        try:
            out = shell.run('tmux -L ' + socket + ' -f /dev/null new-session -s markers "printf inside-tmux; sleep 0.3"')
            assert b'\x1b[?1049h' in out and b'\x1b[?1049l' in out, out
            shell.run('echo after-tmux')
            checks.append('real private tmux enters/exits alternate screen and outer command completes once')
        finally:
            subprocess.run(['tmux', '-L', socket, 'kill-server'], capture_output=True)
finally:
    shell.close()

shell = Shell("PROMPT_COMMAND=('printf \"hook-status=%s\\\\n\" \"$?\"' 'PS1=\"custom> \"')\n")
try:
    shell.until()
    out = shell.run('false', 1)
    expected_prompt = b'custom> ' if prompt_arrays else b'fixture> '
    assert b'hook-status=1' in out and expected_prompt in out, out
    checks.append('existing PROMPT_COMMAND keeps the Bash version-specific array semantics')
finally:
    shell.close()

shell = Shell('PROMPT_COMMAND=\'printf "scalar-status=%s\\n" "$?"; PS1="scalar> "; # trailing comment\'\n')
try:
    shell.until()
    out = shell.run('false', 1)
    assert b'scalar-status=1' in out and b'scalar> ' in out, out
    checks.append('scalar PROMPT_COMMAND keeps exit status, dynamic prompt and trailing comments')
finally:
    shell.close()

shell = Shell("trap 'printf \"original-debug\\\\n\"' DEBUG\n")
try:
    out = shell.until(b'fixture> ')
    assert b'Command markers unavailable' in out and b']133;' not in out, out
    os.write(shell.fd, b'echo preserved\n')
    out = shell.until(b'fixture> ')
    assert b'original-debug' in out and b'preserved\r\n' in out, out
    checks.append('existing DEBUG trap degrades safely without replacing it')
finally:
    shell.close()

for rc in ["readonly PROMPT_COMMAND=':'\n", 'readonly PS1\n', 'set -T\n', 'shopt -s extdebug\n',
           "declare -A PROMPT_COMMAND=([first]=':')\n", 'VSCODE_SHELL_INTEGRATION=1\n']:
    shell = Shell(rc)
    try:
        out = shell.until(b'fixture> ')
        assert b'Command markers unavailable' in out and b']133;' not in out, (rc, out)
    finally:
        shell.close()
checks.append('readonly, functrace, associative prompt hooks and existing integrations are untouched')

shell = Shell('set -u\n')
try:
    shell.until()
    shell.run('false', 1)
    shell.run('echo nounset')
    checks.append('nounset shell with initially unset PROMPT_COMMAND remains usable')
finally:
    shell.close()

shell = Shell(launcher='/bin/dash')
try:
    shell.until()
    shell.run('echo posix-launch')
    checks.append('POSIX launcher interprets static bootstrap without Bash syntax dependency')
finally:
    shell.close()

shell = Shell(launcher='/bin/dash', default_shell='/bin/dash')
try:
    out = shell.until(b'using the normal login shell.')
    os.write(shell.fd, b'printf "fallback=%s\\n" done\n')
    out += shell.until(b'fallback=done\r\n')
    assert b']133;' not in out, out
    checks.append('non-Bash account gets an ordinary functioning login shell')
finally:
    shell.close()

print(json.dumps({'passed': True, 'bashVersion': version[0], 'checks': checks}))
