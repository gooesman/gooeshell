const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const url = process.env.GOOESHELL_CONNECTIONS_FLOW_URL;
const report = process.env.GOOESHELL_CONNECTIONS_FLOW_REPORT;
if (!url || new URL(url).hostname !== '127.0.0.1' || !report || !process.env.GOOESHELL_CONNECTIONS_FLOW_DATA) throw new Error('An isolated loopback fixture and data directory are required');
app.setPath('userData', process.env.GOOESHELL_CONNECTIONS_FLOW_DATA);
const result = { checks: {}, errors: [] };
const profile = { id: 'one', name: '开发服务器', host: 'dev.example.test', port: 22, username: 'developer', auth: 'password', rememberHost: true, encoding: 'utf8', icon: 'code' };
const other = { ...profile, id: 'two', name: '其他服务器', host: 'other.example.test' };
const first = { id: 'transport-one', tabId: 'stable-tab-one', profile };
const second = { id: 'transport-two', tabId: 'stable-tab-two', profile: other };
const secret = { remember: 'session', password: 'fixture-only', sudoUsesLogin: true };
const backend = {
  connections: [profile, other], calls: [], plan: 'success', next: 0, pending: [], holdSave: false, pendingSave: null, sudoMissing: true,
};
let window, phase = 'startup';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = script => window.webContents.executeJavaScript(script);
const state = () => evaluate('window.connectionHarness.state');
async function until(predicate, label) {
  const end = Date.now() + 8_000;
  while (!(await predicate())) { if (Date.now() > end) throw new Error('Timed out: ' + label); await delay(20); }
}
async function invoke(method, args = [], wait = true) {
  const expression = `window.connectionHarness.${method}(...${JSON.stringify(args)})`;
  return evaluate(wait ? expression : `void ${expression}`);
}
async function reset({ offline = false, empty = false, tabs, activeId } = {}) {
  assert.equal(backend.pending.length, 0, 'previous attempts must settle before the next scenario');
  backend.connections = [structuredClone(profile), structuredClone(other)]; backend.calls = []; backend.plan = 'success'; backend.sudoMissing = true;
  const sessions = empty ? [] : [first, second];
  activeId ??= empty ? '' : first.id;
  await invoke('reset', [{ sessions, tabs, activeId, closed: offline ? { [first.id]: '断开' } : {} }]);
  await until(async () => (await state()).sessions.length === sessions.length && (await state()).activeId === activeId, 'state reset');
  await invoke('refresh');
  await until(async () => (await state()).catalog.length === 2, 'catalog refresh');
  backend.calls = [];
}
function resolvePending() {
  const pending = backend.pending.shift();
  assert.ok(pending, 'an SSH attempt should be pending');
  const session = { id: 'connected-' + (++backend.next), profile: pending.request.profile };
  pending.resolve(session);
  return session.id;
}
async function run() {
  await app.whenReady();
  ipcMain.handle('connections-flow:call', async (event, method, value) => {
    assert.equal(event.sender, window.webContents);
    backend.calls.push({ method, value });
    if (method === 'connections') return { connections: backend.connections, profiles: backend.connections, groups: [], history: backend.connections.map(profile => ({ profile, connectedAt: 100 })) };
    if (method === 'saveConnection') { backend.connections = backend.connections.map(profile => profile.id === value.profile.id ? value.profile : profile); return value.profile; }
    if (method === 'credentialStatus') return { remember: 'session', hasPassword: false, hasPassphrase: false, hasSudoPassword: false, sudoUsesLogin: true, secureStorageAvailable: true };
    if (method === 'connect') {
      if (backend.plan === 'auth') throw new Error('AUTH_REQUIRED: 请填写登录密码');
      if (backend.plan === 'deferred') return new Promise(resolve => backend.pending.push({ request: value, resolve }));
      return { id: 'connected-' + (++backend.next), profile: value.profile };
    }
    if (method === 'cancelConnect' || method === 'disconnect') return;
    if (method === 'saveCredentials') {
      if (backend.holdSave) return new Promise(resolve => { backend.pendingSave = resolve; });
      return;
    }
    if (method === 'sendSudoPassword') { if (backend.sudoMissing) throw new Error('SUDO_PASSWORD_REQUIRED: 请填写 sudo 密码'); return; }
    throw new Error('Unexpected API ' + method);
  });
  window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { preload: path.join(__dirname, 'connections-flow-render-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', (...args) => {
    const details = args[0], message = typeof args[2] === 'string' ? args[2] : details.message, level = typeof args[1] === 'number' ? args[1] : details.level;
    if (level >= 3 || level === 'error') result.errors.push(message);
  });
  window.webContents.on('render-process-gone', (_event, detail) => result.errors.push(JSON.stringify(detail)));
  await window.loadURL(url); await until(() => evaluate('Boolean(window.connectionHarness)'), 'fixture mount');

  phase = 'online direct connection reuses active transport';
  await reset(); await invoke('setActiveId', [second.id]);
  await until(async () => (await state()).activeId === second.id, 'second tab active');
  await invoke('direct', [profile]);
  await until(async () => (await state()).activeId === first.id, 'online connection focused');
  assert.equal(backend.calls.some(call => call.method === 'connect'), false);
  assert.equal((await state()).sessions.length, 2);
  result.checks.onlineDirectFocusesExisting = true;

  phase = 'offline reconnect retains tab identity and suppresses duplicate attempts';
  await reset({ offline: true }); backend.plan = 'deferred';
  await invoke('reconnect', [first.id], false);
  await until(() => backend.pending.length === 1, 'reconnect starts');
  await invoke('reconnect', [first.id]);
  assert.equal(backend.calls.filter(call => call.method === 'connect').length, 1);
  const newId = resolvePending();
  await until(async () => (await state()).sessions.some(session => session.id === newId), 'reconnect returns');
  assert.equal((await state()).sessions.find(session => session.id === newId).tabId, first.tabId);
  assert.equal((await state()).activeId, newId);
  assert.equal((await state()).sessions.length, 2);
  result.checks.reconnectKeepsTabAndOneAttempt = true;

  phase = 'background reconnect does not steal the selected terminal';
  await reset({ offline: true }); backend.plan = 'deferred';
  await invoke('reconnect', [first.id], false); await until(() => backend.pending.length === 1, 'background reconnect starts');
  await invoke('setActiveId', [second.id]); await until(async () => (await state()).activeId === second.id, 'switch while reconnecting');
  const backgroundId = resolvePending(); await until(async () => (await state()).sessions.some(session => session.id === backgroundId), 'background reconnect finished');
  assert.equal((await state()).activeId, second.id);
  result.checks.backgroundReconnectPreservesSelection = true;

  phase = 'a cancelled late success is disconnected instead of added';
  await reset({ empty: true }); backend.plan = 'deferred';
  await invoke('direct', [profile], false); await until(() => backend.pending.length === 1, 'connect starts');
  await until(async () => (await state()).hasUntargetedPending, 'untargeted pending banner');
  const pendingAttempt = backend.pending[0].request.attemptId;
  await invoke('cancel');
  await until(async () => !(await state()).hasUntargetedPending, 'cancel hides untargeted pending banner');
  assert.ok(backend.calls.some(call => call.method === 'cancelConnect' && call.value === pendingAttempt));
  const cancelledId = resolvePending();
  await until(() => backend.calls.some(call => call.method === 'disconnect' && call.value === cancelledId), 'cancelled transport cleanup');
  assert.equal((await state()).sessions.length, 0);
  await until(async () => !Object.values((await state()).pending).some(Boolean), 'cancelled state settled');
  result.checks.cancelCleansLateTransport = true;

  phase = 'closing a reconnecting tab cannot create an orphan transport';
  await reset({ offline: true }); backend.plan = 'deferred';
  await invoke('reconnect', [first.id], false); await until(() => backend.pending.length === 1, 'reconnect pending before close');
  await invoke('close', [first.id]); await until(async () => (await state()).sessions.length === 1, 'tab closes');
  const closedId = resolvePending();
  await until(() => backend.calls.some(call => call.method === 'disconnect' && call.value === closedId), 'closed tab transport cleanup');
  assert.equal((await state()).sessions.length, 1);
  assert.equal((await state()).activeId, second.id);
  await until(async () => !Object.values((await state()).pending).some(Boolean), 'closed reconnect state settled');
  result.checks.closeCleansPendingReconnect = true;

  phase = 'direct authentication failure opens a compact prompt';
  await reset({ empty: true }); backend.plan = 'auth';
  await invoke('direct', [profile]); await until(async () => (await state()).prompt?.mode === 'connect', 'authentication prompt');
  await until(() => evaluate(`Boolean(document.querySelector('.modal.compact[aria-label="身份验证"] input[type="password"]'))`), 'compact authentication rendered');
  assert.equal(await evaluate(`Boolean(document.getElementById('host-address'))`), false);
  backend.plan = 'success'; await invoke('submitAuth', [secret]);
  await until(async () => (await state()).sessions.length === 1 && !(await state()).prompt, 'authentication connects');
  const authCall = backend.calls.filter(call => call.method === 'connect').at(-1);
  assert.equal(authCall.value.profile.id, profile.id); assert.equal(authCall.value.credentials.password, 'fixture-only');
  result.checks.authenticationUsesCompactPrompt = true;

  phase = 'sudo prompt remains bound to its captured target';
  await reset();
  await invoke('sudo', [first.id]); await until(async () => (await state()).prompt?.mode === 'sudo', 'sudo prompt');
  assert.equal((await state()).prompt.sessionId, first.id);
  backend.holdSave = true;
  await invoke('submitAuth', [{ remember: 'session', sudoPassword: 'fixture-sudo', sudoUsesLogin: false }], false);
  await until(() => !!backend.pendingSave, 'credential save pending');
  await invoke('setActiveId', [second.id]); await until(async () => (await state()).activeId === second.id, 'sudo target switched');
  backend.sudoMissing = false; backend.holdSave = false; backend.pendingSave(); backend.pendingSave = null;
  await until(async () => !(await state()).authBusy && !(await state()).prompt, 'sudo prompt resolved');
  assert.equal(backend.calls.filter(call => call.method === 'sendSudoPassword').length, 1, 'only initial missing-password request occurs; no secret is sent after switching');
  assert.match((await state()).messages.at(-1).message, /目标终端已切换或断开/);
  assert.equal(backend.calls.find(call => call.method === 'saveCredentials').value.profile.id, profile.id);
  result.checks.sudoRechecksCapturedTargetAfterSaving = true;

  phase = 'saving metadata refreshes shared labels without connecting';
  await reset();
  const changed = { ...profile, name: '重命名服务器', icon: 'cloud', groupId: 'work' };
  await invoke('save', [changed, true]);
  await until(async () => (await state()).profiles[0].name === changed.name && (await state()).sessions[0].profile.name === changed.name, 'metadata refresh');
  assert.equal((await state()).history[0].profile.name, changed.name);
  assert.equal((await state()).sessions[0].profile.icon, 'cloud');
  assert.equal(backend.calls.some(call => call.method === 'connect'), false);
  result.checks.saveMetadataDoesNotConnect = true;

  phase = 'editing the saved endpoint leaves a running terminal bound to its original host';
  await invoke('save', [{ ...changed, host: 'replacement.example.test' }, true]);
  await until(async () => (await state()).catalog[0].host === 'replacement.example.test', 'new endpoint saved');
  assert.equal((await state()).sessions[0].profile.host, profile.host);
  result.checks.endpointEditDoesNotRetargetOpenSession = true;

  phase = 'old live target cannot overwrite replacement target credentials';
  backend.calls = []; backend.sudoMissing = true;
  await invoke('sudo', [first.id]); await until(async () => (await state()).prompt?.mode === 'sudo', 'old target sudo prompt');
  await invoke('submitAuth', [{ remember: 'session', sudoPassword: 'fixture-old-target', sudoUsesLogin: false }]);
  await until(async () => !!(await state()).authError, 'old target credential guard rendered');
  assert.match((await state()).authError, /更换地址或账号/);
  assert.equal(backend.calls.some(call => call.method === 'saveCredentials'), false);
  assert.equal(backend.calls.filter(call => call.method === 'sendSudoPassword').length, 1);
  result.checks.oldTargetCannotReplaceNewCredentials = true;

  phase = 'old target reconnect gets a separate profile and keeps its terminal tab';
  await invoke('setClosed', [{ [first.id]: '断开' }]);
  await until(async () => !!(await state()).closed[first.id], 'old target disconnected');
  backend.calls = [];
  await invoke('reconnect', [first.id]);
  const reconnectCall = backend.calls.find(call => call.method === 'connect');
  assert.ok(reconnectCall); assert.equal(reconnectCall.value.profile.host, profile.host);
  assert.notEqual(reconnectCall.value.profile.id, profile.id);
  assert.equal(reconnectCall.value.credentials, undefined);
  await until(async () => (await state()).sessions.some(session => session.profile.id === reconnectCall.value.profile.id), 'old target reconnect finished');
  assert.equal((await state()).sessions.find(session => session.profile.id === reconnectCall.value.profile.id).tabId, first.tabId);
  assert.equal((await state()).catalog.find(value => value.id === profile.id).host, 'replacement.example.test');
  result.checks.oldTargetReconnectUsesSeparateProfile = true;

  phase = 'an initial blank tab becomes the connected terminal without adding another tab';
  await reset({ empty: true, tabs: ['home-one'], activeId: 'home-one' });
  await invoke('direct', [profile]);
  await until(async () => (await state()).sessions.length === 1, 'initial home connected');
  let workspace = await state();
  assert.deepEqual(workspace.tabs, ['home-one']);
  assert.equal(workspace.sessions[0].tabId, 'home-one');
  assert.equal(workspace.activeId, workspace.sessions[0].id);
  result.checks.initialHomeBecomesTerminal = true;

  phase = 'an explicit home tab opens a second transport instead of reusing an existing connection';
  await reset({ tabs: [first.tabId, 'home-one', second.tabId], activeId: 'home-one' });
  await invoke('direct', [profile, false, 'home-one']);
  await until(async () => (await state()).sessions.length === 3, 'explicit home connected');
  workspace = await state();
  assert.deepEqual(workspace.tabs, [first.tabId, 'home-one', second.tabId]);
  assert.equal(workspace.sessions.find(session => session.id === workspace.activeId).tabId, 'home-one');
  assert.ok(workspace.sessions.some(session => session.id === first.id));
  assert.equal(backend.calls.filter(call => call.method === 'connect').length, 1);
  result.checks.explicitHomeDoesNotReuseTransport = true;

  phase = 'untargeted connections append a tab while ordinary direct actions can reuse a live terminal';
  await reset({ tabs: [first.tabId, 'home-one', second.tabId], activeId: 'home-one' });
  await invoke('direct', [profile]);
  await until(async () => (await state()).activeId === first.id, 'existing transport reused from home');
  assert.equal(backend.calls.some(call => call.method === 'connect'), false);
  await invoke('establish', [other]);
  await until(async () => (await state()).sessions.length === 3 && (await state()).tabs.length === 4, 'untargeted tab appended');
  workspace = await state();
  assert.deepEqual(workspace.tabs.slice(0, 3), [first.tabId, 'home-one', second.tabId]);
  assert.equal(workspace.tabs[3], workspace.sessions.find(session => session.id === workspace.activeId).tabId);
  result.checks.untargetedConnectAppendsTab = true;

  phase = 'a home connection finishing in the background preserves the selected home tab';
  await reset({ empty: true, tabs: ['home-one', 'home-two'], activeId: 'home-one' }); backend.plan = 'deferred';
  await invoke('direct', [profile, false, 'home-one'], false);
  await until(() => backend.pending.length === 1, 'home connection pending');
  assert.equal((await state()).hasUntargetedPending, false, 'targeted home must not create a global pending banner');
  await invoke('direct', [profile, false, 'home-one']);
  assert.equal(backend.calls.filter(call => call.method === 'connect').length, 1);
  await invoke('setActiveId', ['home-two']);
  await until(async () => (await state()).activeId === 'home-two', 'other home selected');
  const homeBackgroundId = resolvePending();
  await until(async () => (await state()).sessions.some(session => session.id === homeBackgroundId), 'background home finished');
  workspace = await state();
  assert.equal(workspace.activeId, 'home-two');
  assert.equal(workspace.sessions[0].tabId, 'home-one');
  assert.deepEqual(workspace.tabs, ['home-one', 'home-two']);
  result.checks.backgroundHomeDoesNotStealSelection = true;

  phase = 'closing a connecting home cancels and disposes a late SSH result';
  await reset({ empty: true, tabs: ['home-one', 'home-two'], activeId: 'home-one' }); backend.plan = 'deferred';
  await invoke('direct', [profile, false, 'home-one'], false);
  await until(() => backend.pending.length === 1, 'closing home pending');
  const homeAttempt = backend.pending[0].request.attemptId;
  await invoke('cancel', ['home-one']); await invoke('setTabs', [['home-two']]); await invoke('setActiveId', ['home-two']);
  await until(async () => !(await state()).pending['home-one'], 'cancel clears closed home pending marker');
  assert.equal((await state()).hasUntargetedPending, false, 'closed home must not become an untargeted pending banner');
  assert.ok(backend.calls.some(call => call.method === 'cancelConnect' && call.value === homeAttempt));
  const closedHomeId = resolvePending();
  await until(() => backend.calls.some(call => call.method === 'disconnect' && call.value === closedHomeId), 'closed home transport disposed');
  await until(async () => !Object.values((await state()).pending).some(Boolean), 'closed home settled');
  assert.equal((await state()).sessions.length, 0);
  assert.deepEqual((await state()).tabs, ['home-two']);
  result.checks.closedHomeCannotResurrect = true;

  phase = 'a targeted auth prompt cannot reconnect after its home tab was removed';
  await reset({ empty: true, tabs: ['home-one', 'home-two'], activeId: 'home-one' }); backend.plan = 'auth';
  await invoke('direct', [profile, false, 'home-one']);
  await until(async () => (await state()).prompt?.tabId === 'home-one', 'auth bound to home');
  // Remove without cancel to exercise the stale-prompt guard independently.
  await invoke('setTabs', [['home-two']]); await invoke('setActiveId', ['home-two']);
  await until(async () => (await state()).tabs.length === 1, 'auth target removed');
  const authAttemptsBefore = backend.calls.filter(call => call.method === 'connect').length;
  backend.plan = 'success'; await invoke('submitAuth', [secret]);
  await until(async () => !(await state()).prompt && !(await state()).authBusy, 'stale prompt dismissed');
  assert.equal(backend.calls.filter(call => call.method === 'connect').length, authAttemptsBefore);
  assert.equal((await state()).sessions.length, 0);
  result.checks.closedHomeRejectsStaleAuthentication = true;

  phase = 'authentication retry fills its original home and preserves a later selection';
  await reset({ empty: true, tabs: ['home-one', 'home-two'], activeId: 'home-one' }); backend.plan = 'auth';
  await invoke('direct', [profile, false, 'home-one']);
  await until(async () => (await state()).prompt?.tabId === 'home-one', 'retry auth bound to home');
  backend.plan = 'deferred'; await invoke('submitAuth', [secret], false);
  await until(() => backend.pending.length === 1, 'authenticated home pending');
  await invoke('setActiveId', ['home-two']); await until(async () => (await state()).activeId === 'home-two', 'switch during authentication');
  const authenticatedHomeId = resolvePending();
  await until(async () => (await state()).sessions.some(session => session.id === authenticatedHomeId) && !(await state()).prompt, 'authenticated home finished');
  assert.equal((await state()).activeId, 'home-two');
  assert.equal((await state()).sessions[0].tabId, 'home-one');
  result.checks.homeAuthenticationPreservesTargetAndSelection = true;

  phase = 'closing a terminal selects an adjacent home in workspace order';
  await reset({ tabs: [first.tabId, 'home-one', second.tabId], activeId: first.id });
  await invoke('close', [first.id]);
  await until(async () => (await state()).sessions.length === 1 && (await state()).activeId === 'home-one', 'adjacent home selected');
  assert.deepEqual((await state()).tabs, ['home-one', second.tabId]);
  await invoke('close', [second.id]);
  await until(async () => (await state()).sessions.length === 0, 'background terminal closed');
  assert.equal((await state()).activeId, 'home-one');
  assert.deepEqual((await state()).tabs, ['home-one']);
  result.checks.closeUsesWorkspaceOrder = true;

  phase = 'batched tab selection and multiple closes preserve the queued selection';
  await reset({ tabs: [first.tabId, second.tabId], activeId: second.id });
  await invoke('establish', [other]);
  await until(async () => (await state()).sessions.length === 3, 'third terminal added');
  const thirdId = (await state()).sessions.find(session => session.id !== first.id && session.id !== second.id).id;
  await invoke('setActiveId', [second.id]);
  await until(async () => (await state()).activeId === second.id, 'middle terminal selected');
  await evaluate(`window.connectionHarness.setActiveId(${JSON.stringify(first.id)}); void window.connectionHarness.close(${JSON.stringify(second.id)}); void window.connectionHarness.close(${JSON.stringify(thirdId)});`);
  await until(async () => (await state()).sessions.length === 1, 'batched terminal closes settled');
  assert.equal((await state()).activeId, first.id);
  assert.deepEqual((await state()).tabs, [first.tabId]);
  result.checks.batchedClosePreservesQueuedSelection = true;
  result.success = true;
}
run().catch(error => { result.success = false; result.phase = phase; result.error = error.stack || String(error); }).finally(async () => {
  await fs.writeFile(report, JSON.stringify(result, null, 2));
  app.exit(result.success && result.errors.length === 0 ? 0 : 1);
});
