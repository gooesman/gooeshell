import test from 'node:test';
import assert from 'node:assert/strict';
import type { Dispatch, SetStateAction } from 'react';
import type { CreateLocalSessionRequest, LocalSessionInfo, SessionInfo, SshSessionInfo } from '../src/shared/types';
import { createLocalSessionController } from '../src/renderer/local-session-controller';
import { isLocalSession, isSshSession, sessionEncoding, sessionName } from '../src/shared/sessions';

const ssh: SshSessionInfo = { id: 'ssh', tabId: 'ssh-tab', profile: { id: 'host', name: '生产服务器', host: 'example.invalid', port: 22, username: 'demo', auth: 'password', encoding: 'utf8', rememberHost: true } };
const local = (id = 'local'): LocalSessionInfo => ({ kind: 'local', id, name: 'PowerShell 7', shell: 'pwsh', cwd: 'C:\\demo' });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (cause: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function fixture(sessions: SessionInfo[] = [], tabs = ['home'], activeId = 'home') {
  const state = { sessions: [...sessions], tabs: [...tabs], activeId };
  const pending: Record<string, boolean> = {}, errors: Record<string, string> = {};
  const requests: CreateLocalSessionRequest[] = [], disconnected: string[] = [];
  const process = deferred<LocalSessionInfo>();
  const setter = <K extends keyof typeof state>(key: K): Dispatch<SetStateAction<(typeof state)[K]>> => update => { state[key] = typeof update === 'function' ? (update as (old: (typeof state)[K]) => (typeof state)[K])(state[key]) : update; };
  const controller = createLocalSessionController({
    state: () => ({ ...state, setSessions: setter('sessions'), setTabs: setter('tabs'), setActiveId: setter('activeId') }),
    create: request => { requests.push(request); return process.promise; },
    disconnect: async id => { disconnected.push(id); },
    setPending: (id, value) => { pending[id] = value; }, setError: (id, value) => { errors[id] = value; },
  });
  return { state, pending, errors, requests, disconnected, process, ...controller };
}

test('home launch replaces its exact home tab and stores a true local session', async () => {
  const view = fixture(); const opening = view.open({ shell: 'cmd', cwd: 'C:\\工作项目' }, 'home');
  assert.equal(view.pending.home, true); view.process.resolve({ ...local(), shell: 'cmd' });
  assert.equal(await opening, true); assert.deepEqual(view.state.tabs, ['home']); assert.equal(view.state.activeId, 'local');
  assert.equal(view.state.sessions[0].tabId, 'home'); assert.equal(isLocalSession(view.state.sessions[0]), true);
  assert.equal('profile' in view.state.sessions[0], false); assert.equal(sessionEncoding(view.state.sessions[0]), 'utf8');
  assert.deepEqual(view.requests, [{ shell: 'cmd', cwd: 'C:\\工作项目' }]);
});
test('launch from SSH creates an independent tab and keeps the original transport', async () => {
  const view = fixture([ssh], ['ssh-tab'], 'ssh'); const opening = view.open({});
  const newTab = view.state.tabs[1]; assert.ok(newTab); assert.equal(view.state.activeId, newTab);
  view.process.resolve(local()); assert.equal(await opening, true);
  assert.equal(view.state.sessions[0], ssh); assert.equal(view.state.sessions[1].tabId, newTab); assert.equal(view.state.activeId, 'local');
  assert.deepEqual(view.disconnected, []); assert.equal(sessionName(ssh), '生产服务器'); assert.equal(isSshSession(ssh), true);
});
test('reopening a closed local process preserves tab identity and another selected terminal', async () => {
  const previous = { ...local('old-local'), tabId: 'local-tab' };
  const view = fixture([ssh, previous], ['ssh-tab', 'local-tab'], 'ssh');
  const opening = view.open({ shell: previous.shell, cwd: previous.cwd }, 'local-tab', previous.id);
  view.process.resolve(local('new-local')); assert.equal(await opening, true);
  assert.deepEqual(view.state.tabs, ['ssh-tab', 'local-tab']); assert.equal(view.state.activeId, 'ssh');
  assert.equal(view.state.sessions[0], ssh); assert.equal(view.state.sessions[1].id, 'new-local');
  assert.equal(view.state.sessions[1].tabId, 'local-tab'); assert.deepEqual(view.disconnected, []);
});
test('closing or cancelling a pending local tab stops only its late process', async () => {
  for (const closing of [false, true]) {
    const view = fixture([ssh], ['ssh-tab', 'home'], 'home'); const opening = view.open({}, 'home');
    view.cancel('home'); if (closing) { view.state.tabs = ['ssh-tab']; view.state.activeId = 'ssh'; }
    view.process.resolve(local('late')); assert.equal(await opening, false);
    assert.deepEqual(view.disconnected, ['late']); assert.deepEqual(view.state.sessions, [ssh]); assert.equal(view.pending.home, false);
  }
});
test('concurrent launches cannot replace an SSH transport or duplicate a pending tab', async () => {
  const view = fixture([ssh], ['ssh-tab', 'home'], 'home'); const opening = view.open({}, 'home');
  assert.equal(await view.open({}, 'home'), false); assert.equal(view.requests.length, 1);
  view.state.sessions.push({ ...ssh, id: 'new-ssh', tabId: 'home' });
  view.process.resolve(local()); assert.equal(await opening, false);
  assert.equal(view.state.sessions[1].id, 'new-ssh'); assert.deepEqual(view.disconnected, ['local']);
});
test('an occupied target is rejected before starting any replacement process', async () => {
  const view = fixture([ssh], ['ssh-tab'], 'ssh');
  assert.equal(await view.open({}, 'ssh-tab'), false); assert.deepEqual(view.requests, []);
  assert.deepEqual(view.state.sessions, [ssh]); assert.equal(view.state.activeId, 'ssh');
});
test('process start failures keep the home tab and expose a retryable error', async () => {
  const view = fixture(); const opening = view.open({ shell: 'pwsh' }, 'home');
  view.process.reject(new Error('启动目录不存在')); assert.equal(await opening, false);
  assert.deepEqual(view.state.tabs, ['home']); assert.deepEqual(view.state.sessions, []); assert.equal(view.errors.home, '启动目录不存在'); assert.equal(view.pending.home, false);
});
