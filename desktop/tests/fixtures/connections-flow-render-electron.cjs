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
const jump = { id: 'gateway-one', name: '公司网关', host: 'gateway.example.test', port: 22, username: 'gateway-user', auth: 'password', rememberHost: true, reuseConnection: true };
const identitySeeds = [
  { id: 'shared-target', name: '共享开发账号', username: 'shared-developer', version: 1, hasPassword: true, remember: 'persistent', references: [] },
  { id: 'shared-jump', name: '共享网关账号', username: 'shared-gateway', version: 1, hasPassword: true, remember: 'persistent', references: [] },
];
const backend = {
  connections: [profile, other], calls: [], plan: 'success', next: 0, pending: [], holdSave: false, pendingSave: null, sudoMissing: true,
  identities: structuredClone(identitySeeds), sharedPasswordUpdates: [],
};
let window, phase = 'startup';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = script => window.webContents.executeJavaScript(script);
const state = () => evaluate('window.connectionHarness.state');
function sessionSnapshot(session) {
  assert.ok(session, 'the expected live session must still exist');
  // A post-connect catalog refresh can add an own groupId: undefined to an
  // ungrouped profile after the session first appears. Compare that optional
  // metadata consistently without discarding any actual group/identity value.
  return { ...session, profile: { ...session.profile, groupId: session.profile.groupId } };
}
function assertSessionUnchanged(actual, expected) { assert.deepEqual(sessionSnapshot(actual), sessionSnapshot(expected)); }
async function until(predicate, label) {
  const end = Date.now() + 8_000;
  while (!(await predicate())) { if (Date.now() > end) throw new Error('Timed out: ' + label); await delay(20); }
}
async function invoke(method, args = [], wait = true) {
  const expression = `window.connectionHarness.${method}(...${JSON.stringify(args)})`;
  return evaluate(wait ? expression : `void ${expression}`);
}
async function choose(selector, value) {
  await until(() => evaluate(`document.querySelector(${JSON.stringify(selector)}) instanceof HTMLSelectElement && !document.querySelector(${JSON.stringify(selector)}).disabled`), 'select ready: ' + selector);
  await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await delay(30);
}
async function fill(selector, value) {
  await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); input.select(); })()`);
  await window.webContents.insertText(value); await delay(30);
}
async function checkbox(label) {
  await evaluate(`(() => { const label = [...document.querySelectorAll('.connection-auth-dialog label.checkbox-row')].find(item => item.textContent.trim() === ${JSON.stringify(label)}); if (!label) throw new Error('Authentication checkbox not found'); label.querySelector('input').click(); })()`); await delay(30);
}
const authReady = () => until(() => evaluate(`Boolean(document.querySelector('.connection-auth-dialog')) && !document.querySelector('.connection-auth-dialog button[type="submit"]').disabled`), 'identity authentication ready');
function resolveProfile(value) {
  const result = structuredClone(value), identity = backend.identities.find(identity => identity.id === result.loginIdentityId);
  if (identity) result.username = identity.username;
  const jumpIdentity = backend.identities.find(identity => identity.id === result.jumpHost?.loginIdentityId);
  if (jumpIdentity) result.jumpHost.username = jumpIdentity.username;
  return result;
}
async function reset({ offline = false, empty = false, tabs, activeId } = {}) {
  assert.equal(backend.pending.length, 0, 'previous attempts must settle before the next scenario');
  backend.connections = [structuredClone(profile), structuredClone(other)]; backend.calls = []; backend.plan = 'success'; backend.sudoMissing = true;
  backend.identities = structuredClone(identitySeeds); backend.sharedPasswordUpdates = [];
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
  // Guard the normalization itself: omission and undefined are equivalent,
  // while meaningful session, destination and authentication changes are not.
  assertSessionUnchanged({ ...first, profile: { ...profile, groupId: undefined } }, first);
  for (const change of [{ groupId: 'work' }, { username: 'changed-user' }, { host: 'changed.example.test' }, { auth: 'agent' }]) {
    assert.throws(() => assertSessionUnchanged({ ...first, profile: { ...profile, ...change } }, first), assert.AssertionError);
  }
  assert.throws(() => assertSessionUnchanged({ ...first, tabId: 'changed-tab' }, first), assert.AssertionError);
  result.checks.sessionComparisonPreservesMeaningfulChanges = true;
  await app.whenReady();
  ipcMain.handle('connections-flow:call', async (event, method, value) => {
    assert.equal(event.sender, window.webContents);
    backend.calls.push({ method, value });
    if (method === 'listLoginIdentities') return { identities: backend.identities, secureStorageAvailable: true };
    if (method === 'connections') { const connections = backend.connections.map(resolveProfile); return { connections, profiles: connections, groups: [], history: connections.map(profile => ({ profile, connectedAt: 100 })) }; }
    if (method === 'saveConnection') { backend.connections = backend.connections.map(profile => profile.id === value.profile.id ? value.profile : profile); return value.profile; }
    if (method === 'credentialStatus') {
      const status = { remember: 'session', hasPassword: false, hasPassphrase: false, hasSudoPassword: false, sudoUsesLogin: true, secureStorageAvailable: true };
      const identity = backend.identities.find(identity => identity.id === value.loginIdentityId);
      const jumpIdentity = backend.identities.find(identity => identity.id === value.jumpHost?.loginIdentityId);
      return { ...status, ...(identity ? { remember: identity.remember, hasPassword: identity.hasPassword } : {}), ...(value.jumpHost ? { jump: { ...status, remember: 'persistent', hasPassword: !!jumpIdentity?.hasPassword } } : {}) };
    }
    if (method === 'connect') {
      if (backend.plan === 'auth') throw new Error('AUTH_REQUIRED: 请填写登录密码');
      if (backend.plan === 'auth-failed') throw new Error('All configured authentication methods failed');
      if (backend.plan === 'jump-auth') throw new Error('JUMP_AUTH_FAILED: 跳板机身份验证失败');
      if (backend.plan === 'deferred') return new Promise(resolve => backend.pending.push({ request: value, resolve }));
      if (value.profile.loginIdentityId && value.credentials?.updateSharedIdentity && value.credentials.password) backend.sharedPasswordUpdates.push({ role: 'target', identityId: value.profile.loginIdentityId });
      if (value.profile.jumpHost?.loginIdentityId && value.credentials?.jump?.updateSharedIdentity && value.credentials.jump.password) backend.sharedPasswordUpdates.push({ role: 'jump', identityId: value.profile.jumpHost.loginIdentityId });
      return { id: 'connected-' + (++backend.next), profile: resolveProfile(value.profile) };
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

  phase = 'same-name duplicate opens independently and direct keeps the active match';
  await reset({ tabs: [first.tabId, second.tabId] });
  const originalSession = (await state()).sessions.find(session => session.id === first.id);
  await invoke('duplicate', [first.id]);
  await until(async () => (await state()).sessions.length === 3, 'same-name duplicate connected');
  const duplicateState = await state(), sameName = duplicateState.sessions.find(session => session.id === duplicateState.activeId);
  assert.ok(sameName); assert.notEqual(sameName.id, first.id); assert.notEqual(sameName.tabId, first.tabId);
  assert.equal(sameName.profile.name, first.profile.name);
  assertSessionUnchanged(duplicateState.sessions.find(session => session.id === first.id), originalSession);
  assert.deepEqual(duplicateState.tabs.slice(0, 2), [first.tabId, second.tabId]);
  assert.equal(backend.calls.filter(call => call.method === 'connect').length, 1);
  await invoke('direct', [profile]);
  assert.equal((await state()).activeId, sameName.id, 'direct click must not jump back to the first matching tab');
  assert.equal(backend.calls.filter(call => call.method === 'connect').length, 1);
  await invoke('setClosed', [{ [sameName.id]: '断开' }]);
  await until(async () => !!(await state()).closed[sameName.id], 'duplicate offline');
  await invoke('direct', [profile]);
  await until(async () => (await state()).activeId === first.id, 'direct prefers a live matching transport');
  assert.equal(backend.calls.filter(call => call.method === 'connect').length, 1);
  result.checks.sameNameDuplicatesPreserveActiveMatch = true;

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
  await until(() => evaluate(`!document.querySelector('.connection-auth-dialog button[type="submit"]').disabled`), 'authentication credentials loaded');
  assert.equal(await evaluate(`Boolean(document.getElementById('host-address'))`), false);
  assert.doesNotMatch(await evaluate(`document.querySelector('.connection-auth-dialog').innerText`), /AUTH_REQUIRED|Error invoking remote method|gooeshell:api|Error:/);
  assert.equal(await evaluate(`Boolean(document.querySelector('.connection-auth-dialog .form-error'))`), false, 'missing credentials should open a neutral prompt, not an authentication failure');
  assert.equal(await evaluate(`document.getElementById('connection-auth-remember').value`), 'session');
  assert.match(await evaluate(`document.getElementById('connection-auth-remember-note').textContent`), /退出.*重启.*重新输入/);
  window.showInactive(); await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); await delay(100);
  await fs.writeFile(report + '.initial-auth.png', (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); window.hide();
  const callsBeforeEmptySubmit = backend.calls.filter(call => call.method === 'connect').length;
  await evaluate(`document.querySelector('.connection-auth-dialog form').requestSubmit()`); await delay(40);
  assert.equal(backend.calls.filter(call => call.method === 'connect').length, callsBeforeEmptySubmit, 'empty required password must not start another connection attempt');
  assert.equal(await evaluate(`document.getElementById('connection-auth-secret').validity.valueMissing`), true);
  result.checks.emptyPasswordBlockedAndRememberScopeExplained = true;
  await evaluate(`document.getElementById('connection-auth-secret').focus()`); await window.webContents.insertText(secret.password); await delay(30);
  assert.equal(await evaluate(`Boolean(document.querySelector('.connection-auth-dialog .form-error'))`), false, 'typing a password must clear the initial missing-password error');
  backend.plan = 'success'; await evaluate(`document.querySelector('.connection-auth-dialog form').requestSubmit()`);
  await until(async () => (await state()).sessions.length === 1 && !(await state()).prompt, 'authentication connects');
  const authCall = backend.calls.filter(call => call.method === 'connect').at(-1);
  assert.equal(authCall.value.profile.id, profile.id); assert.equal(authCall.value.credentials.password, 'fixture-only'); assert.equal(authCall.value.credentials.remember, 'session');
  result.checks.authenticationUsesCompactPrompt = true; result.checks.missingPasswordPromptsWithoutTechnicalError = true;

  phase = 'failed password submission remains retryable and editing clears its old error';
  await reset({ empty: true }); backend.plan = 'auth'; await invoke('direct', [profile]);
  await until(() => evaluate(`Boolean(document.getElementById('connection-auth-secret')) && !document.querySelector('.connection-auth-dialog button[type="submit"]').disabled`), 'retry authentication prompt');
  await evaluate(`document.getElementById('connection-auth-secret').focus()`); await window.webContents.insertText('wrong-fixture-only'); await delay(30);
  backend.plan = 'auth-failed'; await evaluate(`document.querySelector('.connection-auth-dialog form').requestSubmit()`);
  await until(() => evaluate(`Boolean(document.querySelector('.connection-auth-dialog .form-error')?.textContent)`), 'server authentication failure rendered');
  assert.equal((await state()).sessions.length, 0); assert.equal((await state()).prompt.profile.id, profile.id);
  const errorText = await evaluate(`document.querySelector('.connection-auth-dialog .form-error').textContent`);
  assert.doesNotMatch(errorText, /Error invoking remote method|connections-flow:call|gooeshell:api|Error:|AUTH_FAILED/);
  assert.equal(backend.calls.filter(call => call.method === 'connect').at(-1).value.credentials.password, 'wrong-fixture-only');
  await evaluate(`(() => { const input = document.getElementById('connection-auth-secret'); input.focus(); input.select(); })()`);
  await window.webContents.insertText(secret.password); await delay(30);
  assert.equal(await evaluate(`Boolean(document.querySelector('.connection-auth-dialog .form-error'))`), false, 'editing failed credentials must remove their stale error');
  backend.plan = 'success'; await evaluate(`document.querySelector('.connection-auth-dialog form').requestSubmit()`);
  await until(async () => (await state()).sessions.length === 1 && !(await state()).prompt, 'corrected password connects');
  assert.equal(backend.calls.filter(call => call.method === 'connect').at(-1).value.credentials.password, secret.password);
  result.checks.authenticationErrorClearsOnEditAndRetry = true;

  for (const keepDefault of [false, true]) {
    phase = keepDefault ? 'saving selected login identities as connection defaults' : 'temporary shared login identities do not rewrite saved connection defaults';
    await reset({ empty: true, tabs: ['identity-home'], activeId: 'identity-home' });
    backend.connections[0] = { ...profile, jumpHost: structuredClone(jump) }; await invoke('refresh');
    await until(async () => (await state()).catalog[0].jumpHost?.id === jump.id, 'routed catalog ready');
    backend.plan = 'auth'; await invoke('direct', [backend.connections[0], false, 'identity-home']); await authReady();
    await choose('#auth-login-identity', 'shared-target'); await authReady();
    await fill('#connection-auth-secret', 'target-temporary-fixture-password');
    await choose('#auth-jump-identity', 'shared-jump'); await authReady();
    await fill('#connection-auth-jump-secret', 'jump-temporary-fixture-password');
    assert.equal(await evaluate(`[...document.querySelectorAll('.connection-auth-dialog label.checkbox-row input')].some(input => input.checked)`), false);
    if (keepDefault) await checkbox('设为此连接的默认登录身份');
    backend.plan = 'success'; await evaluate(`document.querySelector('.connection-auth-dialog form').requestSubmit()`);
    await until(async () => (await state()).sessions.length === 1 && !(await state()).prompt, 'selected identities connected');
    const call = backend.calls.filter(call => call.method === 'connect').at(-1), saved = backend.calls.filter(call => call.method === 'saveConnection');
    assert.equal(call.value.profile.loginIdentityId, 'shared-target'); assert.equal(call.value.profile.username, 'shared-developer');
    assert.equal(call.value.profile.jumpHost.loginIdentityId, 'shared-jump'); assert.equal(call.value.profile.jumpHost.username, 'shared-gateway');
    assert.equal(call.value.credentials.password, 'target-temporary-fixture-password'); assert.equal(call.value.credentials.jump.password, 'jump-temporary-fixture-password');
    assert.equal(call.value.credentials.updateSharedIdentity, undefined); assert.equal(call.value.credentials.jump.updateSharedIdentity, undefined);
    assert.deepEqual(backend.sharedPasswordUpdates, []); assert.equal((await state()).sessions[0].tabId, 'identity-home');
    if (keepDefault) {
      assert.equal(saved.length, 1); assert.equal(saved[0].value.credentials, undefined); assert.equal(saved[0].value.favorite, true);
      assert.equal(call.value.profile.id, profile.id); assert.equal(backend.connections[0].loginIdentityId, 'shared-target'); assert.equal(backend.connections[0].jumpHost.loginIdentityId, 'shared-jump');
      result.checks.selectedIdentityCanBecomeConnectionDefault = true;
    } else {
      assert.equal(saved.length, 0); assert.notEqual(call.value.profile.id, profile.id); assert.notEqual(call.value.profile.jumpHost.id, jump.id);
      assert.equal(backend.connections[0].loginIdentityId, undefined); assert.equal(backend.connections[0].jumpHost.loginIdentityId, undefined); assert.equal(backend.connections[0].username, profile.username);
      result.checks.temporaryIdentityLeavesSavedDefaultsAndPasswords = true;
    }
  }

  phase = 'shared password updates require explicit per-role checkboxes';
  await reset({ empty: true }); backend.connections[0] = { ...profile, jumpHost: structuredClone(jump) }; await invoke('refresh');
  await until(async () => (await state()).catalog[0].jumpHost?.id === jump.id, 'routed update catalog ready');
  backend.plan = 'auth'; await invoke('direct', [backend.connections[0]]); await authReady();
  await choose('#auth-login-identity', 'shared-target'); await authReady(); await fill('#connection-auth-secret', 'explicit-target-fixture-password');
  await choose('#auth-jump-identity', 'shared-jump'); await authReady(); await fill('#connection-auth-jump-secret', 'explicit-jump-fixture-password');
  await checkbox('连接成功后更新此身份的共享密码'); await checkbox('连接成功后更新跳板机身份的共享密码');
  backend.plan = 'success'; await evaluate(`document.querySelector('.connection-auth-dialog form').requestSubmit()`);
  await until(async () => (await state()).sessions.length === 1 && !(await state()).prompt, 'explicit identity password update completes');
  const explicitUpdateCall = backend.calls.filter(call => call.method === 'connect').at(-1);
  assert.equal(explicitUpdateCall.value.credentials.updateSharedIdentity, true); assert.equal(explicitUpdateCall.value.credentials.jump.updateSharedIdentity, true);
  assert.deepEqual(backend.sharedPasswordUpdates, [{ role: 'target', identityId: 'shared-target' }, { role: 'jump', identityId: 'shared-jump' }]);
  assert.equal(backend.calls.some(call => call.method === 'saveConnection'), false, 'password update and default selection are independent choices');
  result.checks.sharedPasswordUpdateRequiresExplicitSelection = true;

  phase = 'identity username updates affect reconnects while other live sessions keep original users';
  await reset({ empty: true, tabs: ['identity-live-one', 'identity-live-two'], activeId: 'identity-live-one' });
  backend.connections[0] = { ...profile, loginIdentityId: 'shared-target', username: 'shared-developer' }; await invoke('refresh');
  await until(async () => (await state()).catalog[0].loginIdentityId === 'shared-target', 'shared binding catalog ready');
  await invoke('direct', [backend.connections[0], false, 'identity-live-one']); await until(async () => (await state()).sessions.length === 1, 'first shared session');
  const oldLive = (await state()).sessions[0];
  await invoke('direct', [backend.connections[0], true, 'identity-live-two']); await until(async () => (await state()).sessions.length === 2, 'second shared session');
  const untouchedLive = (await state()).sessions.find(session => session.id !== oldLive.id);
  backend.identities[0] = { ...backend.identities[0], username: 'renamed-developer', version: 2 }; await invoke('refresh');
  await until(async () => (await state()).catalog[0].username === 'renamed-developer', 'new identity username in catalog');
  assert.equal((await state()).sessions.find(session => session.id === oldLive.id).profile.username, 'shared-developer');
  assert.equal((await state()).sessions.find(session => session.id === untouchedLive.id).profile.username, 'shared-developer');
  await invoke('setClosed', [{ [oldLive.id]: '断开' }]); await until(async () => !!(await state()).closed[oldLive.id], 'first identity session offline');
  await invoke('reconnect', [oldLive.id]);
  const identityReconnectCall = backend.calls.filter(call => call.method === 'connect').at(-1);
  assert.equal(identityReconnectCall.value.profile.id, profile.id); assert.equal(identityReconnectCall.value.profile.loginIdentityId, 'shared-target'); assert.equal(identityReconnectCall.value.profile.username, 'renamed-developer');
  await until(async () => !(await state()).sessions.some(session => session.id === oldLive.id), 'reconnected identity replaces old transport');
  assert.equal((await state()).sessions.find(session => session.tabId === 'identity-live-one').profile.username, 'renamed-developer');
  assertSessionUnchanged((await state()).sessions.find(session => session.id === untouchedLive.id), untouchedLive);
  result.checks.identityUpdateChangesReconnectWithoutRetargetingLiveSession = true;

  phase = 'jump authentication collects independent target and gateway credentials';
  await reset({ empty: true, tabs: ['jump-home'], activeId: 'jump-home' }); backend.plan = 'jump-auth';
  const routed = { ...profile, id: 'routed-target', jumpHost: jump };
  await invoke('direct', [routed, false, 'jump-home']);
  await until(() => evaluate(`Boolean(document.getElementById('connection-auth-jump-secret')) && !document.querySelector('button[type="submit"]').disabled`), 'both hop credentials rendered');
  assert.equal(await evaluate(`document.querySelectorAll('.connection-auth-section input[type="password"]').length`), 2);
  assert.equal(await evaluate(`document.getElementById('connection-auth-jump-remember').value`), 'persistent');
  assert.match((await state()).authError, /跳板机身份验证失败/);
  window.setSize(1000, 600); await delay(50);
  assert.equal(await evaluate(`(() => { const modal = document.querySelector('.connection-auth-dialog'), body = modal.querySelector('.modal-body'); return body.scrollHeight > body.clientHeight && modal.querySelector('.modal-footer').getBoundingClientRect().bottom <= modal.getBoundingClientRect().bottom; })()`), true, 'both-hop prompt scrolls while its action buttons remain visible');
  for (const [selector, value] of [['#connection-auth-secret', 'target-render-secret'], ['#connection-auth-jump-secret', 'jump-render-secret']]) {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`); await window.webContents.insertText(value); await delay(25);
  }
  backend.plan = 'success';
  await evaluate(`document.querySelector('.connection-auth-dialog form').requestSubmit()`);
  await until(async () => (await state()).sessions.length === 1 && !(await state()).prompt, 'both hop credentials connect');
  const routedCall = backend.calls.filter(call => call.method === 'connect').at(-1);
  assert.equal(routedCall.value.credentials.password, 'target-render-secret');
  assert.equal(routedCall.value.credentials.jump.password, 'jump-render-secret');
  assert.equal(routedCall.value.credentials.remember, 'session');
  assert.equal(routedCall.value.credentials.jump.remember, 'persistent');
  assert.equal((await state()).sessions[0].tabId, 'jump-home');
  window.setSize(1000, 800); await delay(30);
  result.checks.jumpPromptSeparatesCredentials = true;

  phase = 'an agent target can prompt and reconnect with a password jump host';
  await reset({ empty: true }); backend.plan = 'jump-auth';
  const agentRouted = { ...routed, id: 'agent-routed', auth: 'agent' };
  await invoke('direct', [agentRouted]);
  await until(() => evaluate(`Boolean(document.getElementById('connection-auth-jump-secret'))`), 'agent target gateway prompt');
  assert.equal(await evaluate(`Boolean(document.getElementById('connection-auth-secret'))`), false);
  backend.plan = 'success'; await invoke('submitAuth', [{ remember: 'session', sudoUsesLogin: true, jump: { remember: 'session', password: 'agent-gateway-secret' } }]);
  await until(async () => (await state()).sessions.length === 1 && !(await state()).prompt, 'agent target connected');
  const routedSession = (await state()).sessions[0];
  await invoke('setClosed', [{ [routedSession.id]: '断开' }]);
  await until(async () => !!(await state()).closed[routedSession.id], 'routed target offline');
  backend.plan = 'jump-auth'; await invoke('reconnect', [routedSession.id]);
  await until(async () => (await state()).prompt?.tabId === routedSession.tabId, 'routed reconnect prompt');
  assert.equal(await evaluate(`Boolean(document.getElementById('connection-auth-secret'))`), false);
  backend.plan = 'success'; await invoke('submitAuth', [{ remember: 'session', sudoUsesLogin: true, jump: { remember: 'session', password: 'reconnect-gateway-secret' } }]);
  await until(async () => !(await state()).prompt && (await state()).sessions[0].id !== routedSession.id, 'routed reconnect completed');
  assert.equal((await state()).sessions[0].tabId, routedSession.tabId);
  assert.equal(backend.calls.filter(call => call.method === 'connect').at(-1).value.credentials.jump.password, 'reconnect-gateway-secret');
  result.checks.agentTargetSupportsJumpAuthAndReconnect = true;

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

  phase = 'duplicating an old tab preserves its endpoint without replacing saved credentials';
  backend.calls = [];
  await invoke('duplicate', [first.id]);
  const duplicateCall = backend.calls.find(call => call.method === 'connect');
  assert.ok(duplicateCall); assert.equal(duplicateCall.value.profile.host, profile.host);
  assert.notEqual(duplicateCall.value.profile.id, profile.id);
  assert.equal(duplicateCall.value.credentials, undefined);
  await until(async () => (await state()).sessions.length === 3, 'old endpoint duplicate added');
  const oldDuplicate = (await state()).sessions.find(session => session.profile.id === duplicateCall.value.profile.id);
  assert.ok(oldDuplicate); assert.notEqual(oldDuplicate.tabId, first.tabId);
  assert.equal((await state()).sessions.find(session => session.id === first.id).profile.host, profile.host);
  assert.equal((await state()).catalog.find(value => value.id === profile.id).host, 'replacement.example.test');
  await invoke('close', [oldDuplicate.id]); await invoke('setActiveId', [first.id]);
  await until(async () => (await state()).sessions.length === 2 && (await state()).activeId === first.id, 'old endpoint duplicate closed independently');
  result.checks.oldTargetDuplicateUsesSeparateProfile = true;

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
