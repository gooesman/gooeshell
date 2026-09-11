import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper, type Stats } from 'ssh2';
import iconv from 'iconv-lite';
import type {
  AppEvent, CommandResult, ConnectRequest, FileListing, HostKeyDecision, HostProfile,
  EditableTextFile, EditorEncoding, RemoteRequest, SessionInfo, TextFile, TextWriteResult, TransferInfo, TransferRequest,
} from '../shared/types';
import { runRemoteOperation } from './remote-helper';
import { isSftpClosed, performSftpTransfer, remoteClose, remoteStat, sftpCall, trackSftp } from './sftp-transfer';
import { decodeEditableText, encodeEditableText, serializeTextWrite, textConflict, textRevision, validateExpectedRevision } from './text-files';

const HIGH_WATER = 512 * 1024;
const LOW_WATER = 128 * 1024;
const MAX_TEXT = 2 * 1024 * 1024;
type TrustedHost = { fingerprint: string; savedAt: string };
type TrustStore = { version: 1; hosts: Record<string, TrustedHost> };
interface Session {
  id: string;
  profile: HostProfile;
  skipHostKeyVerification: boolean;
  credentials: Pick<ConnectConfig, 'password' | 'privateKey' | 'passphrase' | 'agent'>;
  fingerprint?: string;
  clients: Set<Client>;
  shell?: ClientChannel;
  control?: Promise<{ client: Client; sftp: SFTPWrapper }>;
  pendingBytes: number;
  terminalReady: boolean;
  terminalCols: number;
  terminalRows: number;
  closed: boolean;
}
interface TransferJob { info: TransferInfo; abort: AbortController; client?: Client }
interface HostQuestion { resolve: (decision: HostKeyDecision) => void; timer: NodeJS.Timeout; sessionId: string }

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function endpoint(profile: HostProfile): string { return `[${profile.host.toLowerCase()}]:${profile.port}`; }
function validPath(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('路径不能为空，也不能包含 NUL 字符');
  return value;
}
function modeValue(mode: number): number {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('权限必须在 000 至 777 之间，不能添加特殊权限位');
  return mode;
}
function sameFile(a: Stats, b: Stats): boolean { return a.size === b.size && a.mtime === b.mtime && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid; }
function textMetadata(info: Stats): number[] { return [info.size, info.mtime, info.mode, info.uid, info.gid]; }
function remoteError(error: unknown): Error {
  if ((error as { code?: number }).code === 3) return new Error('PERMISSION_DENIED：权限不足。可选择“使用 sudo 重试”，并为本次操作输入 sudo 密码。');
  return error instanceof Error ? error : new Error(String(error));
}

/** Lives in a worker: rendering, SSH crypto and file I/O never share the UI thread. */
export class SshService {
  private readonly sessions = new Map<string, Session>();
  private readonly jobs = new Map<string, TransferJob>();
  private readonly questions = new Map<string, HostQuestion>();
  private trust?: Promise<TrustStore>;
  private saveQueue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly emit: (event: AppEvent) => void, private readonly knownHostsFile: string) {}

  private trustStore(): Promise<TrustStore> {
    return this.trust ??= (async () => {
      let contents: string;
      try { contents = await fs.readFile(this.knownHostsFile, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, hosts: {} };
        throw error;
      }
      let parsed: TrustStore;
      try { parsed = JSON.parse(contents); } catch { throw new Error('已保存的服务器指纹文件损坏，连接已停止。请检查该文件后重试。'); }
      if (parsed.version !== 1 || !parsed.hosts || typeof parsed.hosts !== 'object' || Array.isArray(parsed.hosts)) throw new Error('服务器指纹文件格式不受支持');
      for (const record of Object.values(parsed.hosts)) {
        if (!record || typeof record.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(record.fingerprint)) throw new Error('服务器指纹文件包含无效记录');
      }
      return parsed;
    })();
  }

  private async saveFingerprint(key: string, fingerprint: string): Promise<void> {
    const write = async () => {
      const store = await this.trustStore();
      const updated: TrustStore = { version: 1, hosts: { ...store.hosts, [key]: { fingerprint, savedAt: new Date().toISOString() } } };
      await fs.mkdir(path.dirname(this.knownHostsFile), { recursive: true });
      const temporary = `${this.knownHostsFile}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(updated, null, 2), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, this.knownHostsFile);
        store.hosts = updated.hosts;
      } finally { await fs.unlink(temporary).catch(() => {}); }
    };
    const result = this.saveQueue.then(write);
    this.saveQueue = result.catch(() => {});
    await result;
  }

  private async verify(session: Session, key: Buffer): Promise<boolean> {
    if (session.closed || this.stopped) return false;
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
    if (session.fingerprint) {
      if (session.fingerprint === fingerprint) return true;
      throw new Error('此会话的后续连接返回了不同的服务器指纹，连接已拒绝，请重新连接并核实服务器身份。');
    }
    if (session.skipHostKeyVerification) { session.fingerprint = fingerprint; return true; }
    const previousFingerprint = session.profile.rememberHost
      ? (await this.trustStore()).hosts[endpoint(session.profile)]?.fingerprint
      : undefined;
    if (previousFingerprint === fingerprint) { session.fingerprint = fingerprint; return true; }
    const requestId = randomUUID();
    const decision = await new Promise<HostKeyDecision>(resolve => {
      const timer = setTimeout(() => {
        this.questions.delete(requestId);
        resolve('reject');
      }, 120_000);
      timer.unref();
      this.questions.set(requestId, { resolve, timer, sessionId: session.id });
      this.emit({ type: 'hostKey', requestId, host: session.profile.host, port: session.profile.port, fingerprint, previousFingerprint, saveAllowed: session.profile.rememberHost });
    });
    if (decision === 'reject' || session.closed || this.stopped) return false;
    if (decision === 'save' && session.profile.rememberHost) await this.saveFingerprint(endpoint(session.profile), fingerprint);
    session.fingerprint = fingerprint;
    return true;
  }

  confirmHostKey(requestId: string, decision: HostKeyDecision): void {
    if (!['once', 'save', 'reject'].includes(decision)) throw new Error('无效的指纹确认选项');
    const question = this.questions.get(requestId);
    if (!question) return;
    clearTimeout(question.timer);
    this.questions.delete(requestId);
    question.resolve(decision);
  }

  private async openClient(session: Session): Promise<Client> {
    if (session.closed || this.stopped) throw new Error('连接已关闭');
    const client = new Client();
    session.clients.add(client);
    client.on('close', () => session.clients.delete(client));
    // Keep a listener after connection setup: stream failures must never crash the worker.
    client.on('error', () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
        client.once('error', fail);
        client.once('close', () => fail(new Error('SSH 连接在认证完成前关闭')));
        client.once('ready', () => {
          if (settled) return;
          settled = true;
          client.removeListener('error', fail);
          client.setNoDelay(true);
          resolve();
        });
        client.connect({
          host: session.profile.host, port: session.profile.port, username: session.profile.username,
          ...session.credentials, readyTimeout: 150_000, keepaliveInterval: 20_000, keepaliveCountMax: 3,
          hostVerifier: (key: Buffer, accept: (accepted: boolean) => void) => {
            void this.verify(session, key).then(accept, error => { fail(new Error(`服务器指纹校验失败：${message(error)}`)); accept(false); });
          },
        });
      });
      if (session.closed) throw new Error('连接已关闭');
      return client;
    } catch (error) { client.destroy(); throw error; }
  }

  async connect(request: ConnectRequest): Promise<SessionInfo> {
    if (this.stopped) throw new Error('应用正在退出');
    const profile = { ...request.profile };
    if (!profile.host?.trim() || !profile.username?.trim() || !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) throw new Error('请填写服务器地址、用户名和有效端口');
    if (!['utf8', 'gb18030', 'big5'].includes(profile.encoding)) throw new Error('不支持的终端编码');
    profile.host = profile.host.trim();
    const credentials: Session['credentials'] = {};
    if (profile.auth === 'password') credentials.password = request.password ?? '';
    else if (profile.auth === 'key') {
      if (!profile.privateKeyPath) throw new Error('请选择私钥文件');
      credentials.privateKey = await fs.readFile(profile.privateKeyPath);
      credentials.passphrase = request.passphrase;
    } else if (profile.auth === 'agent') {
      credentials.agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
      if (!credentials.agent) throw new Error('SSH Agent 未配置，请选择密码或私钥认证');
    } else throw new Error('不支持的认证方式');
    const session: Session = { id: randomUUID(), profile, skipHostKeyVerification: request.skipHostKeyVerification === true, credentials, clients: new Set(), pendingBytes: 0, terminalReady: false, terminalCols: 100, terminalRows: 30, closed: false };
    this.sessions.set(session.id, session);
    try {
      const client = await this.openClient(session);
      const shell = await new Promise<ClientChannel>((resolve, reject) => client.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (error, stream) => error ? reject(error) : resolve(stream)));
      session.shell = shell;
      // The first resize is sent after the renderer subscribes, so its prompt is not lost.
      shell.pause();
      shell.stderr.pause();
      const output = (bytes: Buffer) => {
        if (!bytes.length || session.closed) return;
        session.pendingBytes += bytes.length;
        this.emit({ type: 'terminal', sessionId: session.id, data: bytes.toString('base64'), bytes: bytes.length });
        if (session.pendingBytes >= HIGH_WATER) { shell.pause(); shell.stderr.pause(); }
      };
      if (profile.encoding === 'utf8') {
        // xterm owns the streaming UTF-8 parser. Preserve escape sequences and
        // byte boundaries instead of decoding and re-encoding every SSH packet.
        shell.on('data', output);
        shell.stderr.on('data', output);
      } else {
        // Extended data and stdout are independent streams and must not share
        // an incremental legacy-encoding decoder.
        const stdoutDecoder = iconv.getDecoder(profile.encoding);
        const stderrDecoder = iconv.getDecoder(profile.encoding);
        shell.on('data', (bytes: Buffer) => output(Buffer.from(stdoutDecoder.write(bytes), 'utf8')));
        shell.stderr.on('data', (bytes: Buffer) => output(Buffer.from(stderrDecoder.write(bytes), 'utf8')));
        shell.on('end', () => output(Buffer.from(stdoutDecoder.end() ?? '', 'utf8')));
        shell.stderr.on('end', () => output(Buffer.from(stderrDecoder.end() ?? '', 'utf8')));
      }
      shell.on('error', (error: Error) => this.finishSession(session, `终端连接出错：${message(error)}`));
      shell.on('close', () => this.finishSession(session, '远程终端已关闭'));
      client.on('close', () => this.finishSession(session, 'SSH 连接已关闭'));
      client.on('error', error => this.finishSession(session, `SSH 连接出错：${message(error)}`));
      return { id: session.id, profile: { ...profile } };
    } catch (error) {
      this.finishSession(session, `连接失败：${message(error)}`);
      throw error;
    }
  }

  private session(id: string): Session {
    const result = this.sessions.get(id);
    if (!result || result.closed) throw new Error('此 SSH 会话已断开，请先连接服务器');
    return result;
  }

  private control(session: Session): Promise<{ client: Client; sftp: SFTPWrapper }> {
    if (!session.control) {
      const connection = (async () => {
        const client = await this.openClient(session);
        try {
          const sftp = await sftpCall<SFTPWrapper>(cb => client.sftp(cb));
          trackSftp(sftp);
          client.once('close', () => { if (session.control === connection) session.control = undefined; });
          sftp.on('error', () => {});
          return { client, sftp };
        } catch (error) { client.destroy(); throw error; }
      })();
      session.control = connection;
      void connection.catch(() => { if (session.control === connection) session.control = undefined; });
    }
    return session.control;
  }

  private async operation<T>(request: RemoteRequest, op: string, extra: Record<string, unknown> = {}): Promise<T> {
    const session = this.session(request.sessionId);
    const { client } = await this.control(session);
    return runRemoteOperation(client, op, { path: validPath(request.path), ...extra }, { elevated: request.elevated, sudoPassword: request.sudoPassword });
  }

  async remoteList(request: RemoteRequest): Promise<FileListing> {
    if (request.elevated) return this.operation(request, 'list');
    try {
      const { sftp } = await this.control(this.session(request.sessionId));
      const absolute = await sftpCall<string>(cb => sftp.realpath(validPath(request.path), cb));
      const files = await sftpCall<import('ssh2').FileEntry[]>(cb => sftp.readdir(absolute, cb));
      return { path: absolute, entries: files.filter(file => file.filename !== '.' && file.filename !== '..').map(file => {
        if (/[\0/]/.test(file.filename)) throw new Error('服务器返回无效文件名');
        const kind = file.attrs.mode & 0o170000;
        return { name: file.filename, path: path.posix.join(absolute, file.filename), type: kind === 0o120000 ? 'symlink' : kind === 0o040000 ? 'directory' : 'file', size: file.attrs.size, modified: file.attrs.mtime * 1000, mode: file.attrs.mode & 0o7777, owner: String(file.attrs.uid), group: String(file.attrs.gid) };
      }) };
    } catch (error) { throw remoteError(error); }
  }

  async readFile(request: RemoteRequest): Promise<TextFile> {
    if (request.elevated) return this.operation(request, 'read');
    const { sftp } = await this.control(this.session(request.sessionId));
    let handle: Buffer | undefined;
    try {
      const attributes = await remoteStat(sftp, validPath(request.path));
      if (!attributes?.isFile()) throw new Error('文本编辑仅支持普通文件，请先打开符号链接的实际目标');
      handle = await sftpCall<Buffer>(cb => sftp.open(request.path, 'r', cb));
      const opened = await sftpCall<Stats>(cb => sftp.fstat(handle!, cb));
      if (!opened.isFile()) throw new Error('所选对象不是普通文件');
      const buffer = Buffer.alloc(Math.min(opened.size, MAX_TEXT) + 1);
      let done = 0;
      while (done < buffer.length) {
        const bytes = await new Promise<number>((resolve, reject) => sftp.read(handle!, buffer, done, Math.min(64 * 1024, buffer.length - done), done, (error, count) => error ? reject(error) : resolve(count)));
        if (!bytes) break;
        done += bytes;
      }
      const content = buffer.subarray(0, Math.min(done, MAX_TEXT));
      if (content.includes(0)) throw new Error('该文件似乎是二进制文件，不能在文本编辑器中保存');
      const truncated = done > MAX_TEXT || opened.size > MAX_TEXT;
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(content, { stream: truncated }); }
      catch { throw new Error('文本不是 UTF-8 编码，首版编辑器暂不支持此编码'); }
      return { text, truncated };
    } catch (error) { throw remoteError(error); }
    finally { if (handle) await remoteClose(sftp, handle).catch(() => {}); }
  }

  async writeFile(request: RemoteRequest & { text: string }): Promise<void> {
    if (request.elevated) return this.operation(request, 'write', { text: request.text });
    if (typeof request.text !== 'string' || request.text.includes('\0')) throw new Error('请输入不含 NUL 字符的文本');
    const data = Buffer.from(request.text, 'utf8');
    if (data.length > MAX_TEXT) throw new Error('文本编辑最多支持 2 MiB，请使用文件传输');
    const { sftp } = await this.control(this.session(request.sessionId));
    const target = validPath(request.path);
    const temporary = path.posix.join(path.posix.dirname(target), `.gooeshell-edit-${randomUUID()}`);
    let handle: Buffer | undefined;
    let created = false;
    try {
      const previous = await remoteStat(sftp, target);
      if (previous && !previous.isFile()) throw new Error('不能覆盖目录或符号链接');
      handle = await sftpCall<Buffer>(cb => sftp.open(temporary, 'wx', { mode: 0o600 }, cb));
      created = true;
      for (let offset = 0; offset < data.length; offset += 64 * 1024) {
        const length = Math.min(64 * 1024, data.length - offset);
        await new Promise<void>((resolve, reject) => sftp.write(handle!, data, offset, length, offset, error => error ? reject(error) : resolve()));
      }
      if (previous) {
        const temporaryAttrs = await sftpCall<Stats>(cb => sftp.fstat(handle!, cb));
        if (temporaryAttrs.uid !== previous.uid || temporaryAttrs.gid !== previous.gid) {
          await new Promise<void>((resolve, reject) => sftp.fchown(handle!, previous.uid, previous.gid, error => error ? reject(error) : resolve()));
        }
        await new Promise<void>((resolve, reject) => sftp.fchmod(handle!, previous.mode & 0o7777, error => error ? reject(error) : resolve()));
      }
      await new Promise<void>((resolve, reject) => sftp.close(handle!, error => error ? reject(error) : resolve()));
      handle = undefined;
      const current = await remoteStat(sftp, target);
      if (previous ? !current || !sameFile(previous, current) : !!current) throw new Error('文件在编辑期间发生变化，本次保存已停止');
      if (previous) {
        try { await new Promise<void>((resolve, reject) => sftp.ext_openssh_rename(temporary, target, error => error ? reject(error) : resolve())); }
        catch (error) { if ((error as { code?: number }).code === 8 || /not supported/i.test(message(error))) throw new Error('服务器不支持原子替换文件，未覆盖原文件。可另存为新文件或使用 sudo 编辑。'); throw error; }
      } else await new Promise<void>((resolve, reject) => sftp.rename(temporary, target, error => error ? reject(error) : resolve()));
      created = false;
    } catch (error) { throw remoteError(error); }
    finally {
      if (handle) await remoteClose(sftp, handle).catch(() => {});
      if (created && !isSftpClosed(sftp)) await new Promise<void>(resolve => sftp.unlink(temporary, () => resolve()));
    }
  }

  private async textSnapshot(sftp: SFTPWrapper, target: string): Promise<{ data: Buffer; info: Stats; truncated: boolean; revision: string }> {
    const initial = await remoteStat(sftp, target);
    if (!initial) throw textConflict();
    if (!initial.isFile()) throw new Error('文本编辑仅支持普通文件，请先打开符号链接的实际目标');
    let handle: Buffer | undefined;
    try {
      handle = await sftpCall<Buffer>(cb => sftp.open(target, 'r', cb));
      const opened = await sftpCall<Stats>(cb => sftp.fstat(handle!, cb));
      if (!opened.isFile() || !sameFile(initial, opened)) throw textConflict();
      const buffer = Buffer.alloc(Math.min(opened.size, MAX_TEXT) + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = await new Promise<number>((resolve, reject) => sftp.read(handle!, buffer, length, Math.min(64 * 1024, buffer.length - length), length, (error, bytes) => error ? reject(error) : resolve(bytes)));
        if (!count) break;
        length += count;
      }
      const after = await sftpCall<Stats>(cb => sftp.fstat(handle!, cb));
      const current = await remoteStat(sftp, target);
      if (!current?.isFile() || !sameFile(opened, after) || !sameFile(after, current)) throw textConflict();
      const truncated = length > MAX_TEXT || after.size > MAX_TEXT;
      const data = buffer.subarray(0, Math.min(length, MAX_TEXT));
      return { data, info: after, truncated, revision: textRevision(data, textMetadata(after), truncated) };
    } finally { if (handle) await remoteClose(sftp, handle).catch(() => {}); }
  }

  async readTextFile(request: RemoteRequest & { encoding?: EditorEncoding }): Promise<EditableTextFile> {
    if (request.elevated) {
      const raw = await this.operation<{ data: string; truncated: boolean; revision: string; size: number }>(request, 'readBytes');
      return decodeEditableText(Buffer.from(raw.data, 'base64'), { ...raw, encoding: request.encoding });
    }
    try {
      const { sftp } = await this.control(this.session(request.sessionId));
      const snapshot = await this.textSnapshot(sftp, validPath(request.path));
      return decodeEditableText(snapshot.data, { encoding: request.encoding, truncated: snapshot.truncated, revision: snapshot.revision, size: snapshot.info.size });
    } catch (error) { throw remoteError(error); }
  }

  async writeTextFile(request: RemoteRequest & { text: string; encoding: EditorEncoding; expectedRevision: string; bom?: boolean }): Promise<TextWriteResult> {
    validateExpectedRevision(request.expectedRevision);
    const data = encodeEditableText(request.text, request.encoding, request.bom);
    const session = this.session(request.sessionId);
    const target = validPath(request.path);
    const key = `remote:${endpoint(session.profile)}:${session.profile.username}:${session.fingerprint}:${path.posix.normalize(target)}`;
    return serializeTextWrite(key, async () => {
      if (request.elevated) return this.operation<TextWriteResult>(request, 'writeBytes', { data: data.toString('base64'), expectedRevision: request.expectedRevision });
      const { sftp } = await this.control(session);
      const baseline = async () => {
        const info = await remoteStat(sftp, target);
        if (!info) {
          if (request.expectedRevision === 'missing') return undefined;
          throw textConflict();
        }
        const snapshot = await this.textSnapshot(sftp, target);
        if (snapshot.revision !== request.expectedRevision) throw textConflict();
        return snapshot;
      };
      const temporary = path.posix.join(path.posix.dirname(target), `.gooeshell-edit-${randomUUID()}`);
      let handle: Buffer | undefined;
      let created = false;
      try {
        const previous = await baseline();
        handle = await sftpCall<Buffer>(cb => sftp.open(temporary, 'wx', { mode: 0o600 }, cb));
        created = true;
        for (let offset = 0; offset < data.length; offset += 64 * 1024) {
          const length = Math.min(64 * 1024, data.length - offset);
          await new Promise<void>((resolve, reject) => sftp.write(handle!, data, offset, length, offset, error => error ? reject(error) : resolve()));
        }
        if (previous) {
          const attrs = await sftpCall<Stats>(cb => sftp.fstat(handle!, cb));
          if (attrs.uid !== previous.info.uid || attrs.gid !== previous.info.gid) {
            await new Promise<void>((resolve, reject) => sftp.fchown(handle!, previous.info.uid, previous.info.gid, error => error ? reject(error) : resolve()));
          }
          await new Promise<void>((resolve, reject) => sftp.fchmod(handle!, previous.info.mode & 0o7777, error => error ? reject(error) : resolve()));
        }
        const written = await sftpCall<Stats>(cb => sftp.fstat(handle!, cb));
        await new Promise<void>((resolve, reject) => sftp.close(handle!, error => error ? reject(error) : resolve()));
        handle = undefined;
        await baseline();
        if (previous) {
          try { await new Promise<void>((resolve, reject) => sftp.ext_openssh_rename(temporary, target, error => error ? reject(error) : resolve())); }
          catch (error) {
            if ((error as { code?: number }).code === 8 || /not supported/i.test(message(error))) throw new Error('服务器不支持原子替换文件，未覆盖原文件。可保存本地副本或使用 sudo 编辑。');
            throw error;
          }
        } else await new Promise<void>((resolve, reject) => sftp.rename(temporary, target, error => error ? reject(error) : resolve()));
        created = false;
        return { revision: textRevision(data, textMetadata(written)), size: data.length };
      } catch (error) { throw remoteError(error); }
      finally {
        if (handle) await remoteClose(sftp, handle).catch(() => {});
        if (created && !isSftpClosed(sftp)) await new Promise<void>(resolve => sftp.unlink(temporary, () => resolve()));
      }
    });
  }

  async chmod(request: RemoteRequest & { mode: number }): Promise<void> {
    const mode = modeValue(request.mode);
    if (request.elevated) return this.operation(request, 'chmod', { mode });
    try {
      const { sftp } = await this.control(this.session(request.sessionId));
      const attrs = await remoteStat(sftp, validPath(request.path));
      if (!attrs || attrs.isSymbolicLink()) throw new Error('不能修改不存在的文件或符号链接的权限');
      await new Promise<void>((resolve, reject) => sftp.chmod(request.path, (attrs.mode & 0o7000) | mode, error => error ? reject(error) : resolve()));
    } catch (error) { throw remoteError(error); }
  }

  async runFile(request: RemoteRequest & { makeExecutable: boolean }): Promise<CommandResult> {
    return this.operation(request, 'run', { makeExecutable: request.makeExecutable });
  }

  async mkdir(request: RemoteRequest): Promise<void> {
    if (request.elevated) return this.operation(request, 'mkdir');
    try {
      const { sftp } = await this.control(this.session(request.sessionId));
      await new Promise<void>((resolve, reject) => sftp.mkdir(validPath(request.path), { mode: 0o755 }, error => error ? reject(error) : resolve()));
    } catch (error) { throw remoteError(error); }
  }

  async rename(request: RemoteRequest & { destination: string }): Promise<void> {
    if (request.elevated) return this.operation(request, 'rename', { destination: validPath(request.destination) });
    try {
      const { sftp } = await this.control(this.session(request.sessionId));
      if (await remoteStat(sftp, validPath(request.destination))) throw new Error('目标已存在，未覆盖');
      await new Promise<void>((resolve, reject) => sftp.rename(validPath(request.path), request.destination, error => error ? reject(error) : resolve()));
    } catch (error) { throw remoteError(error); }
  }

  transfer(request: TransferRequest): string {
    const session = this.session(request.sessionId);
    if (request.elevated) throw new Error('本版暂不支持 sudo 大文件传输。请先传入自己有权限的目录；没有执行任何上传或下载。');
    if (request.direction !== 'upload' && request.direction !== 'download') throw new Error('无效的传输方向');
    validPath(request.source); validPath(request.destinationDir);
    const info: TransferInfo = { id: randomUUID(), sessionId: session.id, direction: request.direction, name: request.direction === 'upload' ? path.basename(request.source) : path.posix.basename(request.source), source: request.source, destination: request.destinationDir, total: 0, done: 0, state: 'queued' };
    const job: TransferJob = { info, abort: new AbortController() };
    this.jobs.set(info.id, job);
    let last = 0;
    const emit = (force = false) => {
      if (force || Date.now() - last > 100) { last = Date.now(); this.emit({ type: 'transfer', transfer: { ...info } }); }
    };
    emit(true);
    void (async () => {
      try {
        job.client = await this.openClient(session);
        if (job.abort.signal.aborted) throw new Error('已取消');
        const sftp = await sftpCall<SFTPWrapper>(cb => job.client!.sftp(cb));
        sftp.on('error', () => {});
        await performSftpTransfer(sftp, request, info, job.abort.signal, emit, endpoint(session.profile));
        info.state = 'completed';
      } catch (error) {
        info.state = job.abort.signal.aborted ? 'cancelled' : 'failed';
        info.error = job.abort.signal.aborted ? '传输已取消，可校验 .gooeshell.part 后续传' : remoteError(error).message;
      } finally {
        job.client?.destroy();
        this.jobs.delete(info.id);
        emit(true);
      }
    })();
    return info.id;
  }

  cancelTransfer(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.abort.abort();
    job.client?.destroy();
  }

  terminalInput(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session?.shell || session.closed || typeof data !== 'string') return;
    session.shell.write(session.profile.encoding === 'utf8' ? Buffer.from(data, 'utf8') : iconv.encode(data, session.profile.encoding));
  }

  terminalBinaryInput(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session?.shell || session.closed || typeof data !== 'string') return;
    // xterm.onBinary encodes byte values in JS code units (legacy mouse reports).
    session.shell.write(Buffer.from(data, 'latin1'));
  }

  terminalResize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    const shell = session?.shell;
    if (!shell || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) return;
    if (session && (session.terminalCols !== cols || session.terminalRows !== rows)) {
      shell.setWindow(rows, cols, 0, 0);
      session.terminalCols = cols;
      session.terminalRows = rows;
    }
    if (session && !session.terminalReady) {
      session.terminalReady = true;
      shell.resume(); shell.stderr.resume();
    }
  }

  terminalAck(id: string, bytes: number): void {
    const session = this.sessions.get(id);
    if (!session || !Number.isSafeInteger(bytes) || bytes < 0) return;
    session.pendingBytes = Math.max(0, session.pendingBytes - bytes);
    if (session.terminalReady && session.pendingBytes <= LOW_WATER) { session.shell?.resume(); session.shell?.stderr.resume(); }
  }

  private finishSession(session: Session, reason: string): void {
    if (session.closed) return;
    session.closed = true;
    for (const [id, question] of this.questions) {
      if (question.sessionId === session.id) this.confirmHostKey(id, 'reject');
    }
    for (const [id, job] of this.jobs) if (job.info.sessionId === session.id) this.cancelTransfer(id);
    for (const client of session.clients) client.destroy();
    session.clients.clear();
    if (Buffer.isBuffer(session.credentials.privateKey)) session.credentials.privateKey.fill(0);
    session.credentials = {};
    session.shell = undefined;
    this.sessions.delete(session.id);
    this.emit({ type: 'sessionClosed', sessionId: session.id, message: reason });
  }

  disconnect(id: string): void {
    const session = this.sessions.get(id);
    if (session) this.finishSession(session, '已断开连接');
  }

  shutdown(): void {
    this.stopped = true;
    for (const session of this.sessions.values()) this.finishSession(session, '应用正在退出');
  }
}
