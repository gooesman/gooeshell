import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

test('actual TerminalView multiline paste preserves bytes and waits for explicit line advance', {
  skip: process.env.GOOESHELL_PASTE_RENDER_TEST === '1' ? false : 'Set GOOESHELL_PASTE_RENDER_TEST=1 for isolated Electron paste regression', timeout: 130_000,
}, async t => {
  const root = process.cwd(), base = path.resolve('../.build'); await fs.mkdir(base, { recursive: true });
  const artifacts = await fs.mkdtemp(path.join(base, 'terminal-paste-')), report = path.join(artifacts, 'result.json');
  const vite = await createServer({ configFile: false, root, cacheDir: path.join(artifacts, 'vite-cache'), plugins: [react()], resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: path.join(root, 'tests/fixtures/xterm-paste-observed.ts') }] }, server: { host: '127.0.0.1', port: 0, hmr: false } });
  await vite.listen(); t.after(() => vite.close());
  const address = vite.httpServer!.address() as { port: number };
  const executable = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const env = { ...process.env, GOOESHELL_PASTE_URL: `http://127.0.0.1:${address.port}/tests/fixtures/terminal-paste.html`, GOOESHELL_PASTE_REPORT: report, GOOESHELL_PASTE_DATA: path.join(artifacts, 'user-data') }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), path.join(root, 'tests/fixtures/terminal-paste-electron.cjs')], { env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data.toString(); }); child.stdout.on('data', () => {});
  const timeout = setTimeout(() => child.kill(), 120_000); timeout.unref(); child.once('close', () => clearTimeout(timeout)); t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  const result = JSON.parse(await fs.readFile(report, 'utf8').catch(() => { throw new Error(`No paste renderer report: ${stderr}`); }));
  t.diagnostic(`terminal paste artifacts: ${artifacts}`);
  assert.equal(exit, 0, JSON.stringify(result, null, 2) + stderr); assert.equal(result.success, true, JSON.stringify(result, null, 2));
  assert.ok(Object.keys(result.checks).length >= 12); assert.ok(Object.values(result.checks).every(value => value === true)); assert.deepEqual(result.rendererErrors, []);
});
