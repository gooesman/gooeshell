import type {FontFamilyInfo} from './font-types';
export interface HostProfile {
  id: string; name: string; host: string; port: number; username: string;
  auth: 'password' | 'key' | 'agent'; privateKeyPath?: string;
  rememberHost: boolean; encoding: 'utf8' | 'gb18030' | 'big5';
}
export interface AppSettings {
  theme: 'dark' | 'light';
  showConnectionHistory: boolean; filesToggleIconOnly: boolean;
  fontWeight: number; chineseFontWeight: number;
  shortcutSchemaVersion: number;
  fontFamily: string; chineseFont: string; fontSize: number; lineHeight: number;
  cursorBlink: boolean; copyOnSelect: boolean; rightClickPaste: boolean;
  backgroundImage: string; backgroundOpacity: number;
  shortcuts: Record<string, string>;
}
export interface InitialState {
  profiles: HostProfile[]; settings: AppSettings; localHome: string; version: string;
  connectionHistory: ConnectionHistoryEntry[];
  hostKeyPreferences: HostKeyPreference[];
}
export interface ConnectionHistoryEntry { profile: HostProfile; connectedAt: number; }
export interface HostKeyPreference { host: string; port: number; skipVerification: boolean; }
export interface SessionInfo { id: string; profile: HostProfile; }
export interface ConnectRequest { profile: HostProfile; password?: string; passphrase?: string; skipHostKeyVerification?: boolean; }
export interface FileEntry {
  name: string; path: string; type: 'directory' | 'file' | 'symlink';
  size: number; modified: number; mode?: number; owner?: string; group?: string;
}
export interface FileListing { path: string; entries: FileEntry[]; }
export interface RemoteRequest { sessionId: string; path: string; sudoPassword?: string; elevated?: boolean; }
export interface TransferRequest {
  sessionId: string; direction: 'upload' | 'download'; source: string; destinationDir: string;
  resume: boolean; sudoPassword?: string; elevated?: boolean;
}
export interface TransferInfo {
  id: string; sessionId: string; direction: 'upload' | 'download'; name: string;
  source: string; destination: string; total: number; done: number;
  state: 'queued' | 'checking' | 'transferring' | 'completed' | 'cancelled' | 'failed';
  error?: string;
}
export interface TextFile { text: string; truncated: boolean; }
export interface CommandResult { output: string; exitCode: number; }
export type HostKeyDecision = 'once' | 'save' | 'reject';
export type AppEvent =
  | { type: 'terminal'; sessionId: string; data: string; bytes: number }
  | { type: 'sessionClosed'; sessionId: string; message: string }
  | { type: 'hostKey'; requestId: string; host: string; port: number; fingerprint: string; previousFingerprint?: string; saveAllowed?: boolean }
  | { type: 'transfer'; transfer: TransferInfo }
  | { type: 'notice'; message: string };

export interface DesktopApi {
  initial(): Promise<InitialState>;
  saveProfile(profile: HostProfile): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  connectionHistory(): Promise<ConnectionHistoryEntry[]>;
  clearConnectionHistory(): Promise<void>;
  setHostKeyPreference(preference: HostKeyPreference): Promise<void>;
  saveSettings(settings: AppSettings): Promise<void>;
  connect(request: ConnectRequest): Promise<SessionInfo>;
  disconnect(sessionId: string): Promise<void>;
  confirmHostKey(requestId: string, decision: HostKeyDecision): Promise<void>;
  localList(path: string): Promise<FileListing>;
  remoteList(request: RemoteRequest): Promise<FileListing>;
  chooseFiles(options: { directory?: boolean; multiple?: boolean; title?: string }): Promise<string[]>;
  showInFolder(path: string): Promise<void>;
  transfer(request: TransferRequest): Promise<string>;
  cancelTransfer(id: string): Promise<void>;
  readFile(request: RemoteRequest & { side: 'local' | 'remote' }): Promise<TextFile>;
  writeFile(request: RemoteRequest & { side: 'local' | 'remote'; text: string }): Promise<void>;
  chmod(request: RemoteRequest & { mode: number }): Promise<void>;
  runFile(request: RemoteRequest & { makeExecutable: boolean }): Promise<CommandResult>;
  mkdir(request: RemoteRequest & { side: 'local' | 'remote' }): Promise<void>;
  rename(request: RemoteRequest & { side: 'local' | 'remote'; destination: string }): Promise<void>;
  fonts(): Promise<string[]>;
  fontCatalog(): Promise<FontFamilyInfo[]>;
  backgroundData(path: string): Promise<string>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  fullscreen(): Promise<void>;
  minimize(): void; maximize(): void; closeWindow(): void;
  terminalInput(sessionId: string, data: string): void;
  terminalBinaryInput(sessionId: string, data: string): void;
  terminalResize(sessionId: string, cols: number, rows: number): void;
  terminalAck(sessionId: string, bytes: number): void;
  pathForFile(file: File): string;
  onEvent(handler: (event: AppEvent) => void): () => void;
}
declare global { interface Window { gooeshell?: DesktopApi; } }
