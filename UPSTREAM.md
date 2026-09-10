# Upstream provenance

gooeshell is an independent Windows-first product. The current graphical application lives in `desktop/` and uses Electron, React, TypeScript, xterm.js and ssh2. The original native prototype and imported WezTerm source tree remain in this repository as a reference, under their original licenses.

The graphical application does not run or repackage the WezTerm executables. Its new code is MIT licensed under `desktop/LICENSE`; dependency licenses are retained in the packaged Node modules and Electron distribution. Font provenance is recorded below.

- Upstream: https://github.com/wezterm/wezterm
- Imported revision: `9fa147c9532c7b175335f6453a4dd7ad7e6473b2`
- Original license and third-party notices: `LICENSE.md`, `licenses/`, and per-component notices.
- New gooeshell code: `gooeshell/`, `gooeshell-launcher/`, `gooeshell-files/`.
- Product workflow: `.github/workflows/gooeshell-windows.yml`.
- Original workflows are retained under `ci/upstream-workflows/` and do not run in this repository.

Original WezTerm executable names are retained inside the portable bundle for compatibility. Users start the application with `gooeshell.exe`.

The DejaVu Sans Mono files in `gooeshell/fonts/` are unmodified files from the official DejaVu 2.37 release. See that directory's README and original license for provenance.

The graphical application bundles DejaVu Sans Mono 2.37, JetBrains Mono 2.304, and IBM Plex Mono with regular and bold faces in `desktop/public/fonts/`. That directory contains the upstream revisions, original licenses, and provenance in its README. System fonts are enumerated from the user's computer and are not redistributed.

The import preserves dependency submodule URLs and commits. Clone with `--recurse-submodules`.
