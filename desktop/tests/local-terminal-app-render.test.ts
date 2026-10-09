import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

test('local and SSH terminals keep independent tabs, output, lifecycle and file capabilities', {
  skip: process.env.GOOESHELL_LOCAL_APP_TEST !== '1' && 'Set GOOESHELL_LOCAL_APP_TEST=1 with Electron installed', timeout: 90_000,
}, async t => {
  const root = process.cwd(), artifactRoot = path.resolve('../.build'); await fs.mkdir(artifactRoot, { recursive: true });
  const artifacts = await fs.mkdtemp(path.join(artifactRoot, 'local-terminal-app-')), report = path.join(artifacts, 'result.json');
  const vite = await createServer({ configFile: false, root, cacheDir: path.join(artifacts, 'vite-cache'), plugins: [react()], resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: path.join(root, 'tests/fixtures/xterm-app-connections-observed.ts') }] }, server: { host: '127.0.0.1', port: 0, hmr: false } });
  await vite.listen(); t.after(() => vite.close()); const port = (vite.httpServer!.address() as { port: number }).port;
  const executable = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const env = { ...process.env, GOOESHELL_LOCAL_APP_URL: `http://127.0.0.1:${port}/tests/fixtures/local-terminal-app.html`, GOOESHELL_LOCAL_APP_REPORT: report, GOOESHELL_LOCAL_APP_DATA: path.join(artifacts, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), path.join(root, 'tests/fixtures/local-terminal-app-electron.cjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; }); child.stdout.on('data', () => {});
  const timeout = setTimeout(() => child.kill(), 80_000); timeout.unref(); child.once('close', () => clearTimeout(timeout)); t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  const result = JSON.parse(await fs.readFile(report, 'utf8').catch(() => { throw new Error('No local terminal report: ' + stderr); }));
  t.diagnostic(`local terminal UI artifacts: ${artifacts}`); assert.equal(exit, 0, JSON.stringify(result, null, 2) + stderr); assert.equal(result.success, true);
  for (const check of ['cleanHomeAndToolbar', 'quickConnectTypeSelection', 'homeLaunchInPlace', 'localFilesEnabledRemoteDisabled', 'inputAndUnicodeOutput', 'sshAndLocalTabsIndependent', 'launchFromSshCreatesTab', 'localGlobalCommandsOnly', 'localExitAndReopen', 'cancelLateLocalLaunch', 'closingLocalPreservesSsh']) assert.equal(result.checks[check], true, check);
  assert.deepEqual(result.errors, []);
});
