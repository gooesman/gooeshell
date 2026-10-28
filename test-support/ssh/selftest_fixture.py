"""Smoke-test a running fixture without using any user SSH configuration."""

import argparse
import asyncio
from pathlib import Path
import secrets

import asyncssh


async def run(ready):
    values = dict(line.split("=", 1) for line in ready.read_text(encoding="utf-8").splitlines())
    assert values["fixture"] == "gooeshell-sftp-v1"
    assert values["host"] == "127.0.0.1"
    assert values["username"] == "gooeshell-test"
    root = Path(values["root"]).resolve()
    assert root.name.startswith("gooeshell-sftp-test-")
    assert (root / "fixture.token").read_text(encoding="utf-8") == values["token"]
    public_key = asyncssh.import_public_key(values["host_public_key"])
    assert public_key.get_fingerprint("sha256") == values["fingerprint"]
    payload = bytes((i * 37 + 19) % 251 for i in range(196_731))
    async with asyncssh.connect(
        "127.0.0.1",
        int(values["port"]),
        username=values["username"],
        password=values["password"],
        known_hosts=([public_key], [], []),
        client_keys=[],
        agent_path=None,
        config=None,
    ) as connection:
        async with connection.start_sftp_client() as sftp:
            name = "/fixture-selftest-" + secrets.token_hex(6)
            await sftp.mkdir(name)
            async with sftp.open(name + "/payload.bin", "wb") as remote:
                await remote.write(payload)
            async with sftp.open(name + "/payload.bin", "rb") as remote:
                assert await remote.read() == payload
            await sftp.rename(name + "/payload.bin", name + "/published.bin")
            assert (root / "remote" / name.lstrip("/") / "published.bin").read_bytes() == payload
            try:
                await sftp.symlink("../../fixture.token", name + "/escape")
            except asyncssh.SFTPPermissionDenied:
                pass
            else:
                raise AssertionError("fixture accepted a symbolic link")
            assert await sftp.realpath("/../../") == "/"
            try:
                await sftp.stat("/../fixture.token")
            except asyncssh.SFTPNoSuchFile:
                pass
            else:
                raise AssertionError("fixture exposed files outside its SFTP root")
            try:
                await connection.run("echo this-must-not-run", check=True)
            except asyncssh.ChannelOpenError:
                pass
            else:
                raise AssertionError("fixture accepted an exec channel")
    print("PASS: fixture authentication, pinned host key, upload/download, rename, confinement, disabled symlinks and disabled exec", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ready", type=Path, required=True)
    asyncio.run(run(parser.parse_args().ready))
