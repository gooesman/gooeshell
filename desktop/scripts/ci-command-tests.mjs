import { spawn } from 'node:child_process';

// Isolated local SSH and Electron fixtures; native input tests run sequentially.
const child = spawn(process.execPath, [
  'node_modules/tsx/dist/cli.mjs', '--test', '--test-concurrency=1',
  'tests/single-instance.test.ts', 'tests/command-main.test.ts', 'tests/command-ui-render.test.ts', 'tests/terminal-palettes-render.test.ts',
], {
  env: { ...process.env, GOOESHELL_SINGLE_INSTANCE_TEST: '1', GOOESHELL_COMMAND_MAIN_TEST: '1', GOOESHELL_COMMAND_UI_TEST: '1', GOOESHELL_PALETTE_RENDER_TEST: '1' },
  windowsHide: true, stdio: 'inherit',
});
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
