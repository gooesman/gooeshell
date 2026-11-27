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

const jobs = api(`actions/runs/${runId}/jobs?per_page=100`).jobs;
for (const name of ['win-x64', 'linux-remote']) {
  assert.ok(jobs.some(job => job.name === name && job.conclusion === 'success'), `Missing successful job: ${name}`);
}
const artifacts = api(`actions/runs/${runId}/artifacts?per_page=100`);
assert.ok(artifacts.total_count <= 100, 'Unexpected artifact pagination');
const matches = artifacts.artifacts.filter(item => item.name === 'gooeshell-win-x64');
assert.equal(matches.length, 1, 'Missing or duplicate Windows build');
assert.equal(matches[0].expired, false);

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gooeshell-release-'));
console.log(`Downloading verified Windows run ${runId}, version ${version}, source ${revision}`);
gh(['run', 'download', runId, '-R', repository, '-n', 'gooeshell-win-x64', '-D', directory]);
const manifestFile = 'BUILD-win-x64.json';
const sumsFile = 'SHA256-win-x64.txt';
const manifest = JSON.parse(await fs.readFile(path.join(directory, manifestFile), 'utf8'));
const sums = await fs.readFile(path.join(directory, sumsFile), 'utf8');
for (const record of [manifest, manifest.packageValidation]) {
  assert.equal(record.version, version);
  assert.equal(record.revision, revision);
  assert.equal(record.target, 'win');
  assert.equal(record.arch, 'x64');
}
assert.equal(manifest.buildUrl, run.html_url);
assert.equal(manifest.packageValidation.success, true);
const zip = `GooeShell-${version}-win-x64.zip`;
assert.equal(manifest.artifacts.length, 1);
assert.equal(manifest.packageValidation.packages.length, 1);
const [item] = manifest.artifacts;
const [checked] = manifest.packageValidation.packages;
assert.equal(item.filename, zip);
assert.equal(item.sourceFilename, zip);
assert.equal(checked.name, zip);
assert.equal(checked.verified.launched, true);
assert.equal(checked.sha256, item.sha256);
assert.equal(checked.bytes, item.bytes);
const filename = path.join(directory, zip);
assert.equal((await fs.stat(filename)).size, item.bytes);
const hash = createHash('sha256');
for await (const chunk of createReadStream(filename)) hash.update(chunk);
assert.equal(hash.digest('hex'), item.sha256, `Checksum mismatch: ${zip}`);
assert.equal(sums.trimEnd(), `${item.sha256}  ${zip}`);
const files = [filename];
const expectedAssets = new Map([[zip, { size: item.bytes, digest: `sha256:${item.sha256}` }]]);
for (const name of [manifestFile, sumsFile]) {
  const file = path.join(directory, name);
  files.push(file);
  const bytes = await fs.readFile(file);
  expectedAssets.set(name, { size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
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
  gh(['release', 'create', tag, '-R', repository, '--target', revision, '--title', `GooeShell ${version}`, '--notes-file', notes, '--draft']);
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
gh(['release', 'edit', tag, '-R', repository, '--title', `GooeShell ${version}`, '--notes-file', notes, '--draft=false', '--prerelease=false', '--latest']);
const published = api(`releases/tags/${tag}`);
assert.equal(published.draft, false);
assert.equal(published.prerelease, false);
console.log(`Published ${published.html_url} with ${published.assets.length} verified assets`);
