import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { finishRendererFixture } = createRequire(import.meta.url)('./fixtures/renderer-fixture-report.cjs');

async function reportPath() {
  const root = path.resolve('../.build'); await fs.mkdir(root, { recursive: true });
  return path.join(await fs.mkdtemp(path.join(root, 'renderer-report-')), 'result.json');
}

for (const success of [true, false]) test(`renderer exits only after publishing the complete ${success ? 'success' : 'failure'} report`, async () => {
  const report = await reportPath(), result = { success, error: success ? undefined : 'Original rendering assertion failed', text: '完整报告'.repeat(5000) };
  const exits: number[] = [];
  await finishRendererFixture({ exit(code: number) {
    assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')), JSON.parse(JSON.stringify(result)));
    assert.equal(existsSync(report + '.tmp'), false);
    exits.push(code);
  } }, report, result);
  assert.deepEqual(exits, [success ? 0 : 1]);
});

test('report write failure exits unsuccessfully and preserves the previous complete report', async t => {
  const report = await reportPath(), previous = { success: false, error: 'previous complete diagnostics' };
  await fs.writeFile(report, JSON.stringify(previous));
  await fs.mkdir(report + '.tmp');
  const exits: number[] = [], errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  await finishRendererFixture({ exit: (code: number) => exits.push(code) }, report, { success: true });
  assert.deepEqual(exits, [1]); assert.equal(errors.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(report, 'utf8')), previous);
});
