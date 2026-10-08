import {promises as fs, constants as fsConstants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {IPty, IDisposable, IPtyForkOptions, IWindowsPtyForkOptions} from 'node-pty';
import type {AppEvent, CreateLocalSessionRequest, LocalSessionInfo, LocalShellInfo} from '../shared/types';
import {cleanCommandText} from './command-store';

const HIGH_WATER = 512 * 1024;
const LOW_WATER = 128 * 1024;
type PtyOptions = IPtyForkOptions & IWindowsPtyForkOptions;
export type PtySpawn = (file: string, args: string[], options: PtyOptions) => IPty;
export interface ShellEnvironment {
  platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; userShell?: string | null;
  executable?: (file: string) => Promise<boolean>;
}

function environment(): ShellEnvironment {
  let userShell: string | null | undefined;
  try { userShell = os.userInfo().shell; } catch {}
  return {platform: process.platform, env: process.env, home: os.homedir(), userShell};
}
async function executable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await fs.stat(file)).isFile()) return false;
    if (platform !== 'win32') await fs.access(file, fsConstants.X_OK);
    return true;
  }
  catch { return false; }
}
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) ?? name];
}

/** Only catalogued executables can be launched; a missing selected shell never falls back. */
export async function discoverLocalShells(context: ShellEnvironment = environment()): Promise<LocalShellInfo[]> {
  const windows = context.platform === 'win32', paths = windows ? path.win32 : path.posix;
  const exists = context.executable ?? ((file: string) => executable(file, context.platform));
  const find = async (name: string, extra: (string | undefined)[] = []) => {
    const candidates = [...extra, ...(envValue(context.env, 'PATH') ?? '').split(windows ? ';' : ':').filter(Boolean).map(directory => paths.join(directory.replace(/^"|"$/g, ''), name))];
    for (const file of candidates) if (file && paths.isAbsolute(file) && await exists(file)) return file;
  };
  const options: LocalShellInfo[] = [];
  const add = (id: string, name: string, file?: string) => options.push({id, name, ...(file ? {path: file} : {}), available: !!file, isDefault: false});
  if (windows) {
    const systemRoot = envValue(context.env, 'SystemRoot') ?? 'C:\\Windows';
    const programFiles = envValue(context.env, 'ProgramFiles');
    add('pwsh', 'PowerShell 7', await find('pwsh.exe', [programFiles && paths.join(programFiles, 'PowerShell', '7', 'pwsh.exe')]));
    add('powershell', 'Windows PowerShell', await find('powershell.exe', [paths.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]));
    add('cmd', '命令提示符', await find('cmd.exe', [envValue(context.env, 'ComSpec'), paths.join(systemRoot, 'System32', 'cmd.exe')]));
  } else {
    let defaultPath: string | undefined;
    for (const preferred of [context.userShell, context.env.SHELL]) {
      if (preferred && paths.isAbsolute(preferred) && await exists(preferred)) { defaultPath = preferred; break; }
    }
    if (!defaultPath) {
      const names = context.platform === 'darwin' ? ['zsh', 'bash', 'sh'] : ['bash', 'zsh', 'sh'];
      for (const name of names) { defaultPath = await find(name, ['/bin/' + name]); if (defaultPath) break; }
    }
    add('default', defaultPath ? paths.basename(defaultPath) + '（系统默认）' : '系统默认 Shell', defaultPath);
    for (const name of ['zsh', 'bash', 'sh']) {
      const file = await find(name, ['/bin/' + name, '/usr/bin/' + name]);
      if (file !== defaultPath) add(name, name, file);
    }
  }
  const first = options.find(option => option.available);
  if (first) first.isDefault = true;
  return options;
}

function spawnNative(file: string, args: string[], options: PtyOptions): IPty {
  // Load the entire module outside ASAR so its worker/child scripts and helpers
  // have real filesystem paths, as do the native libraries they load.
  const entry = require.resolve('node-pty').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  return (require(entry) as typeof import('node-pty')).spawn(file, args, options);
}
interface LocalSession {
  info: LocalSessionInfo; pty: IPty; listeners: IDisposable[];
  ready: boolean; closed: boolean; paused: boolean; pendingBytes: number; queuedBytes: number; queue: Buffer[];
  exited: boolean; exitMessage?: string; cols: number; rows: number; targetCols: number; targetRows: number; nativeReady: boolean; receivedData: boolean;
}
type ErrorEmitter = {on?: (event: string, listener: (error: Error) => void) => void; removeListener?: (event: string, listener: (error: Error) => void) => void};

export class LocalPtyService {
  private readonly sessions = new Map<string, LocalSession>();
  private readonly pendingStops = new Map<IPty, Promise<void>>();
  private stopped = false;
  constructor(private readonly emit: (event: AppEvent) => void, private readonly spawn: PtySpawn = spawnNative,
    private readonly context: ShellEnvironment = environment()) {}

  listLocalShells(): Promise<LocalShellInfo[]> { return discoverLocalShells(this.context); }
  has(id: unknown): boolean { return typeof id === 'string' && this.sessions.has(id); }
  private dimensions(cols: unknown, rows: unknown): boolean {
    return Number.isInteger(cols) && Number.isInteger(rows) && (cols as number) >= 1 && (rows as number) >= 1 && (cols as number) <= 1000 && (rows as number) <= 1000;
  }
  async createLocalSession(request: CreateLocalSessionRequest = {}): Promise<LocalSessionInfo> {
    if (this.stopped) throw new Error('应用正在退出，无法创建本地终端');
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('本地终端请求无效');
    if (request.shell !== undefined && (typeof request.shell !== 'string' || !request.shell)) throw new Error('请选择有效的本地 Shell');
    const shells = await this.listLocalShells(), selected = request.shell === undefined ? shells.find(shell => shell.isDefault) : shells.find(shell => shell.id === request.shell);
    if (!selected?.available || !selected.path) throw new Error(`本地 Shell ${selected?.name ?? request.shell ?? ''} 未安装或不可用，请安装后重试或选择其他 Shell。`);
    const cwd = request.cwd === undefined ? this.context.home : request.cwd;
    if (typeof cwd !== 'string' || !cwd || cwd.includes('\0') || !path.isAbsolute(cwd)) throw new Error('请选择有效的绝对工作目录');
    try { if (!(await fs.stat(cwd)).isDirectory()) throw new Error('not a directory'); }
    catch { throw new Error('本地终端工作目录不存在或无法访问：' + cwd); }
    const cols = request.cols ?? 80, rows = request.rows ?? 24;
    if (!this.dimensions(cols, rows)) throw new Error('本地终端尺寸无效');
    if (this.stopped) throw new Error('应用正在退出，无法创建本地终端');
    if (this.sessions.size >= 64) throw new Error('本地终端已达到 64 个，请先关闭不用的终端');
    const env: NodeJS.ProcessEnv = {...this.context.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'gooeshell'};
    delete env.ELECTRON_RUN_AS_NODE;
    const args = this.context.platform === 'win32' ? selected.id === 'cmd' ? ['/d'] : ['-NoLogo'] : ['-l'];
    let pty: IPty;
    try { pty = this.spawn(selected.path, args, {name: 'xterm-256color', cwd, cols, rows, env, encoding: null}); }
    catch (error) { throw new Error('本地终端启动失败：' + (error instanceof Error ? error.message : String(error))); }
    const info: LocalSessionInfo = {kind: 'local', id: randomUUID(), name: selected.name, shell: selected.id, cwd};
    const session: LocalSession = {info, pty, listeners: [], ready: false, closed: false, paused: false, pendingBytes: 0, queuedBytes: 0, queue: [], exited: false, cols, rows, targetCols: cols, targetRows: rows, nativeReady: this.context.platform !== 'win32', receivedData: false};
    this.sessions.set(info.id, session);
    const errors = pty as IPty & ErrorEmitter;
    const onError = (error: Error) => this.finish(session, '本地终端发生错误：' + error.message);
    try {
    errors.on?.('error', onError);
    // Keep an error handler installed while kill/pipe cleanup is in progress.
    // node-pty throws unexpected socket errors when no application listener exists.
    const cleanupError = pty.onExit(() => { errors.removeListener?.('error', onError); cleanupError.dispose(); });
    session.listeners.push(pty.onData(data => {
      if (session.closed) return;
      if (!session.receivedData) {
        session.receivedData = true;
        // Windows node-pty completes its own first-data readiness callback after
        // onData. Resize afterward so a deferred native operation cannot throw
        // outside our error handler if a startup shell exits immediately.
        queueMicrotask(() => { session.nativeReady = true; this.applyResize(session); });
      }
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      if (!bytes.length) return;
      session.queue.push(bytes); session.queuedBytes += bytes.length;
      this.flush(session);
    }), pty.onExit(({exitCode, signal}) => {
      if (session.closed) return;
      session.exited = true;
      session.exitMessage = `本地终端已退出（${signal ? '信号 ' + signal : '退出码 ' + exitCode}）`;
      this.flush(session);
    }));
    } catch (error) {
      this.finish(session, '本地终端启动失败');
      throw new Error('本地终端启动失败：' + (error instanceof Error ? error.message : String(error)));
    }
    // Startup text is cached in JS until the first renderer size, pausing the
    // native socket only when the buffer reaches the normal high-water limit.
    return {...info};
  }
  private pause(session: LocalSession): void {
    if (!session.paused && !session.exited) { session.pty.pause(); session.paused = true; }
  }
  private flush(session: LocalSession): void {
    if (session.closed) return;
    if (session.ready) while (session.queue.length && session.pendingBytes < HIGH_WATER) {
      const bytes = session.queue.shift()!; session.queuedBytes -= bytes.length; session.pendingBytes += bytes.length;
      this.emit({type: 'terminal', sessionId: session.info.id, data: bytes.toString('base64'), bytes: bytes.length});
    }
    if (session.ready && session.exited && !session.queue.length) { this.finish(session, session.exitMessage!); return; }
    if (session.pendingBytes + session.queuedBytes >= HIGH_WATER) this.pause(session);
    else if (session.paused && session.ready && !session.exited && !session.queue.length && session.pendingBytes <= LOW_WATER) {
      session.paused = false; session.pty.resume();
    }
  }
  terminalInput(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || session.closed || session.exited || typeof data !== 'string' || data.length > 1024 * 1024) return;
    session.pty.write(data);
  }
  terminalBinaryInput(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || session.closed || session.exited || typeof data !== 'string' || data.length > 1024 * 1024) return;
    session.pty.write(Buffer.from(data, 'latin1'));
  }
  terminalCommandInput(id: string, command: string, mode: 'insert' | 'execute', bracketedPaste: boolean): void {
    const session = this.sessions.get(id);
    if (!session || session.closed || session.exited) throw new Error('此本地终端已退出，请先重新打开');
    const text = cleanCommandText(command);
    if ((mode !== 'insert' && mode !== 'execute') || typeof bracketedPaste !== 'boolean') throw new Error('命令发送方式无效');
    if (!bracketedPaste && /[\n\t]/.test(text)) throw new Error('当前终端未启用括号粘贴，无法完整填入多行或含制表符的命令。请改用单行命令。');
    session.pty.write((bracketedPaste ? '\x1b[200~' + text.replace(/\n/g, '\r') + '\x1b[201~' : text) + (mode === 'execute' ? '\r' : ''));
  }
  terminalResize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session || !this.dimensions(cols, rows)) return;
    session.targetCols = cols; session.targetRows = rows; this.applyResize(session);
    session.ready = true; this.flush(session);
  }
  private applyResize(session: LocalSession): void {
    if (session.closed || session.exited || !session.nativeReady || session.cols === session.targetCols && session.rows === session.targetRows) return;
    try { session.pty.resize(session.targetCols, session.targetRows); session.cols = session.targetCols; session.rows = session.targetRows; }
    catch (error) {
      // A Windows process may exit before node-pty's delayed onExit event. Its
      // buffered output must still drain before the single sessionClosed event.
      if (!/already exited/i.test(String(error))) this.finish(session, '本地终端调整尺寸失败：' + String(error));
    }
  }
  terminalAck(id: string, bytes: number): void {
    const session = this.sessions.get(id);
    if (!session || !Number.isSafeInteger(bytes) || bytes < 0) return;
    session.pendingBytes = Math.max(0, session.pendingBytes - bytes); this.flush(session);
  }
  private finish(session: LocalSession, message: string): void {
    if (session.closed) return;
    session.closed = true; this.sessions.delete(session.info.id);
    for (const listener of session.listeners) listener.dispose();
    session.queue.length = 0;
    if (!session.exited) {
      const stopped = new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout>;
        const listener = session.pty.onExit(() => { clearTimeout(timer); listener.dispose(); resolve(); });
        timer = setTimeout(() => { listener.dispose(); resolve(); }, 5500);
        timer.unref();
      });
      this.pendingStops.set(session.pty, stopped);
      void stopped.finally(() => this.pendingStops.delete(session.pty));
      // WindowsTerminal defers kill until its first data event. Resuming here
      // lets that readiness event run even when the view was never mounted.
      try { if (session.paused) session.pty.resume(); session.pty.kill(); } catch {}
    }
    this.emit({type: 'sessionClosed', sessionId: session.info.id, message});
  }
  disconnect(id: string): void { const session = this.sessions.get(id); if (session) this.finish(session, '本地终端已关闭'); }
  shutdown(): Promise<void> {
    this.stopped = true;
    for (const session of this.sessions.values()) this.finish(session, '应用正在退出');
    // Includes terminals whose tabs were just closed. Wait for node-pty's console
    // helper and its five-second fallback before Electron can terminate itself.
    return Promise.all(this.pendingStops.values()).then(() => {});
  }
}
