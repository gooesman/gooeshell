import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createLocalFile, createLocalDirectory, localMutationPath, remoteMutationPath, removeLocalFile } from '../src/main/file-mutations';
import { SshService } from '../src/main/ssh-service';

async function fixture(run: (directory: string) => Promise<void>) {
  const base = path.resolve('test-output');
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'file-mutations-'));
  try { await run(directory); }
  finally { assert.ok(directory.startsWith(base + path.sep)); await fs.rm(directory, { recursive: true, force: true }); }
}

test('explorer paths reject roots, relative and dot paths before mutation', () => {
  for (const target of ['/', '////', '.', '..', 'relative.txt', '/tmp/../', '/tmp/.', '/tmp/x\0y']) assert.throws(() => remoteMutationPath(target));
  for (const target of [path.parse(path.resolve('.')).root, '.', '..', 'relative.txt', path.resolve('.') + path.sep + '..']) assert.throws(() => localMutationPath(target));
  assert.equal(remoteMutationPath('/tmp/中文 file.txt'), '/tmp/中文 file.txt');
  if (process.platform === 'win32') for (const target of ['C:\\', '\\\\server\\share\\', '\\\\?\\C:\\file', 'C:\\file:stream']) assert.throws(() => localMutationPath(target));
});

test('exclusive local creation preserves existing files and directories', async () => fixture(async root => {
  const file = path.join(root, '中文 file.txt');
  await createLocalFile(file);
  assert.equal((await fs.stat(file)).size, 0);
  await fs.writeFile(file, 'keep');
  await assert.rejects(createLocalFile(file), /已存在/);
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
  const directory = path.join(root, 'new-directory');
  await createLocalDirectory(directory);
  await assert.rejects(createLocalDirectory(directory), /已存在/);
  await assert.rejects(createLocalFile(directory), /已存在/);
  await assert.rejects(createLocalFile(path.join(root, 'missing', 'child.txt')), { code: 'ENOENT' });
}));

test('local deletion requires explicit recursion and removes only the selected tree', async () => fixture(async root => {
  const directory = path.join(root, 'selected');
  await fs.mkdir(path.join(directory, 'nested'), { recursive: true });
  await fs.writeFile(path.join(directory, 'nested', 'child.txt'), 'inside');
  const keep = path.join(root, 'keep.txt'); await fs.writeFile(keep, 'outside');
  await assert.rejects(removeLocalFile(directory, false));
  assert.equal(await fs.readFile(path.join(directory, 'nested', 'child.txt'), 'utf8'), 'inside');
  await assert.rejects(removeLocalFile(directory, undefined as any), /明确/);
  await removeLocalFile(directory, true);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  assert.equal(await fs.readFile(keep, 'utf8'), 'outside');
  await removeLocalFile(keep, false);
  await assert.rejects(removeLocalFile(keep, false), { code: 'ENOENT' });
  const empty = path.join(root, 'empty'); await createLocalDirectory(empty); await removeLocalFile(empty, false);
}));

test('local recursive delete unlinks a junction and never deletes its target', async () => fixture(async root => {
  const selected = path.join(root, 'selected'), outside = path.join(root, 'outside');
  await fs.mkdir(selected); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  const link = path.join(selected, 'outside-link');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removeLocalFile(path.join(link, 'keep.txt'), false), /符号链接/);
  await removeLocalFile(selected, true);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  const topLink = path.join(root, 'top-link'); await fs.symlink(outside, topLink, process.platform === 'win32' ? 'junction' : 'dir');
  await removeLocalFile(topLink, true);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
}));

function serviceFixture() {
  const calls: any[][] = [];
  let kind: 'file' | 'directory' | 'link' | 'missing' | 'denied' = 'file';
  const sftp = {
    open: (target: string, flags: string, attrs: unknown, done: Function) => { calls.push(['open', target, flags, attrs]); done(null, Buffer.from('handle')); },
    close: (_handle: unknown, done: Function) => { calls.push(['close']); done(); },
    once: () => {}, removeListener: () => {},
    lstat: (target: string, done: Function) => { calls.push(['lstat', target]); kind === 'missing' || kind === 'denied' ? done(Object.assign(new Error(kind), { code: kind === 'missing' ? 2 : 3 })) : done(null, { isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'link' }); },
    unlink: (target: string, done: Function) => { calls.push(['unlink', target]); done(); },
    rmdir: (target: string, done: Function) => { calls.push(['rmdir', target]); done(); },
  };
  const service = new SshService(() => {}, 'unused-test-only');
  const adapter = service as any;
  adapter.session = () => ({});
  adapter.control = async () => ({ sftp });
  adapter.operation = async (...args: unknown[]) => { calls.push(['helper', ...args]); };
  return { service, calls, setKind: (value: typeof kind) => { kind = value; } };
}

test('SFTP uses server-exclusive create and maps permission errors for sudo retry', async () => {
  const { service, calls, setKind } = serviceFixture();
  await service.createFile({ sessionId: 'fixture', path: '/tmp/new file.txt' });
  assert.deepEqual(calls, [['open', '/tmp/new file.txt', 'wx', { mode: 0o644 }], ['close']]);
  calls.length = 0; setKind('denied');
  await assert.rejects(service.removeFile({ sessionId: 'fixture', path: '/tmp/denied', recursive: false }), /PERMISSION_DENIED/);
  assert.equal(calls.some(call => call[0] === 'unlink'), false);
});

test('SFTP removes links without traversal and delegates only recursive directories to descriptor helper', async () => {
  const { service, calls, setKind } = serviceFixture();
  const request = { sessionId: 'fixture', path: '/tmp/selected', recursive: true };
  setKind('link'); await service.removeFile(request);
  assert.deepEqual(calls, [['lstat', request.path], ['unlink', request.path]]);
  calls.length = 0; setKind('directory'); await service.removeFile({ ...request, recursive: false });
  assert.deepEqual(calls, [['lstat', request.path], ['rmdir', request.path]]);
  calls.length = 0; await service.removeFile(request);
  assert.deepEqual(calls[1], ['helper', request, 'remove', { recursive: true }]);
  calls.length = 0; await service.removeFile({ ...request, elevated: true });
  assert.deepEqual(calls, [['helper', { ...request, elevated: true }, 'remove', { recursive: true }]]);
  calls.length = 0;
  await assert.rejects(service.removeFile({ ...request, path: '/' }));
  await assert.rejects(service.createFile({ sessionId: 'fixture', path: '/tmp/../keep' }));
  assert.deepEqual(calls, []);
});
