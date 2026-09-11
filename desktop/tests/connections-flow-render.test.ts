import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

test('connection lifecycle keeps terminal identity and prevents cancelled or retargeted actions', {
  skip: process.env.GOOESHELL_CONNECTIONS_FLOW_TEST !== '1' && 'Set GOOESHELL_CONNECTIONS_FLOW_TEST=1 with Electron installed', timeout: 75_000,
}, async t => {
  const root = process.cwd(), artifactsRoot = path.resolve('../.build');
  await fs.mkdir(artifactsRoot, { recursive: true });
  const artifacts = await fs.mkdtemp(path.join(artifactsRoot, 'connections-flow-'));
  const report = path.join(artifacts, 'result.json');
  const vite = await createServer({ configFile: false, root, cacheDir: path.join(artifacts, 'vite-cache'), plugins: [react()], server: { host: '127.0.0.1', port: 0, hmr: false } });
  await vite.listen(); t.after(() => vite.close());
  const port = (vite.httpServer!.address() as { port: number }).port;
  const executable = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const env = { ...process.env, GOOESHELL_CONNECTIONS_FLOW_URL: `http://127.0.0.1:${port}/tests/fixtures/connections-flow-render.html`, GOOESHELL_CONNECTIONS_FLOW_REPORT: report, GOOESHELL_CONNECTIONS_FLOW_DATA: path.join(artifacts, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), path.join(root, 'tests/fixtures/connections-flow-render-electron.cjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; }); child.stdout.on('data', () => {});
  const timeout = setTimeout(() => child.kill(), 65_000); timeout.unref(); child.once('close', () => clearTimeout(timeout));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  const result = JSON.parse(await fs.readFile(report, 'utf8').catch(() => { throw new Error('No connections flow report: ' + stderr); }));
  t.diagnostic(`connection lifecycle artifacts: ${artifacts}`);
  assert.equal(exit, 0, JSON.stringify(result, null, 2) + stderr); assert.equal(result.success, true);
  for (const name of ['onlineDirectFocusesExisting', 'reconnectKeepsTabAndOneAttempt', 'backgroundReconnectPreservesSelection', 'cancelCleansLateTransport', 'closeCleansPendingReconnect', 'authenticationUsesCompactPrompt', 'sudoRechecksCapturedTargetAfterSaving', 'saveMetadataDoesNotConnect', 'endpointEditDoesNotRetargetOpenSession', 'oldTargetCannotReplaceNewCredentials', 'oldTargetReconnectUsesSeparateProfile']) assert.equal(result.checks[name], true, name);
  assert.deepEqual(result.errors, []);
});
