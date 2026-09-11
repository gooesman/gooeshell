import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repository = process.env.GITHUB_REPOSITORY;
const version = process.env.RELEASE_VERSION;
const runId = process.env.SOURCE_RUN;
assert.equal(repository, 'gooesman/gooeshell');
assert.match(version || '', /^\d+\.\d+\.\d+$/);
assert.match(runId || '', /^\d+$/);
const tag = `v${version}`;
const notes = path.resolve('.github/release-notes', `${tag}.md`);
await fs.access(notes);

function gh(args, missingOk = false) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (missingOk && result.stderr.includes('(HTTP 404)')) return undefined;
    throw new Error(`GitHub CLI failed: ${result.stderr}`);
  }
  return result.stdout;
}
const api = (endpoint, missingOk = false) => {
  const text = gh(['api', `repos/${repository}/${endpoint}`], missingOk);
  return text === undefined ? undefined : JSON.parse(text);
};
// The tag endpoint cannot find a draft whose tag is still pending creation.
// Authenticated release listings include drafts and let retries reuse their ID.
function findRelease() {
  for (let page = 1; page <= 20; page++) {
    const releases = api(`releases?per_page=100&page=${page}`);
    const matches = releases.filter(release => release.tag_name === tag);
    assert.ok(matches.length <= 1, 'Ambiguous release tag');
    if (matches.length) return matches[0];
    if (releases.length < 100) return undefined;
  }
  throw new Error('Release lookup exceeded its page limit');
}

const run = api(`actions/runs/${runId}`);
assert.equal(run.status, 'completed');
assert.equal(run.conclusion, 'success');
assert.equal(run.path, '.github/workflows/gooeshell-windows.yml');
assert.equal(run.event, 'push');
assert.equal(run.head_branch, 'main');
assert.equal(run.head_repository.full_name, repository);
assert.match(run.head_sha, /^[a-f0-9]{40}$/);
const revision = run.head_sha;
const source = api(`contents/desktop/package.json?ref=${revision}`);
assert.equal(JSON.parse(Buffer.from(source.content, 'base64').toString()).version, version);

const platforms = [['win','x64'], ['mac','arm64'], ['mac','x64'], ['linux','x64']];
const artifacts = api(`actions/runs/${runId}/artifacts?per_page=100`);
assert.ok(artifacts.total_count <= 100, 'Unexpected artifact pagination');
for (const [target, arch] of platforms) {
  const matches = artifacts.artifacts.filter(item => item.name === `gooeshell-${target}-${arch}`);
  assert.equal(matches.length, 1, `Missing or duplicate ${target}-${arch} build`);
  assert.equal(matches[0].expired, false);
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gooeshell-release-'));
console.log(`Downloading verified run ${runId}, version ${version}, source ${revision}`);
gh(['run', 'download', runId, '-R', repository, '-p', 'gooeshell-*', '-D', directory]);
const files = [];
const expectedAssets = new Map();
for (const [target, arch] of platforms) {
  const folder = path.join(directory, `gooeshell-${target}-${arch}`);
  const manifestFile = `BUILD-${target}-${arch}.json`;
  const sumsFile = `SHA256-${target}-${arch}.txt`;
  const manifest = JSON.parse(await fs.readFile(path.join(folder, manifestFile), 'utf8'));
  const sums = await fs.readFile(path.join(folder, sumsFile), 'utf8');
  assert.equal(manifest.version, version);
  assert.equal(manifest.revision, revision);
  assert.equal(manifest.target, target);
  assert.equal(manifest.arch, arch);
  assert.equal(manifest.buildUrl, run.html_url);
  const extensions = target === 'win' ? ['zip'] : target === 'mac' ? ['zip', 'dmg'] : ['AppImage', 'deb'];
  assert.deepEqual(manifest.artifacts.map(item => item.filename).sort(), extensions.map(ext => `gooeshell-${version}-${target}-${arch}.${ext}`).sort());
  for (const item of manifest.artifacts) {
    const filename = path.join(folder, item.filename);
    assert.equal((await fs.stat(filename)).size, item.bytes);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    assert.equal(hash.digest('hex'), item.sha256, `Checksum mismatch: ${item.filename}`);
    assert.ok(sums.split('\n').includes(`${item.sha256}  ${item.filename}`));
    files.push(filename);
    expectedAssets.set(item.filename, { size: item.bytes, digest: `sha256:${item.sha256}` });
  }
  for (const name of [manifestFile, sumsFile]) {
    const filename = path.join(folder, name);
    files.push(filename);
    const bytes = await fs.readFile(filename);
    expectedAssets.set(name, { size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
  }
}

const ref = api(`git/ref/tags/${tag}`, true);
if (ref) {
  let object = ref.object;
  for (let count = 0; object.type === 'tag' && count < 5; count++) object = api(`git/tags/${object.sha}`).object;
  assert.equal(object.type, 'commit');
  assert.equal(object.sha, revision, 'Existing release tag points to different source');
}
const existing = findRelease();
if (existing) {
  assert.equal(existing.draft, true, 'Refusing to change a published release');
  assert.equal(existing.target_commitish, revision, 'Draft belongs to a different source');
} else {
  gh(['release', 'create', tag, '-R', repository, '--target', revision, '--title', `gooeshell ${version}`, '--notes-file', notes, '--draft']);
}
gh(['release', 'upload', tag, ...files, '-R', repository, '--clobber']);
const draft = findRelease();
assert.ok(draft, 'Uploaded release draft was not found');
assert.equal(draft.draft, true);
assert.equal(draft.assets.length, expectedAssets.size);
for (const asset of draft.assets) {
  const expected = expectedAssets.get(asset.name);
  assert.ok(expected, `Unexpected release asset ${asset.name}`);
  assert.equal(asset.state, 'uploaded');
  assert.equal(asset.size, expected.size);
  if (asset.digest) assert.equal(asset.digest, expected.digest);
}
gh(['release', 'edit', tag, '-R', repository, '--notes-file', notes, '--draft=false', '--prerelease=false', '--latest']);
const published = api(`releases/tags/${tag}`);
assert.equal(published.draft, false);
assert.equal(published.prerelease, false);
console.log(`Published ${published.html_url} with ${published.assets.length} verified assets`);
