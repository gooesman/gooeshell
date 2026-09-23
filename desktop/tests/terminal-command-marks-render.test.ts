import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

for (const domFallback of [false, true]) test(`command marks use the real terminal buffer, native input and isolated transports (${domFallback ? 'DOM fallback' : 'default renderer'})`, {
  skip: process.env.GOOESHELL_COMMAND_MARKS_TEST === '1' ? false : 'Set GOOESHELL_COMMAND_MARKS_TEST=1 with Electron and a display',
  timeout: 150_000,
}, async t => {
  const root = process.cwd(), artifactsRoot = path.resolve('../.build');
  await fs.mkdir(artifactsRoot, { recursive: true });
  const artifacts = await fs.mkdtemp(path.join(artifactsRoot, 'terminal-command-marks-'));
  const report = path.join(artifacts, 'result.json');
  const aliases = [{ find: /^@xterm\/xterm$/, replacement: path.join(root, 'tests/fixtures/terminal-command-marks-observed.ts') }];
  if (domFallback) aliases.push({ find: /^@xterm\/addon-webgl$/, replacement: path.join(root, 'tests/fixtures/webgl-unavailable.ts') });
  const vite = await createServer({ configFile: false, root, cacheDir: path.join(artifacts, 'vite-cache'), plugins: [react()],
    resolve: { alias: aliases }, server: { host: '127.0.0.1', port: 0, hmr: false } });
  await vite.listen(); t.after(() => vite.close());
  const address = vite.httpServer!.address() as { port: number };
  const executable = process.platform === 'darwin' ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const env = { ...process.env, GOOESHELL_COMMAND_MARKS_URL: `http://127.0.0.1:${address.port}/tests/fixtures/terminal-command-marks.html`,
    GOOESHELL_COMMAND_MARKS_REPORT: report, GOOESHELL_COMMAND_MARKS_DATA: path.join(artifacts, 'user-data'), GOOESHELL_COMMAND_MARKS_DOM: domFallback ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), path.join(root, 'tests/fixtures/terminal-command-marks-electron.cjs')],
    { env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stderr.on('data', data => { logs += data.toString(); }); child.stdout.on('data', data => { logs += data.toString(); });
  const timeout = setTimeout(() => child.kill(), 140_000); timeout.unref(); child.once('close', () => clearTimeout(timeout));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  const result = JSON.parse(await fs.readFile(report, 'utf8').catch(async () => {
    const progress = await fs.readFile(report + '.progress.json', 'utf8').catch(() => 'No stage progress was recorded');
    throw new Error(`No command marks renderer report. Last progress: ${progress}\n${logs}`);
  }));
  t.diagnostic(`command marks artifacts: ${artifacts}`);
  assert.equal(exit, 0, JSON.stringify(result, null, 2) + logs);
  assert.equal(result.success, true, JSON.stringify(result, null, 2));
  for (const name of ['plainTerminalPassThrough', 'statusesAndSplitOsc', 'rightOverviewJump', 'copyCommandAndOutput', 'nativeCommandNavigation',
    'positionChangesPreserveTerminal', 'hiddenTabOutput', 'resizeFontAndChineseWrap', 'softWrappedPromptSurvivesReflow', 'alternateScreenPassThrough',
    'disconnectPendingUnknown', 'reconnectIsolation', 'acknowledgements', 'scrollbackEvictsMarks',
    'boundedOverviewUnderLoad', 'queuedCompletionPreserved', 'queuedRunningUnknown']) assert.equal(result.checks[name], true, name);
  assert.deepEqual(result.rendererErrors, []);
  if (domFallback) assert.equal(result.final.canvas, 0);
});
