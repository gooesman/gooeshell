import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ExternalEditorService } from '../src/main/external-editor';
import { externalEditorCommand, externalEditorForFile, launchExternalEditor } from '../src/main/external-editor-launch';
import { readLocalTextFile, writeLocalTextFile } from '../src/main/local-files';
import { MAX_EDITABLE_TEXT } from '../src/main/text-files';
import { Store, cleanSettings } from '../src/main/store';
import { defaultSettings } from '../src/shared/defaults';
import type { ExternalEdit, TextWriteRequest } from '../src/shared/types';

const host = { key: 'original-account-and-route', name: '测试服务器', sessionId: 'original-session' };
async function fixture(run: (context: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const context = await createFixture();
  try { await run(context); } finally {
    await Promise.all(context.services.map(service => service.stop()));
    assert.ok(context.directory.startsWith(path.resolve('test-output') + path.sep));
    await fs.rm(context.directory, { recursive: true, force: true });
  }
}
async function createFixture() {
  await fs.mkdir('test-output', { recursive: true });
  const directory = await fs.mkdtemp(path.resolve('test-output/external-editor-'));
  const remoteFile = path.join(directory, '服务器.md'), cache = path.join(directory, 'drafts');
  await fs.writeFile(remoteFile, '# 原始内容\r\n');
  const launched: string[] = [], writes: TextWriteRequest[] = [], events: ExternalEdit[][] = [], services: ExternalEditorService[] = [];
  let writeBarrier: (() => Promise<void>) | undefined, launchError = false;
  const create = async () => {
    const service = new ExternalEditorService(cache, {
      read: async () => readLocalTextFile({ path: remoteFile }),
      write: async request => { writes.push(request); await writeBarrier?.(); return writeLocalTextFile({ ...request, path: remoteFile }); },
      launch: async file => { if (launchError) throw new Error('模拟编辑器启动失败'); launched.push(file); },
      changed: edits => events.push(edits),
    });
    await service.load(); services.push(service); return service;
  };
  const service = await create();
  let now = Date.now();
  const scan = async (target = service) => { now += 10_000; await target.poll(now); await target.poll(now + 1000); };
  return { directory, remoteFile, cache, service, services, create, scan, launched, writes, events, block: (barrier?: () => Promise<void>) => { writeBarrier = barrier; }, failLaunch: () => { launchError = true; } };
}

test('external editor opens a distinct local draft once, uploads atomic editor saves and preserves encoding', async () => fixture(async c => {
  const [a, b] = await Promise.all([c.service.open(host, '/项目/说明.md'), c.service.open(host, '/项目/说明.md')]);
  assert.equal(a.id, b.id); assert.equal(c.launched.length, 1);
  assert.deepEqual(await fs.readFile(a.localPath), await fs.readFile(c.remoteFile));
  await c.scan(); assert.equal(c.writes.length, 0, 'opening or observing an unchanged draft must not write remotely');
  const temporary = path.join(path.dirname(a.localPath), 'editor-save.tmp');
  await fs.writeFile(temporary, '\ufeff# 修改\r\n第二行\n'); await fs.rename(temporary, a.localPath);
  await c.scan(); assert.deepEqual(await fs.readFile(c.remoteFile), await fs.readFile(a.localPath));
  assert.equal(c.writes[0].encoding, 'utf8-bom'); assert.equal(c.writes[0].sessionId, host.sessionId);
  await c.scan(); assert.equal(c.writes.length, 1, 'metadata observation cannot upload the same bytes twice');
  await fs.writeFile(a.localPath, ''); await c.scan(); assert.equal((await fs.readFile(c.remoteFile)).length, 0);
}));

test('server conflict preserves both files; explicit resolution rechecks both compared versions', async () => fixture(async c => {
  const edit = await c.service.open(host, '/notes.md');
  await fs.writeFile(edit.localPath, '# Local'); await fs.writeFile(c.remoteFile, '# Remote'); await c.scan();
  assert.equal(c.service.list()[0].state, 'conflict'); assert.equal(await fs.readFile(c.remoteFile, 'utf8'), '# Remote');
  const compared = await c.service.compare(edit.id, host);
  await fs.writeFile(edit.localPath, '# Newer local');
  await assert.rejects(c.service.action({ id: edit.id, action: 'upload', localRevision: compared.local.revision, remoteRevision: compared.remote.revision }, host), /本地文件在比较后/);
  const latest = await c.service.compare(edit.id, host); await fs.writeFile(c.remoteFile, '# Newer remote');
  await assert.rejects(c.service.action({ id: edit.id, action: 'upload', localRevision: latest.local.revision, remoteRevision: latest.remote.revision }, host), /TEXT_CONFLICT/);
  const final = await c.service.compare(edit.id, host);
  await c.service.action({ id: edit.id, action: 'upload', localRevision: final.local.revision, remoteRevision: final.remote.revision }, host);
  assert.equal(await fs.readFile(c.remoteFile, 'utf8'), '# Newer local'); assert.equal(c.service.list()[0].state, 'watching');
}));

test('adopting server version retains a backup and does not echo it back to the server', async () => fixture(async c => {
  const edit = await c.service.open(host, '/notes.md');
  await fs.writeFile(edit.localPath, '# Keep in backup'); await fs.writeFile(c.remoteFile, '# Server version'); await c.scan();
  const compared = await c.service.compare(edit.id, host);
  await c.service.action({ id: edit.id, action: 'reload', localRevision: compared.local.revision, remoteRevision: compared.remote.revision }, host);
  assert.equal(await fs.readFile(edit.localPath, 'utf8'), '# Server version');
  const backup = (await fs.readdir(path.dirname(edit.localPath))).find(name => name.includes('.backup-'))!;
  assert.equal(await fs.readFile(path.join(path.dirname(edit.localPath), backup), 'utf8'), '# Keep in backup');
  const before = c.writes.length; await c.scan(); assert.equal(c.writes.length, before);
}));

test('saving again during an upload is serialized and uses the new server revision', async () => fixture(async c => {
  const edit = await c.service.open(host, '/notes.md');
  let release!: () => void, entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  c.block(() => { entered(); return new Promise<void>(resolve => { release = resolve; }); });
  await fs.writeFile(edit.localPath, 'first'); const uploading = c.scan(); await reached;
  await fs.writeFile(edit.localPath, 'second'); c.block(); release(); await uploading;
  await c.scan(); assert.equal(await fs.readFile(c.remoteFile, 'utf8'), 'second');
  assert.equal(c.writes.length, 2); assert.notEqual(c.writes[0].expectedRevision, c.writes[1].expectedRevision);
}));

test('disconnect and restart preserve drafts and require the original connection to resume', async () => fixture(async c => {
  const edit = await c.service.open(host, '/notes.md');
  c.service.disconnected(host.sessionId); await fs.writeFile(edit.localPath, 'offline edit'); await c.scan();
  assert.equal(c.writes.length, 0); await c.service.stop();
  const restarted = await c.create(); assert.equal(restarted.list()[0].state, 'paused');
  await c.scan(restarted); assert.equal(c.writes.length, 0);
  await assert.rejects(restarted.action({ id: edit.id, action: 'retry' }, { ...host, key: 'other-account' }), /不可回传到其他连接/);
  await restarted.action({ id: edit.id, action: 'retry' }, { ...host, sessionId: 'reconnected-session' });
  assert.equal(c.writes[0].sessionId, 'reconnected-session'); assert.equal(await fs.readFile(c.remoteFile, 'utf8'), 'offline edit');
  const manifest = await fs.readFile(path.join(c.cache, edit.id, 'session.json'), 'utf8');
  assert.ok(!manifest.includes(host.sessionId)); assert.ok(!manifest.includes('password'));
  await restarted.action({ id: edit.id, action: 'finish' }); assert.equal(restarted.list().length, 0);
  assert.equal(await fs.readFile(edit.localPath, 'utf8'), 'offline edit');
  await restarted.stop(); const again = await c.create(); assert.equal(again.list().length, 0);
}));

test('launch, permission, oversized and invalid text failures never discard or upload the draft', async () => fixture(async c => {
  c.failLaunch(); await assert.rejects(c.service.open(host, '/notes.md'), /启动失败/);
  const edit = c.service.list()[0]; assert.equal(edit.state, 'error'); assert.ok(await fs.stat(edit.localPath));
  await fs.writeFile(edit.localPath, Buffer.from([0xff, 0, 1]));
  await assert.rejects(c.service.action({ id: edit.id, action: 'retry' }, host), /编码|二进制/); assert.equal(c.writes.length, 0);
  await fs.writeFile(edit.localPath, Buffer.alloc(MAX_EDITABLE_TEXT + 1, 65));
  await assert.rejects(c.service.action({ id: edit.id, action: 'retry' }, host), /2 MiB/); assert.equal(c.writes.length, 0);
  await fs.writeFile(edit.localPath, 'pending write'); c.block(async () => { throw new Error('Permission denied'); });
  await assert.rejects(c.service.action({ id: edit.id, action: 'retry' }, host), /Permission denied/);
  assert.equal(await fs.readFile(edit.localPath, 'utf8'), 'pending write'); assert.equal(await fs.readFile(c.remoteFile, 'utf8'), '# 原始内容\r\n');
}));

test('same remote filename from different connections has separate drafts and targets', async () => fixture(async c => {
  const a = await c.service.open(host, '/notes.md'), b = await c.service.open({ ...host, key: 'other-user', sessionId: 'second-session' }, '/notes.md');
  assert.notEqual(a.localPath, b.localPath);
  await fs.writeFile(b.localPath, 'second only'); await c.scan();
  assert.equal(c.writes.length, 1); assert.equal(c.writes[0].sessionId, 'second-session');
  assert.equal(await fs.readFile(a.localPath, 'utf8'), '# 原始内容\r\n');
}));

test('a brief missing path during atomic save waits for replacement', async () => fixture(async c => {
  const edit = await c.service.open(host, '/notes.md'); await c.scan();
  await fs.unlink(edit.localPath); await c.scan(); assert.equal(c.service.list()[0].state, 'watching');
  await fs.writeFile(edit.localPath, '# Replaced'); await c.scan();
  assert.equal(await fs.readFile(c.remoteFile, 'utf8'), '# Replaced');
}));

test('editor launch keeps filenames as literal arguments and never executes a system-associated script', async () => {
  const file = path.resolve('a & $(touch unsafe).md');
  assert.equal(externalEditorCommand('', file), null);
  const executable = path.resolve('editor.exe');
  assert.deepEqual(externalEditorCommand(executable, file, 'win32'), { command: executable, args: [file] });
  for (const name of ['run.cmd', 'run.bat', 'run.ps1', 'run.js', 'run.py', 'run.sh', 'page.html', 'shortcut.url', 'app.desktop', 'app.exe']) assert.throws(() => externalEditorCommand('', path.resolve(name)), /指定文本编辑器/);
  assert.throws(() => externalEditorCommand('code --wait', file), /完整程序路径/);
  assert.throws(() => externalEditorCommand(path.resolve('editor.cmd'), file, 'win32'), /exe/);
  await assert.rejects(launchExternalEditor('', file, async () => 'No default application'), /指定编辑器/);
});

test('external editor preference migrates empty and survives store save/reload', async () => fixture(async c => {
  const old = { ...defaultSettings } as any; delete old.externalEditorPath;
  assert.equal(cleanSettings(old).externalEditorPath, '');
  assert.equal(cleanSettings({ ...defaultSettings, externalEditorPath: 'bad\0path' }).externalEditorPath, '');
  const store = new Store(c.directory), editor = path.resolve('editor.exe');
  await store.saveSettings({ ...defaultSettings, externalEditorPath: editor });
  assert.equal((await new Store(c.directory).settings()).externalEditorPath, editor);
}));

test('file type editors override the fallback without changing other system associations', () => {
  const editor = path.resolve('VS Code/Code.exe');
  const settings = { ...defaultSettings, externalEditorByExtension: { '.py': editor } };
  const file = path.resolve('项目/a & literal.PY');
  assert.equal(externalEditorForFile(settings, file), editor);
  assert.deepEqual(externalEditorCommand(externalEditorForFile(settings, file), file, 'win32'), { command: editor, args: [file] });
  for (const name of ['notes.md', 'notes.txt']) {
    const document = path.resolve(name);
    assert.equal(externalEditorForFile(settings, document), '');
    assert.equal(externalEditorCommand(externalEditorForFile(settings, document), document), null);
  }
  const fallback = { ...settings, externalEditorPath: editor, externalEditorByExtension: { '.md': '' } };
  assert.equal(externalEditorForFile(fallback, '/notes.md'), '', 'explicit system default overrides the global editor');
  assert.equal(externalEditorForFile(fallback, '/notes.txt'), editor);
  assert.throws(() => externalEditorCommand(externalEditorForFile(settings, '/run.ps1'), path.resolve('run.ps1')), /指定文本编辑器/);
});

test('file type editor settings normalize, reject invalid entries and survive restart', async () => fixture(async c => {
  const old = { ...defaultSettings } as any; delete old.externalEditorByExtension;
  assert.deepEqual(cleanSettings(old).externalEditorByExtension, {});
  const editor = path.resolve('VS Code/Code.exe'), store = new Store(c.directory);
  const saved = { ...defaultSettings, externalEditorByExtension: { ' *.PY ': editor, '.md': '', '.txt': path.resolve('Notepad.exe'), 'py;exe': editor, '../sh': editor, '.js': 'bad\0path', '.ps1': 'bad\npath' } };
  await store.saveSettings(saved);
  const loaded = await new Store(c.directory).settings();
  assert.deepEqual(loaded.externalEditorByExtension, { '.py': editor, '.md': '', '.txt': path.resolve('Notepad.exe') });
  assert.equal(externalEditorForFile(loaded, '/test.PY'), editor);
}));

test('remote cached files retain the extension used for editor selection and reopening', async () => fixture(async c => {
  const editor = path.resolve('Code.exe'), settings = { ...defaultSettings, externalEditorByExtension: { '.py': editor } };
  const py = await c.service.open(host, '/项目/run.PY'), md = await c.service.open(host, '/项目/README.md');
  assert.equal(externalEditorForFile(settings, py.localPath), editor);
  assert.equal(externalEditorForFile(settings, md.localPath), '');
  await c.service.action({ id: py.id, action: 'open' });
  assert.equal(c.launched.at(-1), py.localPath);
  settings.externalEditorByExtension['.py'] = path.resolve('Other.exe');
  assert.equal(externalEditorForFile(settings, c.launched.at(-1)!), path.resolve('Other.exe'));
}));
