import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/renderer/App';
import { api, isPreview } from '../../src/renderer/api';
import type { AppEvent, FileEntry, FileListing, HostProfile, RemoteRequest } from '../../src/shared/types';
import '../../src/renderer/styles.css';
import '../../src/renderer/terminal-fonts.css';

if (!isPreview) throw new Error('This fixture requires the isolated demo API');
const originalInitial = api.initial;
const profiles: HostProfile[] = ['a', 'b'].map(id => ({ id: `fixture-${id}`, name: `测试服务器 ${id.toUpperCase()}`, host: `192.0.2.${id === 'a' ? '10' : '11'}`, port: 22, username: 'fixture', auth: 'agent', rememberHost: true, encoding: 'utf8' }));
await api.deleteConnection('preview');
for (const profile of profiles) await api.saveConnection({ profile, favorite: true });
const listeners = new Set<(event: AppEvent) => void>();
type Request = RemoteRequest & { side?: 'local' | 'remote'; destination?: string; recursive?: boolean };
const calls: Array<{ method: string; request: Record<string, unknown> }> = [];
const volumes = new Map<string, Map<string, FileEntry>>();
let connectionIndex = 0;
const parents = (value: string) => value.replace(/[\\/][^\\/]+$/, '') || '/';
const rootFor = (sessionId: string) => sessionId.includes('fixture-b') ? '/home/b' : '/home/a';
function volume(sessionId: string, side = 'remote') {
  const key = side === 'local' ? 'local' : sessionId;
  let entries = volumes.get(key);
  if (!entries) {
    entries = new Map(); volumes.set(key, entries);
    const base = side === 'local' ? 'C:\\Fixture' : rootFor(sessionId), separator = side === 'local' ? '\\' : '/';
    for (const [name, type] of [['docs', 'directory'], ['locked', 'directory'], ['alpha.txt', 'file'], ['beta.txt', 'file']] as const) {
      const path = base + separator + name;
      entries.set(path, { name, path, type, size: type === 'file' ? (name === 'alpha.txt' ? 2048 : 12) : 0, modified: name === 'beta.txt' ? 1_788_940_800_000 : 1_789_027_200_000, mode: type === 'file' ? (name === 'alpha.txt' ? 0o100644 : 0o100600) : 0o40755 });
    }
    const nested = base + separator + 'docs' + separator + 'nested.txt';
    entries.set(nested, { name: 'nested.txt', path: nested, type: 'file', size: 5, modified: 1_789_027_200_000, mode: 0o100644 });
  }
  return entries;
}
let held: (() => void) | undefined;
const control = {
  calls, denyNext: '', denyPath: '', holdNext: '', held: false, cwd: {} as Record<string, string>,
  release: () => { held?.(); held = undefined; control.held = false; },
  emit: (event: AppEvent) => listeners.forEach(listener => listener(event)),
  entries: (sessionId: string, side = 'remote') => [...volume(sessionId, side).keys()],
  entry: (sessionId: string, path: string, side = 'remote') => volume(sessionId, side).get(path),
};
async function record(method: string, request: Request) {
  calls.push({ method, request: { ...request } });
  if (control.holdNext === method) { control.holdNext = ''; control.held = true; await new Promise<void>(resolve => { held = resolve; }); }
  if (control.denyNext === method && (!control.denyPath || control.denyPath === request.path) && !request.elevated) { control.denyNext = ''; control.denyPath = ''; throw new Error('PERMISSION_DENIED: fixture requires sudo'); }
}
async function list(request: Request): Promise<FileListing> {
  await record(request.side === 'local' ? 'localList' : 'remoteList', request);
  const path = !request.path || request.path === '.' ? rootFor(request.sessionId) : request.path;
  return { path, entries: [...volume(request.sessionId, request.side).values()].filter(entry => parents(entry.path) === path).map(entry => ({ ...entry })) };
}
async function create(request: Request, type: 'file' | 'directory') {
  await record(type === 'file' ? 'createFile' : 'mkdir', request);
  const entries = volume(request.sessionId, request.side);
  if (entries.has(request.path)) throw new Error('文件已存在');
  const name = request.path.split(/[\\/]/).at(-1)!;
  entries.set(request.path, { name, path: request.path, type, size: 0, modified: Date.now(), mode: type === 'file' ? 0o100644 : 0o40755 });
}
api.initial = async () => ({ ...(await originalInitial()), localHome: 'C:\\Fixture' });
api.connect = async request => { const id = `${request.profile.id}-${++connectionIndex}`; calls.push({ method: 'connect', request: { sessionId: id, profileId: request.profile.id } }); volume(id); return { id, profile: request.profile }; };
api.onEvent = listener => { listeners.add(listener); return () => { listeners.delete(listener); }; };
api.disconnect = async sessionId => control.emit({ type: 'sessionClosed', sessionId, message: 'fixture disconnected' });
api.localList = path => list({ sessionId: '', path, side: 'local' });
api.remoteList = request => list({ ...request, side: 'remote' });
api.mkdir = request => create(request, 'directory');
api.rename = async request => {
  await record('rename', request); const entries = volume(request.sessionId, request.side), entry = entries.get(request.path);
  if (!entry) throw new Error('文件不存在'); if (entries.has(request.destination)) throw new Error('目标已存在');
  entries.delete(request.path); entries.set(request.destination, { ...entry, name: request.destination.split(/[\\/]/).at(-1)!, path: request.destination });
};
Object.assign(api, {
  createFile: (request: Request) => create(request, 'file'),
  removeFile: async (request: Request) => {
    await record('removeFile', request); const entries = volume(request.sessionId, request.side), entry = entries.get(request.path);
    if (!entry) throw new Error('文件不存在');
    const separator = request.side === 'local' ? '\\' : '/';
    if (entry.type === 'directory' && !request.recursive) throw new Error('目录删除必须明确递归');
    for (const path of entries.keys()) if (path === request.path || (entry.type === 'directory' && path.startsWith(request.path + separator))) entries.delete(path);
  },
  terminalCwd: async ({ sessionId }: { sessionId: string }) => { calls.push({ method: 'terminalCwd', request: { sessionId } }); return { path: control.cwd[sessionId] || rootFor(sessionId), source: 'shell' }; },
});
(window as any).appExplorerFixture = control;
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
