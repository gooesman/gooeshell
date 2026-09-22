import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

test('native terminal byte decoder benchmark and hidden-tab SSH output integrity', {
  skip: process.env.GOOESHELL_OUTPUT_RENDER_TEST === '1' ? false : 'Set GOOESHELL_OUTPUT_RENDER_TEST=1 with Electron and a display', timeout: 65000,
}, async t => {
  const root = process.cwd(), artifactsRoot = path.resolve('../.build'); await fs.mkdir(artifactsRoot, { recursive: true });
  const artifacts = await fs.mkdtemp(path.join(artifactsRoot, 'terminal-output-')), report = path.join(artifacts, 'result.json');
  const vite = await createServer({ configFile: false, root, cacheDir: path.join(artifacts, 'vite-cache'), plugins: [react()], resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: path.join(root, 'tests/fixtures/terminal-tabs-observed.ts') }] }, server: { host: '127.0.0.1', port: 0, hmr: false } });
  await vite.listen(); t.after(() => vite.close());
  const address = vite.httpServer!.address() as { port: number };
  const executable = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const env = { ...process.env, GOOESHELL_OUTPUT_RENDER_URL: `http://127.0.0.1:${address.port}/tests/fixtures/terminal-output.html`, GOOESHELL_OUTPUT_RENDER_REPORT: report, GOOESHELL_OUTPUT_RENDER_DATA: path.join(artifacts, 'user-data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), path.join(root, 'tests/fixtures/terminal-output-electron.cjs')], { env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data.toString(); }); child.stdout.on('data', () => {});
  const timeout = setTimeout(() => child.kill(), 55000); timeout.unref(); child.once('close', () => clearTimeout(timeout));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  const result = JSON.parse(await fs.readFile(report, 'utf8').catch(() => { throw new Error(`No terminal output report: ${stderr}`); }));
  t.diagnostic(`terminal output artifacts: ${artifacts}`);
  assert.equal(exit, 0, JSON.stringify(result, null, 2) + stderr); assert.equal(result.success, true, JSON.stringify(result, null, 2));
  for (const name of ['nativeDecoderAvailable', 'byteEquality', 'splitUnicode', 'hiddenOutput', 'acknowledgements', 'terminalModes', 'sameTerminalAfterSwitch']) assert.equal(result.checks[name], true, name);
  assert.deepEqual(result.rendererErrors, []);
  for (const sample of result.benchmark) t.diagnostic(`${sample.packetBytes} byte packets: old ${sample.oldMedianMs.toFixed(2)} ms, native ${sample.nativeMedianMs.toFixed(2)} ms, compatibility ${sample.fallbackMedianMs.toFixed(2)} ms per ${sample.totalBytes / 1048576} MiB; decoding only`);
});
