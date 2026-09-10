# Upstream provenance

gooeshell is an independent Windows-first product based on the WezTerm source tree.

- Upstream: https://github.com/wezterm/wezterm
- Imported revision: `9fa147c9532c7b175335f6453a4dd7ad7e6473b2`
- Original license and third-party notices: `LICENSE.md`, `licenses/`, and per-component notices.
- New gooeshell code: `gooeshell/`, `gooeshell-launcher/`, `gooeshell-files/`.
- Product workflow: `.github/workflows/gooeshell-windows.yml`.
- Original workflows are retained under `ci/upstream-workflows/` and do not run in this repository.

Original WezTerm executable names are retained inside the portable bundle for compatibility. Users start the application with `gooeshell.exe`.

The import preserves dependency submodule URLs and commits. Clone with `--recurse-submodules`.
