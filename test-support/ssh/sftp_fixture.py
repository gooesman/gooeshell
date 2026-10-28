"""Disposable, loopback-only SFTP fixture. Never loads user SSH configuration."""

import argparse
import asyncio
import os
from pathlib import Path
import secrets
import tempfile
import time

import asyncssh


USERNAME = "gooeshell-test"
PASSWORD = "gooeshell-loopback-test-only"


class TestSSHServer(asyncssh.SSHServer):
    def begin_auth(self, username):
        return True

    def password_auth_supported(self):
        return True

    def validate_password(self, username, password):
        return username == USERNAME and password == PASSWORD

    def connection_requested(self, *args):
        return False

    def server_requested(self, *args):
        return False


class ConfinedSFTPServer(asyncssh.SFTPServer):
    def __init__(self, channel, root):
        self.test_root = Path(root).resolve()
        super().__init__(channel, chroot=os.fsencode(self.test_root))

    def map_path(self, path):
        mapped = super().map_path(path)
        local_path = os.fsdecode(mapped)
        # AsyncSSH's map_path uses /D:/... until its final Windows path conversion.
        if os.name == "nt" and local_path[:1] == "/" and local_path[2:3] == ":":
            local_path = local_path[1:]
        resolved = Path(local_path).resolve()
        if not resolved.is_relative_to(self.test_root):
            raise asyncssh.SFTPPermissionDenied("Test fixture path escapes its root")
        return mapped

    def symlink(self, *args):
        raise asyncssh.SFTPPermissionDenied("Symlinks are disabled in this fixture")

    def link(self, *args):
        raise asyncssh.SFTPPermissionDenied("Hard links are disabled in this fixture")


async def run(args):
    ready = args.ready.resolve()
    stop = Path(str(ready) + ".stop")
    if ready.exists() or stop.exists():
        raise RuntimeError("Use a new readiness-file path; an old ready/stop file exists")
    args.root.mkdir(parents=True, exist_ok=True)
    ready.parent.mkdir(parents=True, exist_ok=True)
    fixture_root = Path(tempfile.mkdtemp(prefix="gooeshell-sftp-test-", dir=args.root.resolve()))
    remote_root = fixture_root / "remote"
    local_root = fixture_root / "local"
    remote_root.mkdir()
    local_root.mkdir()
    token = secrets.token_hex(24)
    (fixture_root / "fixture.token").write_text(token, encoding="utf-8")
    # Per-run host key is kept in memory. No identity is read from the user's machine.
    host_key = asyncssh.generate_private_key("ssh-ed25519")
    server = await asyncssh.create_server(
        TestSSHServer,
        "127.0.0.1",
        0,
        server_host_keys=[host_key],
        sftp_factory=lambda channel: ConfinedSFTPServer(channel, remote_root),
        allow_scp=False,
        login_timeout=10,
    )
    values = {
        "fixture": "gooeshell-sftp-v1",
        "host": "127.0.0.1",
        "port": str(server.get_port()),
        "root": str(fixture_root),
        "token": token,
        "fingerprint": host_key.get_fingerprint("sha256"),
        "host_public_key": host_key.export_public_key().decode("ascii").strip(),
        "username": USERNAME,
        "password": PASSWORD,
    }
    temporary_ready = Path(str(ready) + ".tmp")
    temporary_ready.write_text("".join(f"{key}={value}\n" for key, value in values.items()), encoding="utf-8")
    os.replace(temporary_ready, ready)
    print(f"READY 127.0.0.1:{server.get_port()} {ready}", flush=True)
    deadline = time.monotonic() + args.lifetime
    try:
        while not stop.exists() and time.monotonic() < deadline:
            await asyncio.sleep(0.2)
    finally:
        server.close()
        await server.wait_closed()
        # Leave generated test data for inspection. No recursive deletion is performed.
        print(f"STOPPED test data retained at {fixture_root}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="Parent for a newly generated disposable test directory")
    parser.add_argument("--ready", type=Path, required=True, help="New key=value readiness file")
    parser.add_argument("--lifetime", type=int, default=600, help="Maximum runtime in seconds")
    options = parser.parse_args()
    if options.lifetime < 1 or options.lifetime > 3600:
        parser.error("lifetime must be between 1 and 3600 seconds")
    asyncio.run(run(options))
