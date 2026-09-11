import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

test('connection UI separates saving from connecting and preserves explicit credential choices', {
  skip: process.env.GOOESHELL_CONNECTION_UI_TEST !== '1' && 'Set GOOESHELL_CONNECTION_UI_TEST=1 with Electron installed', timeout: 75_000,
}, async t => {
  const root = process.cwd(), artifactsRoot = path.resolve('../.build');
  await fs.mkdir(artifactsRoot, { recursive: true });
  const artifacts = await fs.mkdtemp(path.join(artifactsRoot, 'connection-ui-'));
  const report = path.join(artifacts, 'result.json');
  const vite = await createServer({ configFile: false, root, cacheDir: path.join(artifacts, 'vite-cache'), plugins: [react()], server: { host: '127.0.0.1', port: 0, hmr: false } });
  await vite.listen(); t.after(() => vite.close());
  const port = (vite.httpServer!.address() as { port: number }).port;
  const electron = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const env = { ...process.env, GOOESHELL_CONNECTION_UI_URL: `http://127.0.0.1:${port}/tests/fixtures/connection-ui-render.html`, GOOESHELL_CONNECTION_UI_REPORT: report, GOOESHELL_CONNECTION_UI_DATA: path.join(artifacts, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), path.join(root, 'tests/fixtures/connection-ui-render-electron.cjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; }); child.stdout.on('data', () => {});
  const timeout = setTimeout(() => child.kill(), 65_000); timeout.unref(); child.once('close', () => clearTimeout(timeout));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  const result = JSON.parse(await fs.readFile(report, 'utf8').catch(() => { throw new Error('No connection UI report: ' + stderr); }));
  t.diagnostic(`connection UI artifacts: ${artifacts}`);
  assert.equal(exit, 0, JSON.stringify(result, null, 2) + stderr); assert.equal(result.success, true);
  for (const name of ['groupCollapseAndPhysicalSession', 'saveWithoutConnectingAndBlankSecretPreservation', 'statusRefreshPreservesUserChoice', 'newConnectionOptions', 'cancelPendingConnection', 'forgetCredentials']) assert.equal(result.checks[name], true, name);
  assert.deepEqual(result.errors, []);
});
