import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const resources = [
  'app.asar', 'icon.png', 'icon.ico', 'LICENSE-gooeshell.txt', 'UPSTREAM.md',
  'README.md', 'VALIDATION.md', 'PERFORMANCE.md',
];

async function command(executable, args, timeout = 120_000) {
  try {
    const { stdout } = await execute(executable, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    throw new Error(`${path.basename(executable)} ${args.join(' ')} failed: ${error.stderr || error.stdout || error.message}`, { cause: error });
  }
}

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(filename)) hash.update(data);
  return hash.digest('hex');
}

async function regularFile(filename) {
  const information = await fs.stat(filename);
  assert.ok(information.isFile() && information.size > 0, `Missing or empty package file: ${filename}`);
  return information;
}

async function bundleFile(app, relative) {
  const filename = path.join(app, relative), resolved = await fs.realpath(filename);
  assert.ok(resolved.startsWith(app + path.sep), `Bundle file escapes the extracted application: ${filename}`);
  await regularFile(filename);
  return filename;
}

async function verifyApplication(application, version, arch, expectedAsar) {
  assert.ok((await fs.lstat(application)).isDirectory(), `Expected an extracted application directory: ${application}`);
  const app = await fs.realpath(application);
  const executable = await bundleFile(app, 'Contents/MacOS/gooeshell');
  const plist = await bundleFile(app, 'Contents/Info.plist');
  const readProperty = key => command('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
  const [shortVersion, bundleVersion, bundleExecutable, identifier, architectures] = await Promise.all([
    readProperty('CFBundleShortVersionString'), readProperty('CFBundleVersion'),
    readProperty('CFBundleExecutable'), readProperty('CFBundleIdentifier'),
    command('/usr/bin/lipo', ['-archs', executable]),
  ]);
  assert.equal(shortVersion, version, 'Extracted application release version differs from the package version');
  assert.equal(bundleVersion, version, 'Extracted application build version differs from the package version');
  assert.equal(bundleExecutable, 'gooeshell', 'Unexpected executable declared in the packaged Info.plist');
  assert.equal(identifier, 'com.gooesman.gooeshell', 'Unexpected packaged application identifier');
  assert.deepEqual(architectures.split(/\s+/).sort(), [arch === 'x64' ? 'x86_64' : 'arm64'], 'Packaged Mach-O architecture does not match its filename');
  await fs.access(executable, constants.X_OK);
  // The project uses ad-hoc signing. Verify the signed bundle and nested code;
  // this does not claim Apple notarization or bypass Gatekeeper.
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  for (const name of resources) await bundleFile(app, path.join('Contents/Resources', name));
  const asarSha256 = await sha256(path.join(app, 'Contents/Resources/app.asar'));
  assert.equal(asarSha256, expectedAsar, 'Distributed app.asar differs from the verified unpacked build');
  return {
    executable, asarSha256, bundleVersion, architectures: architectures.split(/\s+/),
    verified: { architecture: true, version: true, signature: true, resources: true, asarMatchesUnpacked: true },
  };
}

/** Validate and launch the actual ZIP and DMG without installing into /Applications. */
export async function verifyMacPackages({ release, version, arch, work, smoke }) {
  assert.equal(process.platform, 'darwin', 'Mac package verification requires a native macOS runner');
  assert.ok(['x64', 'arm64'].includes(arch), 'Unsupported Mac package architecture');
  assert.equal(process.arch, arch, 'Mac packages must be launched on their native architecture');
  assert.match(version, /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/, 'Invalid package version');
  assert.equal(typeof smoke, 'function', 'A packaged application smoke callback is required');
  assert.ok(path.isAbsolute(release) && path.isAbsolute(work), 'Package and validation directories must be absolute');
  const releaseRoot = await fs.realpath(release);
  await fs.mkdir(work, { recursive: true });
  const workRoot = await fs.realpath(work);
  const isolated = await fs.mkdtemp(path.join(workRoot, 'mac-packages-'));
  const zipDirectory = path.join(isolated, 'zip'), dmgDirectory = path.join(isolated, 'dmg'), mount = path.join(isolated, 'mount');
  for (const directory of [zipDirectory, dmgDirectory, mount]) await fs.mkdir(directory);
  assert.ok((await fs.realpath(mount)).startsWith(isolated + path.sep), 'DMG mount must remain within its private validation directory');
  const originalAsar = path.join(releaseRoot, arch === 'arm64' ? 'mac-arm64' : 'mac', 'gooeshell.app/Contents/Resources/app.asar');
  await regularFile(originalAsar);
  const expectedAsar = await sha256(originalAsar);
  const results = [];

  for (const format of ['zip', 'dmg']) {
    const name = `gooeshell-${version}-mac-${arch}.${format}`, source = path.join(releaseRoot, name);
    const information = await regularFile(source);
    const packageHash = await sha256(source);
    let application;
    if (format === 'zip') {
      await command('/usr/bin/ditto', ['-x', '-k', source, zipDirectory]);
      application = path.join(zipDirectory, 'gooeshell.app');
    } else {
      await command('/usr/bin/hdiutil', ['verify', source]);
      let originalError;
      try {
        // Even if attach fails after creating the volume, the finally block
        // attempts to detach only this freshly created, controlled mount path.
        await command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, source]);
        const mountedApp = path.join(mount, 'gooeshell.app');
        assert.ok((await fs.lstat(mountedApp)).isDirectory(), 'DMG must contain a real gooeshell.app directory');
        application = path.join(dmgDirectory, 'gooeshell.app');
        await command('/usr/bin/ditto', [mountedApp, application]);
      } catch (error) {
        originalError = error;
      } finally {
        try { await command('/usr/bin/hdiutil', ['detach', mount], 30_000); }
        catch (error) {
          throw new AggregateError(originalError ? [originalError, error] : [error], 'DMG validation could not detach its private mount');
        }
      }
      if (originalError) throw originalError;
    }
    const checked = await verifyApplication(application, version, arch, expectedAsar);
    const smokeResult = await smoke({ executable: checked.executable, label: format });
    if (smokeResult?.success === false) throw new Error(`${name} smoke check reported failure`);
    results.push({
      name, sha256: packageHash, bytes: information.size, format,
      asarSha256: checked.asarSha256, bundleVersion: checked.bundleVersion, architectures: checked.architectures,
      executable: checked.executable,
      verified: { container: true, ...checked.verified, launched: true, ...(format === 'dmg' ? { detachedBeforeLaunch: true } : {}) },
    });
  }
  return results;
}
