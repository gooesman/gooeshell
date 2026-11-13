"""Run as an unprivileged disposable test user with real sudo available."""
import json
import os
import pathlib
import subprocess
import sys
import time
import uuid

helper = sys.argv[1]
password = 'fixture-only-password'


def call(action, *args, payload=None, ok=True):
    result = subprocess.run([sys.executable, helper, action, *args],
                            input=json.dumps(payload or {}).encode() + b'\n',
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
    if ok and result.returncode:
        raise AssertionError(result.stderr.decode(errors='replace'))
    return result


def start(script, sudo=False, secret=None):
    task = str(uuid.uuid4())
    result = call('start', payload={'taskId': task, 'script': script, 'sudo': sudo, 'password': secret})
    assert b'GOOESHELL_PROCESS_STARTED' in result.stdout
    return task


def read(task, encoding='utf8'):
    result = call('read', task, '200', encoding)
    return json.loads(result.stdout.decode().split(' ', 1)[1])


def wait(task, state='exited'):
    for _ in range(120):
        result = read(task)
        if result['state'] == state:
            return result
        time.sleep(0.1)
    raise AssertionError('task did not reach ' + state)


task = start('id -u; printf "root-completed\\n"; exit 7', True, password)
result = wait(task)
assert result['exitCode'] == 7 and '0\nroot-completed' in result['output'], result

task = start('id -u; printf "running\\n"; exec sleep 60', True, password)
for _ in range(50):
    if '0\nrunning' in read(task)['output']:
        break
    time.sleep(0.1)
else:
    raise AssertionError('root command did not start')
failure = call('stop', task, payload={'password': 'incorrect-fixture-password'}, ok=False)
assert failure.returncode and read(task)['state'] == 'running'
call('stop', task, payload={'password': password})
result = wait(task)
assert result['exitCode'] == 143, result

task = start('printf "should-not-run\\n"', True, 'incorrect-fixture-password')
result = wait(task)
assert result['exitCode'] != 0 and 'should-not-run' not in result['output'], result

task = start("printf '\\326\\320\\316\\304\\n'", False)
wait(task)
assert '中文' in read(task, 'gb18030')['output']

root = pathlib.Path.home() / '.gooeshell' / 'tasks'
task = start("python3 -c 'print(\"x\" * 3000000)'", False)
result = wait(task)
assert result['exitCode'] == 0 and result['truncated']
assert pathlib.Path(result['logPath']).stat().st_size <= 2 * 1024 * 1024

unknown = str(uuid.uuid4())
directory = root / unknown
directory.mkdir(mode=0o700)
for name, value in [('meta.json', json.dumps({'control': '/tmp/no-such-gooeshell-socket'})), ('output.log', 'partial')]:
    path = directory / name
    path.write_text(value)
    path.chmod(0o600)
assert read(unknown)['state'] == 'unknown'
assert call('stop', unknown, payload={'password': password}, ok=False).returncode

for item in root.rglob('*'):
    assert not (item.stat().st_mode & 0o077), str(item)
    if item.is_file():
        data = item.read_bytes()
        assert password.encode() not in data and b'incorrect-fixture-password' not in data
print('real sudo, cancellation, failure, encoding, bounded log, unknown state and private files passed')
