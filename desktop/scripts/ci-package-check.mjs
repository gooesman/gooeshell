import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

const [target, arch] = process.argv.slice(2);
assert.equal(process.platform, { win: 'win32', mac: 'darwin', linux: 'linux' }[target], 'Package checks require their native OS');
assert.equal(process.arch, arch, 'Package checks require the native architecture');
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
const release = path.resolve(process.env.GOOESHELL_PACKAGE_RELEASE || 'release');
const output = path.resolve('test-output'); await fs.mkdir(output, { recursive: true });
const work = await fs.mkdtemp(path.join(output, 'package-install-'));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
const result = { success: false, target, arch, version, revision, packages: [], smokeRuns: [] };
const report = path.join(output, `package-install-${target}-${arch}.json`);

async function hash(file) {
  const value = createHash('sha256');
  for await (const chunk of createReadStream(file)) value.update(chunk);
  return value.digest('hex');
}
async function smoke({ executable, runtimeExecutable = executable, label }) {
  assert.match(label, /^[a-zA-Z0-9-]+$/);
  const child = spawn(process.execPath, ['scripts/ci-smoke.mjs', target, arch], {
    env: { ...process.env, GOOESHELL_SMOKE_EXECUTABLE: executable, GOOESHELL_SMOKE_NODE_EXECUTABLE: runtimeExecutable, GOOESHELL_SMOKE_PACKAGE: label },
    windowsHide: true, stdio: 'inherit',
  });
  const timeout = setTimeout(() => child.kill(), 70_000); timeout.unref();
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  }).finally(() => clearTimeout(timeout));
  assert.equal(exit, 0, `The application extracted from ${label} must launch and pass its IPC/file checks`);
  const smokeReport = `smoke-${target}-${arch}-${label}.json`;
  const data = JSON.parse(await fs.readFile(path.join(output, smokeReport), 'utf8'));
  assert.equal(data.success, true); assert.equal(data.version, version);
  result.smokeRuns.push({ label, report: smokeReport, elapsedMs: data.elapsedMs });
}
async function windowsPackages() {
  assert.equal(arch, 'x64');
  const name = `gooeshell-${version}-win-${arch}.zip`, source = path.join(release, name);
  const destination = path.join(work, 'zip'); await fs.mkdir(destination);
  // Paths travel as environment data, never as PowerShell source text.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; Expand-Archive -LiteralPath $env:GOOESHELL_PACKAGE_SOURCE -DestinationPath $env:GOOESHELL_PACKAGE_DESTINATION'], {
    env: { ...process.env, GOOESHELL_PACKAGE_SOURCE: source, GOOESHELL_PACKAGE_DESTINATION: destination },
    windowsHide: true, timeout: 120_000, stdio: 'pipe',
  });
  const executable = path.join(destination, 'gooeshell.exe');
  const handle = await fs.open(executable, 'r');
  const header = Buffer.alloc(4096);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  assert.equal(header.toString('ascii', 0, 2), 'MZ');
  const pe = header.readUInt32LE(0x3c); assert.ok(pe + 6 <= header.length);
  assert.equal(header.toString('ascii', pe, pe + 4), 'PE\0\0');
  assert.equal(header.readUInt16LE(pe + 4), 0x8664, 'Portable executable must be x64');
  const binaryVersion = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '(Get-Item -LiteralPath $env:GOOESHELL_PACKAGE_EXECUTABLE).VersionInfo.FileVersion'], {
    env: { ...process.env, GOOESHELL_PACKAGE_EXECUTABLE: executable }, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  }).trim();
  assert.equal(binaryVersion, version);
  for (const resource of ['icon.ico', 'icon.png', 'README.md', 'VALIDATION.md', 'PERFORMANCE.md', 'LICENSE-gooeshell.txt']) {
    assert.ok((await fs.stat(path.join(destination, 'resources', resource))).size > 0, `Missing package resource ${resource}`);
  }
  assert.equal((await fs.readFile(path.join(destination, 'BUILD.txt'), 'utf8')).trim(), revision);
  const payload = await hash(path.join(destination, 'resources', 'app.asar'));
  assert.equal(payload, await hash(path.join(release, 'win-unpacked/resources/app.asar')), 'Portable ZIP payload must match the tested build');
  await smoke({ executable, label: 'zip' });
  return [{ name, bytes: (await fs.stat(source)).size, sha256: await hash(source), payloadSha256: payload,
    verified: { extraction: true, architecture: true, version: true, resources: true, revision: true, payload: true, launched: true } }];
}
try {
  result.packages = target === 'win' ? await windowsPackages()
    : target === 'mac' ? await (await import('./package-check-mac.mjs')).verifyMacPackages({ release, version, arch, work, smoke })
    : await (await import('./package-check-linux.mjs')).verifyLinuxPackages({ release, version, arch, work, smoke });
  assert.equal(result.packages.length, target === 'win' ? 1 : 2);
  assert.equal(result.smokeRuns.length, result.packages.length);
  result.success = true;
  console.log(`Distribution package checks passed: ${target}-${arch}, ${result.packages.length} extracted applications launched`);
} catch (error) {
  result.error = error.stack || String(error); process.exitCode = 1; console.error(error);
} finally {
  await fs.writeFile(report, JSON.stringify(result, null, 2) + '\n');
}
