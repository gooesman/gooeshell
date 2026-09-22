import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { extractFile } from '@electron/asar';

const execute = promisify(execFile);
const isWithin = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function fileWithin(root, relative) {
  const candidate = await fs.realpath(path.join(root, relative));
  assert.ok(isWithin(root, candidate), `Package path escapes its extraction directory: ${relative}`);
  const stat = await fs.stat(candidate);
  assert.ok(stat.isFile() && stat.size > 0, `Missing or empty package file: ${candidate}`);
  return { file: candidate, stat };
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function header(file) {
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(64);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    assert.equal(bytesRead, bytes.length, `Truncated executable: ${file}`);
    return bytes;
  } finally { await handle.close(); }
}

async function requireElfX64(file) {
  const bytes = await header(file);
  assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46', `Not an ELF executable: ${file}`);
  assert.equal(bytes[4], 2, `Expected ELF64: ${file}`);
  assert.equal(bytes[5], 1, `Expected little-endian ELF: ${file}`);
  assert.equal(bytes.readUInt16LE(18), 62, `Expected x86-64 ELF machine: ${file}`);
  assert.ok([2, 3].includes(bytes.readUInt16LE(16)), `Expected executable or position-independent executable ELF: ${file}`);
  assert.ok((await fs.stat(file)).mode & 0o111, `Executable permission is missing: ${file}`);
  return bytes;
}

async function inspectApplication(root, executableRelative, version, expectedAsar) {
  const { file: executable } = await fileWithin(root, executableRelative);
  await requireElfX64(executable);
  const resourcesRelative = path.join(path.dirname(executableRelative), 'resources');
  const { file: asar } = await fileWithin(root, path.join(resourcesRelative, 'app.asar'));
  const payloadSha256 = await sha256(asar);
  assert.equal(payloadSha256, expectedAsar, 'Extracted package payload differs from the verified linux-unpacked application');
  const metadata = JSON.parse(extractFile(asar, 'package.json').toString('utf8'));
  assert.equal(metadata.name, 'gooeshell', 'Unexpected application name in package metadata');
  assert.equal(metadata.version, version, 'Extracted package contains another application version');
  assert.equal(metadata.main, 'dist-main/main/main.js', 'Unexpected packaged application entry point');
  // These resources are used by the packaged application and must travel with it.
  await fileWithin(root, path.join(resourcesRelative, 'icon.png'));
  await fileWithin(root, path.join(resourcesRelative, 'LICENSE-gooeshell.txt'));
  return { executable, payloadSha256 };
}

async function inspectDebDesktopEntry(root) {
  const { file } = await fileWithin(root, 'usr/share/applications/gooeshell.desktop');
  const entries = new Map();
  let section = '';
  for (const line of (await fs.readFile(file, 'utf8')).split(/\r?\n/)) {
    const heading = line.match(/^\[([^\]]+)\]\s*$/);
    if (heading) { section = heading[1]; continue; }
    if (section !== 'Desktop Entry' || /^\s*[#;]/.test(line)) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    assert.ok(!entries.has(key), `Duplicate desktop-entry field: ${key}`);
    entries.set(key, line.slice(separator + 1).trim());
  }
  assert.equal(entries.get('Type'), 'Application', 'Debian desktop entry must launch an application');
  assert.equal(entries.get('Exec'), '/opt/gooeshell/gooeshell %U', 'Debian desktop entry must target the packaged executable');
  assert.equal(entries.get('Icon'), 'gooeshell', 'Debian desktop entry must use its packaged application icon');
}

/** Validate the actual Linux distributables without installing them or using FUSE.
 * The caller's smoke callback must launch with a fresh, isolated user-data path
 * and throw on failed startup/version/IPC checks. runtimeExecutable is reserved
 * for the separate ELECTRON_RUN_AS_NODE dependency check; GUI launch uses the
 * distributable's actual launcher. System installation hooks are not executed. */
export async function verifyLinuxPackages({ release, version, arch, work, smoke }) {
  assert.equal(process.platform, 'linux', 'Linux package checks require a native Linux runner');
  assert.equal(process.arch, 'x64', 'Linux package checks currently require a native x64 runner');
  assert.equal(arch, 'x64', 'Linux distributable checks currently support x64 only');
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Invalid package version');
  assert.equal(typeof smoke, 'function', 'An isolated packaged-application smoke callback is required');
  assert.ok(typeof release === 'string' && release.length > 0 && typeof work === 'string' && work.length > 0, 'Explicit release and verification work directories are required');
  const releaseRoot = await fs.realpath(path.resolve(release));
  await fs.mkdir(path.resolve(work), { recursive: true });
  const workRoot = await fs.realpath(path.resolve(work));
  assert.ok(workRoot !== releaseRoot && !isWithin(releaseRoot, workRoot), 'Package verification must use a work directory outside release');
  // mkdtemp prevents an older extraction from satisfying a check or being replaced.
  const extracted = await fs.mkdtemp(path.join(workRoot, 'linux-packages-'));
  const { file: referenceAsar } = await fileWithin(releaseRoot, 'linux-unpacked/resources/app.asar');
  const expectedAsar = await sha256(referenceAsar);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.GOOESHELL_DEV_URL;
  const commandOptions = { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
  const results = [];

  const appImageName = `gooeshell-${version}-linux-x86_64.AppImage`;
  const { file: appImage, stat: appImageStat } = await fileWithin(releaseRoot, appImageName);
  const appImageHeader = await requireElfX64(appImage);
  assert.equal(appImageHeader.subarray(8, 11).toString('hex'), '414902', 'Expected a type-2 AppImage');
  const appImageSha256 = await sha256(appImage);
  const imageWork = path.join(extracted, 'AppImage'); await fs.mkdir(imageWork);
  await execute(appImage, ['--appimage-extract'], { ...commandOptions, cwd: imageWork });
  const imageRoot = await fs.realpath(path.join(imageWork, 'squashfs-root'));
  assert.ok(isWithin(imageWork, imageRoot), 'AppImage extraction root escapes verification work');
  const { file: appRun, stat: appRunStat } = await fileWithin(imageRoot, 'AppRun');
  assert.ok(appRunStat.mode & 0o111, 'Extracted AppRun must be executable');
  const appRunHeader = await header(appRun);
  if (appRunHeader.subarray(0, 4).toString('hex') === '7f454c46') await requireElfX64(appRun);
  else assert.equal(appRunHeader.subarray(0, 2).toString(), '#!', 'AppRun must be an ELF executable or a launcher script');
  const image = await inspectApplication(imageRoot, 'gooeshell', version, expectedAsar);
  // electron-builder's AppRun finds APPDIR from its own path when unset and
  // applies its packaged library paths. Exercise that actual entry point.
  // Its automatic --no-sandbox argument is inappropriate in Node-only mode,
  // so the caller uses the core executable only for that separate check.
  await smoke({ executable: appRun, runtimeExecutable: image.executable, label: 'AppImage' });
  results.push({ name: appImageName, bytes: appImageStat.size, sha256: appImageSha256,
    checks: { extractedWithoutFuse: true, appRun: true, elfX64: true, versionMetadata: true, payloadMatchesUnpacked: true, payloadSha256: image.payloadSha256, isolatedLaunch: true } });

  const debName = `gooeshell-${version}-linux-amd64.deb`;
  const { file: deb, stat: debStat } = await fileWithin(releaseRoot, debName);
  const debSha256 = await sha256(deb);
  const fields = await Promise.all(['Package', 'Version', 'Architecture'].map(async field => {
    const { stdout } = await execute('dpkg-deb', ['-f', deb, field], commandOptions);
    return stdout.trim();
  }));
  assert.deepEqual(fields, ['gooeshell', version, 'amd64'], 'Debian package name/version/architecture does not match this release');
  const debWork = path.join(extracted, 'deb'); await fs.mkdir(debWork);
  await execute('dpkg-deb', ['-x', deb, debWork], commandOptions);
  const debRoot = await fs.realpath(debWork);
  assert.ok(isWithin(extracted, debRoot), 'Debian extraction root escapes verification work');
  const debApplication = await inspectApplication(debRoot, 'opt/gooeshell/gooeshell', version, expectedAsar);
  await inspectDebDesktopEntry(debRoot);
  await smoke({ executable: debApplication.executable, label: 'deb' });
  results.push({ name: debName, bytes: debStat.size, sha256: debSha256,
    checks: { extractedWithoutInstall: true, controlMetadata: true, desktopEntry: true, elfX64: true, versionMetadata: true, payloadMatchesUnpacked: true, payloadSha256: debApplication.payloadSha256, isolatedLaunch: true } });
  return results;
}
