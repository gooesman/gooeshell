import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('real Electron main preserves unsaved editors on native close and wires local editing IPC', {
  skip: process.env.GOOESHELL_EDITOR_MAIN_TEST === '1' ? false : 'Set GOOESHELL_EDITOR_MAIN_TEST=1 after building the desktop app',
  timeout: 60_000,
}, async t => {
  const root = process.cwd();
  const artifactsRoot = path.resolve('test-output');
  await fs.mkdir(artifactsRoot, { recursive: true });
  const artifacts = await fs.mkdtemp(path.join(artifactsRoot, 'editor-main-'));
  const report = path.join(artifacts, 'result.json');
  const executable = process.platform === 'darwin'
    ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const env = { ...process.env, GOOESHELL_EDITOR_MAIN_ARTIFACTS: artifacts };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.GOOESHELL_DEV_URL;
  const child = spawn(executable, [path.join(root, 'tests/fixtures/editor-main-electron.cjs'), ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [])], {
    env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', bytes => { logs += bytes.toString(); });
  child.stdout.on('data', bytes => { logs += bytes.toString(); });
  const timeout = setTimeout(() => child.kill(), 50_000);
  timeout.unref();
  child.once('close', () => clearTimeout(timeout));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once('close', resolve); child.once('error', reject);
  });
  const result = JSON.parse(await fs.readFile(report, 'utf8').catch(() => {
    throw new Error(`No main editor report: ${logs}`);
  }));
  t.diagnostic(`editor main artifacts: ${artifacts}`);
  assert.equal(exit, 0, JSON.stringify(result, null, 2) + logs);
  assert.equal(result.success, true, JSON.stringify(result, null, 2) + logs);
  for (const check of ['localReadWrite', 'conflictThroughIpc', 'localCopy', 'cancelSaveDialog', 'overwriteCopy', 'overwriteDifferentEncoding', 'closeCancelled', 'quitCancelled', 'busyBlocksClose', 'discardCloses', 'workerShutdownOnlyAfterDiscard']) {
    assert.equal(result.checks[check], true, `Missing completed check: ${check}`);
  }
});
