import { spawn } from 'node:child_process';

// Keep native keyboard fixtures sequential and use each suite's isolated profile.
const child = spawn(process.execPath, [
  'node_modules/tsx/dist/cli.mjs', '--test', '--test-concurrency=1',
  'tests/app-explorer-render.test.ts', 'tests/terminal-paste-render.test.ts', 'tests/terminal-tabs-render.test.ts',
  'tests/explorer-performance.test.ts', 'tests/terminal-output-render.test.ts',
], {
  env: { ...process.env, GOOESHELL_APP_EXPLORER_TEST: '1', GOOESHELL_PASTE_RENDER_TEST: '1', GOOESHELL_TABS_RENDER_TEST: '1', GOOESHELL_EXPLORER_PERFORMANCE_TEST: '1', GOOESHELL_OUTPUT_RENDER_TEST: '1' },
  windowsHide: true, stdio: 'inherit',
});
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
