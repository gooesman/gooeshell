# Upstream provenance

gooeshell is an independent Windows-first product. The current graphical application lives in `desktop/` and uses Electron, React, TypeScript, xterm.js and ssh2. The original native prototype and imported WezTerm source tree remain in this repository as a reference, under their original licenses.

The graphical application does not run or repackage the WezTerm executables. Its new code is MIT licensed under `desktop/LICENSE`; dependency licenses are retained in the packaged Node modules and Electron distribution. Font provenance is recorded below.

Compressed file transfers use the [node-tar](https://github.com/isaacs/node-tar) library (BlueOak-1.0.0 license) and Node.js streaming gzip locally; the remote helper uses Python's standard-library `tarfile` and `gzip`. Archive validation and the transfer workflow are independent gooeshell code. No remote service is installed.

Local terminals use [microsoft/node-pty](https://github.com/microsoft/node-pty), pinned to 1.1.0 (MIT), with Windows ConPTY and POSIX pseudo-terminals. The complete module is unpacked beside the application ASAR so native helpers and worker scripts use real filesystem paths. Its license remains in the distributed dependency. Local terminal session routing, flow control and workspace integration are independent gooeshell code.

`desktop/scripts/prepare-native-pty.mjs` applies two idempotent packaging fixes to this pinned dependency: restore executable bits for the macOS spawn helper ([upstream issue 850](https://github.com/microsoft/node-pty/issues/850)), and avoid replacing already-unpacked ASAR paths twice ([upstream issue 923](https://github.com/microsoft/node-pty/issues/923)). Dependency upgrades require reviewing these fixes. These are build-time changes, not modifications to installed applications or user Shell configuration.

- Upstream: https://github.com/wezterm/wezterm
- Imported revision: `9fa147c9532c7b175335f6453a4dd7ad7e6473b2`
- Original license and third-party notices: `LICENSE.md`, `licenses/`, and per-component notices.
- New gooeshell code: `gooeshell/`, `gooeshell-launcher/`, `gooeshell-files/`.
- Product workflow: `.github/workflows/gooeshell-windows.yml`.
- Original workflows are retained under `ci/upstream-workflows/` and do not run in this repository.

Original WezTerm executable names are retained inside the portable bundle for compatibility. Users start the application with `gooeshell.exe`.

The DejaVu Sans Mono files in `gooeshell/fonts/` are unmodified files from the official DejaVu 2.37 release. See that directory's README and original license for provenance.

The graphical application bundles DejaVu Sans Mono 2.37, JetBrains Mono 2.304, and IBM Plex Mono with regular and bold faces in `desktop/public/fonts/`. That directory contains the upstream revisions, original licenses, and provenance in its README. System fonts are enumerated from the user's computer and are not redistributed.

Independent Latin/CJK weights use standard [CSS composite font faces and Unicode ranges](https://www.w3.org/TR/css-fonts-4/#composite-fonts). Windows font enumeration filters simulated WPF faces and reads full/PostScript names from the [OpenType name table](https://learn.microsoft.com/en-us/typography/opentype/spec/name), including individual TTC collection faces. No xterm.js or WebGL internals are patched for this feature.

The import preserves dependency submodule URLs and commits. Clone with `--recurse-submodules`.
