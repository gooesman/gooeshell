import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { allowsUnsupportedGpuSkip } = createRequire(import.meta.url)('./fixtures/terminal-gpu-policy.cjs');
const hostedIntel = { platform: 'darwin', arch: 'x64', githubActions: 'true', runnerEnvironment: 'github-hosted' };
const noContext = { status: 'unavailable', contextCreated: false };

test('GPU coverage skip requires a measured unavailable context on hosted GitHub macOS Intel', () => {
  assert.equal(allowsUnsupportedGpuSkip(hostedIntel, noContext), true);
  for (const change of [{ platform: 'win32' }, { platform: 'linux' }, { arch: 'arm64' }, { githubActions: undefined }, { githubActions: 'false' }, { runnerEnvironment: undefined }, { runnerEnvironment: 'self-hosted' }]) {
    assert.equal(allowsUnsupportedGpuSkip({ ...hostedIntel, ...change }, noContext), false, JSON.stringify(change));
  }
});

test('GPU success, lost contexts, readback errors and xterm failures cannot become capability skips', () => {
  for (const probe of [undefined, {}, { status: 'available', contextCreated: true }, { status: 'unavailable', contextCreated: true }, { status: 'readback-error', contextCreated: true }, { status: 'lost-context', contextCreated: true }, { status: 'error', contextCreated: false }]) {
    assert.equal(allowsUnsupportedGpuSkip(hostedIntel, probe), false, JSON.stringify(probe));
  }
});
