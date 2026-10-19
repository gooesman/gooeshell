import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

// The editor's focus, undo history, search panel and keyboard handling depend on
// Chromium. Run the actual renderer instead of reproducing them in a DOM mock.
test('built-in editor preserves drafts, connection and state while changing palettes', {
  skip: process.env.GOOESHELL_EDITOR_RENDER_TEST === '1' ? false : 'Set GOOESHELL_EDITOR_RENDER_TEST=1 with Electron installed (Linux needs a display or xvfb-run)',
  timeout: 120_000,
}, async t => {
  const root = process.cwd();
  const artifactsRoot = path.resolve('../.build');
  await fs.mkdir(artifactsRoot, { recursive: true });
  const artifacts = await fs.mkdtemp(path.join(artifactsRoot, 'editor-render-'));
  const report = path.join(artifacts, 'result.json');
  const vite = await createServer({
    configFile: false, root, cacheDir: path.join(artifacts, 'vite-cache'),
    plugins: [react()], server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await vite.listen();
  t.after(() => vite.close());
  const address = vite.httpServer!.address() as { port: number };
  const executable = process.platform === 'darwin'
    ? path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const env = {
    ...process.env,
    GOOESHELL_EDITOR_RENDER_URL: `http://127.0.0.1:${address.port}/tests/fixtures/editor-render.html`,
    GOOESHELL_EDITOR_RENDER_REPORT: report,
    GOOESHELL_EDITOR_RENDER_DATA: path.join(artifacts, 'user-data'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronArgs = [
    ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),
    path.join(root, 'tests/fixtures/editor-render-electron.cjs'),
  ];
  const child = spawn(executable, electronArgs, {
    env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });
  child.stdout.on('data', () => {});
  const timeout = setTimeout(() => child.kill(), 110_000);
  timeout.unref();
  child.once('close', () => clearTimeout(timeout));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once('close', resolve); child.once('error', reject);
  });
  t.diagnostic(`editor render artifacts: ${artifacts}`);
  const reportText = await fs.readFile(report, 'utf8').catch(error => {
    throw new Error(`No editor renderer report at ${report} (exit ${exit}): ${error}\n${stderr}`);
  });
  let result;
  try { result = JSON.parse(reportText); }
  catch (error) { throw new Error(`Invalid editor renderer report at ${report} (${Buffer.byteLength(reportText)} bytes, exit ${exit}): ${error}\n${stderr}`); }
  assert.equal(exit, 0, JSON.stringify(result, null, 2) + stderr);
  assert.equal(result.success, true, JSON.stringify(result, null, 2) + stderr);
  assert.equal(result.checks.keyboardSave, true);
  assert.equal(result.checks.undoRedo, true);
  assert.equal(result.checks.findReplace, true);
  assert.equal(result.checks.originalConnection, true);
  assert.equal(result.checks.unsavedClose, true);
  assert.equal(result.checks.conflictPreservesDraft, true);
  assert.equal(result.checks.comparisonRechecksVersion, true);
  assert.equal(result.checks.disconnectPreservesDraft, true);
  assert.equal(result.checks.localCopy, true);
  assert.equal(result.checks.pendingSavePreservesNewEdits, true);
  assert.equal(result.checks.pendingSaveAndClosePreservesNewEdits, true);
  assert.equal(result.checks.jsonFormattingAndUndo, true);
  assert.equal(result.checks.comparisonPalette, true);
  assert.equal(result.checks.paletteFailurePreservesFileConflict, true);
  assert.equal(result.checks.palettePreservesEditor, true);
  assert.equal(result.checks.palettePending, true);
  assert.equal(result.checks.yamlPaletteColors, true);
  assert.equal(result.checks.jsonPaletteColors, true);
  assert.equal(result.checks.paletteThemeIndependence, true);
  assert.equal(result.checks.paletteSearchContrast, true);
  assert.equal(result.checks.paletteSmallWindow, true);
  assert.equal(result.checks.palettePreference, true);
  assert.deepEqual(result.rendererErrors, []);
});
