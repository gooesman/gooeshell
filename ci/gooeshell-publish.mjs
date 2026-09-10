import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GOOESHELL_BUILD_RUN_ID;
const tag = process.env.GOOESHELL_RELEASE_TAG;
assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
assert.match(runId ?? '', /^[1-9][0-9]*$/);
assert.match(tag ?? '', /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Draft uploads must be dispatched from main');
const version = tag.slice(1);
const base = `repos/${repository}`;
const gh = async args => {
  const { stdout } = await execute('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return stdout;
};
const api = async endpoint => JSON.parse(await gh(['api', endpoint]));
const run = await api(`${base}/actions/runs/${runId}`);
assert.equal(String(run.id), runId);
assert.equal(run.status, 'completed');
assert.equal(run.conclusion, 'success');
assert.equal(run.path, '.github/workflows/gooeshell-windows.yml');
assert.equal(run.repository?.full_name, repository);
assert.equal(run.head_repository?.full_name, repository);
assert.equal(run.event, 'push');
assert.equal(run.head_branch, 'main');
assert.match(run.head_sha, /^[0-9a-f]{40}$/);
const revision = run.head_sha;
async function verifiedDraft() {
  // Unpublished drafts have no resolvable tag endpoint yet.
  const releases = await api(`${base}/releases?per_page=100`);
  const matches = releases.filter(release => release.tag_name === tag && release.draft);
  assert.equal(matches.length, 1, 'Expected exactly one existing draft with this tag');
  const release = matches[0];
  assert.equal(release.tag_name, tag);
  assert.equal(release.draft, true, 'Only an existing unpublished draft may receive files');
  assert.equal(release.target_commitish, revision, 'Draft release must target the exact verified source revision');
  return release;
}
const initialDraft = await verifiedDraft();
const configurations = [
  { target: 'win', arch: 'x64', runner: 'win32', extensions: ['zip'] },
  { target: 'mac', arch: 'arm64', runner: 'darwin', extensions: ['zip', 'dmg'] },
  { target: 'mac', arch: 'x64', runner: 'darwin', extensions: ['zip', 'dmg'] },
  { target: 'linux', arch: 'x64', runner: 'linux', extensions: ['AppImage', 'deb'] },
];
const listing = await api(`${base}/actions/runs/${runId}/artifacts?per_page=100`);
assert.ok(listing.total_count <= 100, 'Unexpected artifact listing size');
for (const { target, arch } of configurations) {
  const name = `gooeshell-${target}-${arch}`;
  const matches = listing.artifacts.filter(item => item.name === name && !item.expired);
  assert.equal(matches.length, 1, `Expected exactly one current artifact named ${name}`);
  assert.equal(String(matches[0].workflow_run?.id), runId);
  assert.equal(matches[0].workflow_run?.head_sha, revision);
}
const tempBase = await fs.realpath(os.tmpdir());
const temporary = await fs.mkdtemp(path.join(tempBase, 'gooeshell-draft-'));
const uploads = [];
async function readMetadata(filename) {
  const stat = await fs.lstat(filename);
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 256 * 1024, `Invalid metadata file: ${path.basename(filename)}`);
  return fs.readFile(filename, 'utf8');
}
try {
  for (const { target, arch, runner, extensions } of configurations) {
    const directory = path.join(temporary, `${target}-${arch}`);
    await fs.mkdir(directory);
    await gh(['run', 'download', runId, '--repo', repository, '--name', `gooeshell-${target}-${arch}`, '--dir', directory]);
    const manifestName = `BUILD-${target}-${arch}.json`;
    const checksumName = `SHA256-${target}-${arch}.txt`;
    const filenames = extensions.map(extension => `gooeshell-${version}-${target}-${arch}.${extension}`);
    const allowed = [...filenames, manifestName, checksumName];
    assert.deepEqual((await fs.readdir(directory)).sort(), [...allowed].sort(), `Unexpected files in ${target}-${arch} artifact`);
    const manifest = JSON.parse(await readMetadata(path.join(directory, manifestName)));
    assert.equal(manifest.name, 'gooeshell');
    assert.equal(manifest.version, version);
    assert.equal(manifest.revision, revision);
    assert.equal(manifest.target, target);
    assert.equal(manifest.arch, arch);
    assert.equal(manifest.runner, runner);
    assert.equal(manifest.buildUrl, `https://github.com/${repository}/actions/runs/${runId}`);
    assert.ok(Array.isArray(manifest.artifacts));
    assert.deepEqual(manifest.artifacts.map(item => item.filename).sort(), [...filenames].sort());
    const checksums = [];
    for (const filename of filenames) {
      const item = manifest.artifacts.find(item => item.filename === filename);
      assert.ok(Number.isSafeInteger(item.bytes) && item.bytes > 0);
      assert.match(item.sha256, /^[0-9a-f]{64}$/);
      const extension = filename.slice(filename.lastIndexOf('.') + 1);
      const sourceArch = target === 'linux' ? { AppImage: 'x86_64', deb: 'amd64' }[extension] : arch;
      assert.equal(item.sourceFilename, `gooeshell-${version}-${target}-${sourceArch}.${extension}`);
      const file = path.join(directory, filename);
      const stat = await fs.lstat(file);
      assert.ok(stat.isFile(), `Package must be a regular file: ${filename}`);
      assert.equal(stat.size, item.bytes, `Package length mismatch: ${filename}`);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      assert.equal(hash.digest('hex'), item.sha256, `Package digest mismatch: ${filename}`);
      checksums.push(`${item.sha256}  ${filename}`);
    }
    const recorded = (await readMetadata(path.join(directory, checksumName))).trimEnd().split(/\r?\n/);
    assert.deepEqual(recorded.sort(), checksums.sort(), `Checksum list mismatch: ${target}-${arch}`);
    uploads.push(...allowed.map(filename => path.join(directory, filename)));
    console.log(`Verified ${target}-${arch}: ${filenames.length} packages`);
  }
  assert.equal(uploads.length, 15, 'Expected seven packages, four build manifests and four checksum files');
  assert.equal(new Set(uploads.map(filename => path.basename(filename))).size, uploads.length);
  const draft = await verifiedDraft();
  assert.equal(draft.id, initialDraft.id, 'Draft release changed during verification');
  await gh(['release', 'upload', tag, '--repo', repository, '--clobber', ...uploads]);
  const uploaded = await verifiedDraft();
  assert.equal(uploaded.id, initialDraft.id);
  for (const filename of uploads) {
    const name = path.basename(filename);
    const matches = uploaded.assets.filter(asset => asset.name === name);
    assert.equal(matches.length, 1, `Missing or duplicate uploaded asset: ${name}`);
    assert.equal(matches[0].state, 'uploaded');
    assert.equal(matches[0].size, (await fs.stat(filename)).size);
  }
  console.log(`Uploaded 15 verified files to draft ${tag}. The release remains unpublished.`);
} finally {
  assert.equal(path.dirname(temporary), tempBase);
  assert.ok(path.basename(temporary).startsWith('gooeshell-draft-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
