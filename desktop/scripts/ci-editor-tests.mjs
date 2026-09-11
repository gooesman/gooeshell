import { spawn } from 'node:child_process';

// These fixtures use temporary user-data directories and disposable local files.
// Linux runners invoke this script under xvfb-run; no user server is contacted.
const tests = spawn(process.execPath, [
  'node_modules/tsx/dist/cli.mjs', '--test',
  'tests/editor-render.test.ts', 'tests/editor-main.test.ts',
], {
  env: { ...process.env, GOOESHELL_EDITOR_RENDER_TEST: '1', GOOESHELL_EDITOR_MAIN_TEST: '1' },
  windowsHide: true, stdio: 'inherit',
});
tests.once('error', error => { console.error(error); process.exitCode = 1; });
tests.once('exit', code => { process.exitCode = code ?? 1; });
