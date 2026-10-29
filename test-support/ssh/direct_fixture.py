"""Root-only isolated Linux OpenSSH pair. Never uses real user credentials."""
import json, os, pathlib, pwd, shutil, socket, stat, subprocess, sys, tempfile, uuid, time
root = pathlib.Path(tempfile.mkdtemp(prefix='gooeshell-direct-test-'))
root.chmod(0o755)
users, servers = [], []

def run(*args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT).decode()

def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

try:
    if os.geteuid() != 0: raise ValueError('Isolated OpenSSH fixture requires root')
    (pathlib.Path('/run/sshd')).mkdir(exist_ok=True)
    run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'fixture-only', '-f', str(root/'client'))
    run('ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'fixture-only', '-f', str(root/'host'))
    key = (root/'client').read_text()
    public = (root/'client.pub').read_text()
    result = dict(root=str(root))
    for label in ('source', 'target'):
        username = 'gst' + uuid.uuid4().hex[:12]
        home = root/label
        home.mkdir(mode=0o700)
        run('useradd', '-M', '-d', str(home), '-s', '/bin/sh', '-p', 'x', username)
        users.append(username)
        uid = pwd.getpwnam(username).pw_uid
        os.chown(home, uid, uid)
        ssh = home/'.ssh'
        ssh.mkdir(mode=0o700)
        (ssh/'authorized_keys').write_text(public)
        (ssh/'authorized_keys').chmod(0o600)
        os.chown(ssh, uid, uid)
        os.chown(ssh/'authorized_keys', uid, uid)
        try: os.setxattr(ssh/'authorized_keys', 'user.gooeshell-fixture', b'preserve-metadata')
        except OSError: pass
        (home/'destination').mkdir()
        os.chown(home/'destination', uid, uid)
        # Bound throughput makes a mid-file cancellation deterministic on loopback.
        (home/'bin').mkdir()
        (home/'bin'/'rsync').write_text('#!/bin/sh\nexec /usr/bin/rsync --bwlimit=8192 "$@"\n')
        (home/'bin'/'rsync').chmod(0o755)
        p = port()
        config = root/(label+'.conf')
        config.write_text('\n'.join([
            'Port '+str(p), 'ListenAddress 0.0.0.0', 'HostKey '+str(root/'host'),
            'PidFile '+str(root/(label+'.pid')), 'AuthorizedKeysFile .ssh/authorized_keys',
            'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no',
            'PermitRootLogin no', 'AllowUsers '+username, 'StrictModes yes',
            'AllowTcpForwarding no', 'X11Forwarding no', 'PrintMotd no', 'PrintLastLog no',
            'SetEnv PATH='+str(home/'bin')+':/usr/local/bin:/usr/bin:/bin', 'LogLevel ERROR', ''
        ]))
        log = open(root/(label+'.log'), 'wb')
        process = subprocess.Popen(['/usr/sbin/sshd', '-D', '-e', '-f', str(config)], stdout=log, stderr=log)
        servers.append(process)
        deadline = time.monotonic() + 5
        while True:
            if process.poll() is not None: raise ValueError((root/(label+'.log')).read_text())
            try:
                with socket.create_connection(('127.0.0.1', p), timeout=.2): break
            except OSError:
                if time.monotonic() > deadline: raise ValueError('sshd did not listen')
                time.sleep(.05)
        result[label] = dict(host='127.0.0.1', port=p, username=username, privateKey=key, home=str(home))
    print(json.dumps(result), flush=True)
    for line in sys.stdin:
        r = json.loads(line)
        try:
            op = r['op']
            if op == 'write':
                account = pwd.getpwnam(result[r.get('side', 'source')]['username'])
                file = pathlib.Path(result[r.get('side', 'source')]['home'])/r['path']
                file.parent.mkdir(parents=True, exist_ok=True)
                # Deterministic non-sparse data; source hashes need actual reads.
                data = r['text'].encode('utf-8') if 'text' in r else (b'GooeShell_' + bytes(range(256))) * 4096
                with file.open('wb') as f:
                    remaining = r.get('size', len(data) if 'text' in r else 1024)
                    while remaining:
                        chunk = data[:min(len(data), remaining)]
                        f.write(chunk)
                        remaining -= len(chunk)
                for entry in [file, *file.parents]:
                    if entry == root: break
                    os.chown(entry, account.pw_uid, account.pw_gid)
                value = str(file)
            elif op == 'inspect':
                def metadata(side):
                    file = pathlib.Path(result[side]['home'])/'.ssh/authorized_keys'
                    return dict(mode=stat.S_IMODE(file.stat().st_mode), xattrs={name:os.getxattr(file,name).hex() for name in os.listxattr(file)})
                value = dict(keys={side:(pathlib.Path(result[side]['home'])/'.ssh/authorized_keys').read_text() for side in ('source','target')},metadata={side:metadata(side) for side in ('source','target')},temps=[str(p) for p in pathlib.Path('/tmp').glob('gooeshell-direct-*') if p.is_dir() and p.stat().st_uid in [pwd.getpwnam(u).pw_uid for u in users]],stages=[str(p) for p in root.glob('target/destination/.gooeshell-transfer-*')])
            elif op == 'corrupt':
                file = pathlib.Path(r['path'])
                s = file.stat()
                with file.open('r+b') as f: f.seek(r.get('offset', 0)); f.write(b'CORRUPTED')
                os.utime(file, ns=(s.st_atime_ns, s.st_mtime_ns))
                value = True
            elif op == 'chmod':
                os.chmod(pathlib.Path(result[r['side']]['home'])/r['path'], r['mode'])
                value = True
            elif op == 'list': value = [str(p) for p in root.rglob('*')]
            else: raise ValueError('Unknown operation')
            print(json.dumps(dict(value=value)), flush=True)
        except Exception as e: print(json.dumps(dict(error=str(e))), flush=True)
finally:
    for p in servers:
        p.terminate()
        try: p.wait(timeout=3)
        except subprocess.TimeoutExpired: p.kill(); p.wait()
    for username in users:
        subprocess.run(['pkill', '-KILL', '-u', username], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['userdel', username], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if root.name.startswith('gooeshell-direct-test-') and root.parent == pathlib.Path('/tmp'): shutil.rmtree(root)
