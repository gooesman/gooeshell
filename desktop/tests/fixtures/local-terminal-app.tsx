import React from 'react';
import { createRoot } from 'react-dom/client';
import { defaultSettings } from '../../src/shared/defaults';
import type { AppEvent, DesktopApi, FileListing, HostProfile } from '../../src/shared/types';
import '../../src/renderer/styles.css';

const profile: HostProfile = { id: 'fixture-server', name: '测试 SSH', host: 'example.invalid', port: 22, username: 'fixture', auth: 'agent', rememberHost: true, encoding: 'utf8' };
const history = [{ profile, connectedAt: Date.UTC(2026, 8, 1) }];
const listeners = new Set<(event: AppEvent) => void>();
const outputStarted = new Set<string>();
let localIndex = 0, sshIndex = 0;
const control = {
  calls: [] as Array<{ method: string; id?: string; request?: unknown }>,
  chosenDirectory: 'C:\\Fixture\\工作项目',
  holdLocal: false, releaseLocal: () => {},
  emit: (event: AppEvent) => listeners.forEach(listener => listener(event)),
};
function output(id: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  control.emit({ type: 'terminal', sessionId: id, bytes: bytes.length, data: btoa(String.fromCharCode(...bytes)) });
}
const listing = (path: string, remote = false): FileListing => ({ path, entries: [{ name: '项目文件', path: path + (remote ? '/' : '\\') + '项目文件', type: 'directory', size: 0, modified: 1789027200000 }] });
const mock: Partial<DesktopApi> = {
  initial: async () => ({ profiles: [profile], connections: [profile], groups: [], connectionHistory: history, hostKeyPreferences: [], settings: structuredClone(defaultSettings), localHome: 'C:\\Fixture', version: '本地终端模拟测试' }),
  connections: async () => ({ profiles: [profile], connections: [profile], groups: [], history }),
  credentialStatus: async () => ({ remember:'session', sudoUsesLogin:true, hasPassword:false, hasPassphrase:false, hasSudoPassword:false, secureStorageAvailable:true }),
  listLoginIdentities: async () => ({identities:[],secureStorageAvailable:true}),
  listLocalShells: async () => [{ id: 'pwsh', name: 'PowerShell 7', available: true, isDefault: true }, { id: 'powershell', name: 'Windows PowerShell', available: true, isDefault: false }, { id: 'cmd', name: '命令提示符 (CMD)', available: true, isDefault: false }],
  createLocalSession: async (request = {}) => {
    control.calls.push({ method: 'createLocalSession', request });
    if (control.holdLocal) await new Promise<void>(resolve => { control.releaseLocal = resolve; });
    const shell = request.shell || 'pwsh';
    return { kind: 'local', id: 'local-' + ++localIndex, name: shell === 'cmd' ? 'CMD' : shell === 'powershell' ? 'Windows PowerShell' : 'PowerShell 7', shell, cwd: request.cwd || 'C:\\Fixture' };
  },
  connect: async request => { control.calls.push({ method: 'connect', request }); return { id: 'ssh-' + ++sshIndex, profile: request.profile }; },
  disconnect: async id => { control.calls.push({ method: 'disconnect', id }); },
  cancelConnect: async id => { control.calls.push({ method: 'cancelConnect', id }); },
  localList: async path => { control.calls.push({ method: 'localList', request: path }); return listing(path || 'C:\\Fixture'); },
  remoteList: async request => { control.calls.push({ method: 'remoteList', id: request.sessionId }); return listing('/home/fixture', true); },
  terminalCwd: async request => { control.calls.push({ method: 'terminalCwd', id: request.sessionId }); return { path: '/home/fixture', source: 'shell' }; },
  terminalResize: (id, cols, rows) => { control.calls.push({ method: 'terminalResize', id, request: { cols, rows } }); if (!outputStarted.has(id)) { outputStarted.add(id); queueMicrotask(() => output(id, '\r\nOUTPUT ' + id + ' 中文 ✓\r\n')); } },
  terminalInput: (id, data) => { control.calls.push({ method: 'terminalInput', id, request: data }); },
  terminalBinaryInput: (id, data) => { control.calls.push({ method: 'terminalBinaryInput', id, request: data }); },
  terminalAck: (id, bytes) => { control.calls.push({ method: 'terminalAck', id, request: bytes }); },
  chooseFiles: async request => { control.calls.push({ method: 'chooseFiles', request }); return [control.chosenDirectory]; },
  sendSudoPassword: async request => { control.calls.push({ method: 'sendSudoPassword', id: request.sessionId }); },
  readClipboard: async () => 'echo fixture', writeClipboard: async () => {}, pathForFile: () => '',
  saveSettings: async () => {}, fontCatalog: async () => [], fonts: async () => [], backgroundData: async () => '',
  commandLibrary: async () => ({ groups: [{ id: 'global', name: '通用命令', order: 0 }, { id: 'bound', name: '服务器命令', connectionId: profile.id, order: 1 }], commands: [{ id: 'global-command', groupId: 'global', name: '全局示例', command: 'echo hello', description: '', mode: 'insert', confirmBeforeRun: false, order: 0 }, { id: 'bound-command', groupId: 'bound', name: '专属示例', command: 'uname', description: '', mode: 'insert', confirmBeforeRun: false, order: 0 }] }),
  sendCommand: async request => { control.calls.push({ method: 'sendCommand', id: request.sessionId, request }); },
  onEvent: handler => { listeners.add(handler); return () => listeners.delete(handler); },
  fullscreen: async () => {}, maximize: () => {}, minimize: () => {}, closeWindow: () => {},
};
window.gooeshell = mock as DesktopApi;
// Keep mutable controls shared with the API closures.
(window as any).localTerminalFixture = Object.assign(control, { output, history });
const { default: App } = await import('../../src/renderer/App');
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
