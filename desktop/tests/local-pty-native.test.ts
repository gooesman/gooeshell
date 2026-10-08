import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';

test('Electron runtime launches real local PTYs with Chinese, resize, Ctrl+C, output ACK and process release', {
  skip: process.env.GOOESHELL_LOCAL_PTY_NATIVE_TEST === '1' ? false : 'Set GOOESHELL_LOCAL_PTY_NATIVE_TEST=1 after building main', timeout: 120000,
}, async t => {
  const artifactsRoot = path.resolve('test-output'); await fs.mkdir(artifactsRoot, {recursive: true});
  const artifacts = await fs.mkdtemp(path.join(artifactsRoot, 'local-pty-native-'));
  const executable = process.platform === 'darwin' ? path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.resolve('node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const child = spawn(executable, [path.resolve('tests/fixtures/local-pty-native.cjs')], {
    cwd: process.cwd(), windowsHide: true, env: {...process.env, ELECTRON_RUN_AS_NODE: '1', GOOESHELL_LOCAL_PTY_NATIVE_ARTIFACTS: artifacts, GOOESHELL_LOCAL_PTY_NODE_EXE: process.execPath}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data);
  const timer = setTimeout(() => child.kill(), 110000); timer.unref(); t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill(); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  const report = JSON.parse(await fs.readFile(path.join(artifacts, 'result.json'), 'utf8').catch(() => { throw new Error('No native PTY report: ' + logs); }));
  t.diagnostic('native PTY report: ' + artifacts);
  assert.equal(code, 0, JSON.stringify(report, null, 2) + logs); assert.equal(report.success, true);
  assert.equal(report.checks.earlyDisconnect, true); assert.equal(report.checks.shutdown, true);
  assert.equal(report.checks.processTree, true);
});
