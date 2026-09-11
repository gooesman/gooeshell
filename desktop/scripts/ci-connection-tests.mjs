import { spawn } from 'node:child_process';

// All windows, credentials and SSH servers belong to disposable local fixtures.
// Run native input tests sequentially to avoid competing hidden windows.
const child = spawn(process.execPath, [
  'node_modules/tsx/dist/cli.mjs', '--test', '--test-concurrency=1',
  'tests/connection-ui-render.test.ts', 'tests/connections-flow-render.test.ts',
  'tests/connection-main.test.ts', 'tests/terminal-reconnect.test.ts', 'tests/app-connections-render.test.ts',
], {
  env: { ...process.env, GOOESHELL_CONNECTION_UI_TEST: '1', GOOESHELL_CONNECTIONS_FLOW_TEST: '1', GOOESHELL_CONNECTION_MAIN_TEST: '1', GOOESHELL_RECONNECT_RENDER_TEST: '1', GOOESHELL_APP_CONNECTIONS_TEST: '1' },
  windowsHide: true, stdio: 'inherit',
});
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
