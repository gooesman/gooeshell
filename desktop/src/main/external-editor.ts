import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { EditableTextFile, ExternalEdit, ExternalEditAction, ExternalEditComparison, TextWriteRequest, TextWriteResult } from '../shared/types';
import { readLocalTextFile, writeLocalTextFile } from './local-files';
import { encodeEditableText, validateExpectedRevision } from './text-files';

type RecordData = { id: string; name: string; path: string; fileName: string; connectionName: string; connectionKey: string; baseRevision: string; syncedDigest: string };
type Job = { data: RecordData; view: ExternalEdit; sessionId?: string; signature?: string; observedAt?: number; pending?: Promise<void> };
type Host = { key: string; name: string; sessionId: string };
type Dependencies = {
  read(sessionId: string, path: string): Promise<EditableTextFile>;
  write(request: TextWriteRequest): Promise<TextWriteResult>;
  launch(file: string): Promise<void>;
  changed(edits: ExternalEdit[]): void;
};
const digest = (file: EditableTextFile) => createHash('sha256').update(encodeEditableText(file.text, file.encoding, file.bom)).digest('hex');
function complete(file: EditableTextFile) { if (file.truncated) throw new Error('外部文本编辑最多支持 2 MiB，请使用文件下载'); return file; }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class ExternalEditorService {
  private jobs = new Map<string, Job>();
  private opening = new Map<string, Promise<ExternalEdit>>();
  private timer?: ReturnType<typeof setInterval>;
  private closing = false;
  constructor(private directory: string, private dependencies: Dependencies) {}
  list(): ExternalEdit[] { return [...this.jobs.values()].map(job => ({ ...job.view })); }
  private emit() { this.dependencies.changed(this.list()); }
  private job(id: string) { const job = this.jobs.get(id); if (!job) throw new Error('外部编辑任务已结束'); return job; }
  connectionKey(id: string) { return this.job(id).data.connectionKey; }
  private set(job: Job, state: ExternalEdit['state'], text: string) { job.view.state = state; job.view.message = text; this.emit(); }
  private async persist(job: Job) {
    const target = path.join(this.directory, job.data.id, 'session.json');
    await fs.writeFile(target + '.tmp', JSON.stringify(job.data), { mode: 0o600 });
    await fs.rename(target + '.tmp', target);
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      try {
        const data: RecordData = JSON.parse(await fs.readFile(path.join(this.directory, entry.name, 'session.json'), 'utf8'));
        if (data.id !== entry.name || typeof data.fileName !== 'string' || path.basename(data.fileName) !== data.fileName || /[\\/:\0]/.test(data.fileName) || data.fileName === 'session.json' || data.fileName === 'session.json.tmp' || !data.fileName) continue;
        if (![data.name, data.path, data.connectionName, data.connectionKey, data.syncedDigest].every(value => typeof value === 'string') || !/^[a-f0-9]{64}$/.test(data.syncedDigest)) continue;
        validateExpectedRevision(data.baseRevision);
        const localPath = path.join(this.directory, data.id, data.fileName);
        if (!(await fs.lstat(localPath)).isFile()) continue;
        this.jobs.set(data.id, { data, view: { id: data.id, name: data.name, path: data.path, localPath, connectionName: data.connectionName, state: 'paused', message: '本地草稿已保留；连接原服务器后点击恢复回传。' } });
      } catch { /* Leave an unreadable draft on disk rather than deleting it. */ }
    }
    this.timer = setInterval(() => { void this.poll(); }, 1000); this.timer.unref();
  }
  async open(host: Host, remotePath: string): Promise<ExternalEdit> {
    if (this.closing) throw new Error('应用正在关闭');
    if (typeof remotePath !== 'string' || !remotePath.startsWith('/') || /[\0\r\n]/.test(remotePath)) throw new Error('请选择远程文件的绝对路径');
    remotePath = path.posix.normalize(remotePath);
    const key = JSON.stringify([host.key, remotePath]);
    const pending = this.opening.get(key); if (pending) return pending;
    const opening = this.openFile(host, remotePath);
    this.opening.set(key, opening);
    try { return await opening; } finally { this.opening.delete(key); }
  }
  private async openFile(host: Host, remotePath: string): Promise<ExternalEdit> {
    let job = [...this.jobs.values()].find(job => job.data.connectionKey === host.key && job.data.path === remotePath);
    if (!job) {
      const file = complete(await this.dependencies.read(host.sessionId, remotePath));
      const id = randomUUID(), name = path.posix.basename(remotePath);
      const safeName = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'file.txt';
      // Prefix also avoids Windows reserved names and our own metadata files.
      const fileName = 'edit-' + safeName;
      const folder = path.join(this.directory, id), localPath = path.join(folder, fileName);
      await fs.mkdir(folder, { mode: 0o700 });
      await fs.writeFile(localPath, encodeEditableText(file.text, file.encoding, file.bom), { flag: 'wx', mode: 0o600 });
      const data = { id, name, path: remotePath, fileName, connectionName: host.name, connectionKey: host.key, baseRevision: file.revision, syncedDigest: digest(file) };
      job = { data, sessionId: host.sessionId, view: { id, name, path: remotePath, localPath, connectionName: host.name, state: 'watching', message: '保存后自动回传' } };
      await this.persist(job); this.jobs.set(id, job); this.emit();
    }
    // Reopening a retained/conflicted draft must not silently resume uploads.
    try { await this.dependencies.launch(job.view.localPath); }
    catch (error) { this.set(job, 'error', message(error)); throw error; }
    return { ...job.view };
  }
  private serial(job: Job, operation: () => Promise<void>): Promise<void> {
    const pending = (job.pending || Promise.resolve()).catch(() => {}).then(operation);
    job.pending = pending;
    return pending.finally(() => { if (job.pending === pending) job.pending = undefined; });
  }
  async poll(now = Date.now()) {
    if (this.closing) return;
    await Promise.all([...this.jobs.values()].filter(job => job.view.state === 'watching' && !job.pending).map(job => this.serial(job, async () => {
      try {
        const stat = await fs.lstat(job.view.localPath);
        const signature = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(':');
        if (signature !== job.signature) { job.signature = signature; job.observedAt = now; return; }
        if (job.observedAt === undefined || now - job.observedAt < 700) return;
        job.observedAt = undefined;
        await this.upload(job);
      } catch (error) {
        // Atomic editor saves may briefly remove the old path.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { job.signature = undefined; return; }
        this.fail(job, error);
      }
    })));
  }
  private fail(job: Job, error: unknown) { this.set(job, /TEXT_CONFLICT/.test(message(error)) ? 'conflict' : 'error', message(error)); }
  private async upload(job: Job, local?: EditableTextFile, revision = job.data.baseRevision) {
    if (!job.sessionId) throw new Error('连接已断开，本地草稿已保留');
    const file = complete(local || await readLocalTextFile({ path: job.view.localPath }));
    const checksum = digest(file);
    if (checksum === job.data.syncedDigest && revision === job.data.baseRevision) return;
    this.set(job, 'uploading', '正在回传保存的修改…');
    const result = await this.dependencies.write({ side: 'remote', sessionId: job.sessionId, path: job.data.path, text: file.text, encoding: file.encoding, bom: file.bom, expectedRevision: revision });
    job.data.baseRevision = result.revision; job.data.syncedDigest = checksum;
    await this.persist(job);
    this.set(job, job.sessionId ? 'watching' : 'paused', job.sessionId ? '已回传；继续监测保存' : '连接已断开，本地草稿已保留');
  }
  disconnected(sessionId: string) {
    for (const job of this.jobs.values()) if (job.sessionId === sessionId) { job.sessionId = undefined; this.set(job, 'paused', '连接已断开，本地草稿已保留；重连后点击恢复回传。'); }
  }
  async compare(id: string, host: Host): Promise<ExternalEditComparison> {
    const job = this.job(id); this.assertHost(job, host);
    await job.pending;
    return { local: complete(await readLocalTextFile({ path: job.view.localPath })), remote: complete(await this.dependencies.read(host.sessionId, job.data.path)) };
  }
  private assertHost(job: Job, host: Host) { if (job.data.connectionKey !== host.key) throw new Error('请连接原服务器后恢复此草稿，不可回传到其他连接'); }
  async action(request: ExternalEditAction, host?: Host): Promise<void> {
    const job = this.job(request.id);
    if (request.action === 'open') { await this.dependencies.launch(job.view.localPath); return; }
    await this.serial(job, async () => {
      if (request.action === 'finish') {
        await fs.unlink(path.join(this.directory, job.data.id, 'session.json'));
        this.jobs.delete(job.data.id); this.emit(); return;
      }
      if (!host) throw new Error('请先连接原服务器，再恢复回传');
      this.assertHost(job, host); job.sessionId = host.sessionId;
      try {
        if (request.action === 'retry') { await this.upload(job); this.set(job, 'watching', '保存后自动回传'); return; }
        if (request.action !== 'upload' && request.action !== 'reload') throw new Error('外部编辑操作无效');
        const local = complete(await readLocalTextFile({ path: job.view.localPath }));
        if (local.revision !== request.localRevision) throw new Error('本地文件在比较后又有修改，请重新比较');
        validateExpectedRevision(request.remoteRevision);
        if (request.action === 'upload') { await this.upload(job, local, request.remoteRevision); return; }
        const remote = complete(await this.dependencies.read(host.sessionId, job.data.path));
        if (remote.revision !== request.remoteRevision) throw new Error('服务器文件在比较后又有修改，请重新比较');
        await fs.copyFile(job.view.localPath, job.view.localPath + '.backup-' + randomUUID());
        await writeLocalTextFile({ path: job.view.localPath, ...remote, expectedRevision: local.revision });
        job.data.baseRevision = remote.revision; job.data.syncedDigest = digest(remote);
        await this.persist(job); this.set(job, 'watching', '已采用服务器版本；原本地版本已在草稿目录备份');
      } catch (error) { this.fail(job, error); throw error; }
    });
  }
  async stop() { this.closing = true; clearInterval(this.timer); await Promise.allSettled([...this.opening.values(), ...[...this.jobs.values()].map(job => job.pending)]); }
}
