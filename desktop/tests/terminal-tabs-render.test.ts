import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
const { allowsUnsupportedGpuSkip } = createRequire(import.meta.url)('./fixtures/terminal-gpu-policy.cjs');

for (const domFallback of [false, true]) test(`same-font terminal tabs preserve ${domFallback ? 'DOM glyph pixels' : 'actual GPU glyph pixels'} through hidden font updates`, {
  skip: process.env.GOOESHELL_TABS_RENDER_TEST === '1' ? false : 'Set GOOESHELL_TABS_RENDER_TEST=1 with Electron and a display', timeout: 65000,
}, async t => {
  const root = process.cwd(), artifactsRoot = path.resolve('../.build'); await fs.mkdir(artifactsRoot, { recursive: true });
  const artifacts = await fs.mkdtemp(path.join(artifactsRoot, 'terminal-tabs-')), report = path.join(artifacts, 'result.json');
  const aliases = [{ find: /^@xterm\/xterm$/, replacement: path.join(root, 'tests/fixtures/terminal-tabs-observed.ts') }];
  if (domFallback) aliases.push({ find: /^@xterm\/addon-webgl$/, replacement: path.join(root, 'tests/fixtures/webgl-unavailable.ts') });
  const vite = await createServer({ configFile: false, root, cacheDir: path.join(artifacts, 'vite-cache'), plugins: [react()], resolve: { alias: aliases }, server: { host: '127.0.0.1', port: 0, hmr: false } });
  await vite.listen(); t.after(() => vite.close());
  const address = vite.httpServer!.address() as { port: number };
  const executable = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const env = { ...process.env, GOOESHELL_TABS_RENDER_URL: `http://127.0.0.1:${address.port}/tests/fixtures/terminal-tabs.html`, GOOESHELL_TABS_RENDER_REPORT: report, GOOESHELL_TABS_RENDER_DATA: path.join(artifacts, 'user-data'), GOOESHELL_TABS_RENDER_DOM: domFallback ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), path.join(root, 'tests/fixtures/terminal-tabs-electron.cjs')], { env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data.toString(); }); child.stdout.on('data', () => {});
  const timeout = setTimeout(() => child.kill(), 55000); timeout.unref(); child.once('close', () => clearTimeout(timeout));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  const result = JSON.parse(await fs.readFile(report, 'utf8').catch(() => { throw new Error(`No terminal tab report: ${stderr}`); }));
  t.diagnostic(`terminal tab artifacts: ${artifacts}`);
  assert.equal(result.mode, domFallback ? 'dom' : 'webgl');
  if (result.status === 'unsupported') {
    assert.equal(domFallback, false, 'DOM behavior coverage cannot be skipped');
    assert.equal(exit, 77, 'unsupported capability requires its dedicated exit marker');
    assert.equal(result.success, false);
    assert.equal(allowsUnsupportedGpuSkip({ platform: process.platform, arch: process.arch, githubActions: process.env.GITHUB_ACTIONS, runnerEnvironment: process.env.RUNNER_ENVIRONMENT }, result.graphics.capabilityProbe), true);
    assert.deepEqual(result.checks, {}, 'no xterm regression checks may run before a capability skip');
    assert.deepEqual(result.rendererErrors, []);
    t.diagnostic(JSON.stringify(result.graphics));
    t.skip(result.skipReason); return;
  }
  assert.equal(exit, 0, JSON.stringify(result, null, 2) + stderr); assert.equal(result.success, true, JSON.stringify(result, null, 2));
  for (const name of ['glyphsSurviveSiblingUpdate', 'hiddenFontSettings', 'repeatSwitch', 'bufferPreserved', 'isolatedFontFamilies', 'singleBridgeSubscription', 'bridgeUnsubscribed']) assert.equal(result.checks[name], true, name);
  if (domFallback) {
    assert.equal(result.checks.liveDomRenderers, true); assert.equal(result.checks.liveWebglContexts, undefined); assert.equal(result.state.canvas, 0);
  } else {
    for (const name of ['glyphsSurviveSiblingReset', 'isolatedAtlas', 'liveWebglContexts']) assert.equal(result.checks[name], true, name);
    assert.equal(result.graphics.capabilityProbe.status, 'available');
  }
  assert.deepEqual(result.rendererErrors, []);
});
