import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

const [mode, target, arch] = process.argv.slice(2);
const targets = { win: 'win32', mac: 'darwin', linux: 'linux' };
if (!['verify', 'collect'].includes(mode) || !Object.hasOwn(targets, target) || !['x64', 'arm64'].includes(arch)) {
  throw new Error('Usage: ci-artifacts.mjs verify|collect win|mac|linux x64|arm64');
}
if (process.platform !== targets[target] || process.arch !== arch) throw new Error(`Expected a native ${target}-${arch} runner; got ${process.platform}-${process.arch}`);
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid package version');
if (process.env.GITHUB_REF?.startsWith('refs/tags/') && process.env.GITHUB_REF !== `refs/tags/v${version}`) {
  throw new Error(`Tag ${process.env.GITHUB_REF} does not match package version ${version}`);
}
if (mode === 'verify') {
  console.log(`Verified native ${target}-${arch}, version ${version}`);
} else {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Invalid source revision');
  const extensions = target === 'win' ? ['zip'] : target === 'mac' ? ['zip', 'dmg'] : ['AppImage', 'deb'];
  const destination = path.resolve('release/artifacts');
  await fs.mkdir(destination, { recursive: true });
  const artifacts = [];
  for (const extension of extensions) {
    const filename = `gooeshell-${version}-${target}-${arch}.${extension}`;
    // electron-builder uses each Linux package format's architecture spelling.
    // Match that exact versioned file; keep the public download names consistent.
    const sourceArch = target === 'linux' && arch === 'x64'
      ? { AppImage: 'x86_64', deb: 'amd64' }[extension] : arch;
    const sourceFilename = `gooeshell-${version}-${target}-${sourceArch}.${extension}`;
    const source = path.resolve('release', sourceFilename);
    const size = (await fs.stat(source)).size;
    if (size === 0) throw new Error(`Empty artifact: ${filename}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(source)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    await fs.copyFile(source, path.join(destination, filename));
    artifacts.push({ filename, sourceFilename, bytes: size, sha256 });
  }
  const run = process.env.GITHUB_RUN_ID;
  const repository = process.env.GITHUB_REPOSITORY;
  const manifest = {
    name: 'gooeshell', version, revision, target, arch,
    runner: process.platform, node: process.version,
    ...(run && repository ? { buildUrl: `https://github.com/${repository}/actions/runs/${run}` } : {}),
    artifacts,
  };
  await fs.writeFile(path.join(destination, `BUILD-${target}-${arch}.json`), JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(destination, `SHA256-${target}-${arch}.txt`), artifacts.map(item => `${item.sha256}  ${item.filename}\n`).join(''));
  console.log(`Collected ${artifacts.length} packages for ${target}-${arch} at ${revision}`);
}
