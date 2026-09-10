# Explicit loopback SFTP integration test

Requires Python 3.12 and a compiled Rust test binary. The server binds **only 127.0.0.1**, chooses a dynamic port, and offers only SFTP. It creates a new `gooeshell-sftp-test-*` subdirectory below the given parent and confines remote paths to its `remote` subdirectory. Symlink and hard-link creation are disabled. Host key and test identity are unrelated to user SSH credentials.

```powershell
python -m pip install -r gooeshell-files/tests-support/requirements.txt
# Run in a separate terminal/process. Use a NEW readiness filename on each run.
python gooeshell-files/tests-support/sftp_fixture.py --root .build/sftp-tests --ready .build/sftp-test-1.ready --lifetime 600
```

After the fixture prints `READY`, in the test process:

```powershell
$env:GOOESHELL_SFTP_TEST_READY = (Resolve-Path .build/sftp-test-1.ready).Path
cargo test --locked --release -p gooeshell-files loopback_sftp_roundtrip_and_resume -- --ignored --nocapture --test-threads=1
# Tell the fixture to stop (or let its bounded lifetime expire).
New-Item -ItemType File -Path .build/sftp-test-1.ready.stop
```

To launch a background fixture on Windows, use `Start-Process -WindowStyle Hidden`, redirect stdout/stderr to files, and wait for the readiness file before starting Cargo. The readiness file contains simple `key=value` lines, including its generated root, random marker, port and SHA256 host fingerprint. The test verifies the directory marker and pinned host fingerprint before sending the fixed loopback-only test password. A missing environment variable fails an explicitly requested integration test. An ordinary `cargo test` clearly reports this test as **ignored** with the setup reason; it does not silently pass an unrun network test.

The mock terminal accepts the explicit resume confirmations and captures UI output, while file transfers use the real ssh2/SFTP implementation. Assertions cover uploads, downloads, non-aligned prefix resumption in both directions, exact destination content, completed partial cleanup, refusal to overwrite existing destinations, preserving mismatched partials, and cancellation without publication. Each run uses a fresh local and remote subdirectory, and all generated files are retained for inspection.
