const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const url = process.env.GOOESHELL_CONNECTION_UI_URL;
const report = process.env.GOOESHELL_CONNECTION_UI_REPORT;
if (!url || new URL(url).hostname !== '127.0.0.1' || !report || !process.env.GOOESHELL_CONNECTION_UI_DATA) throw new Error('An isolated loopback fixture and data directory are required');
app.setPath('userData', process.env.GOOESHELL_CONNECTION_UI_DATA);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const result = { checks: {}, errors: [] };
let window, forgotten = false, jumpForgotten = false, phase = 'startup';
const jumpPreset = { id: 'jump-existing', name: '公司网关', host: 'gateway.example.test', port: 2222, username: 'gateway-user', auth: 'password', rememberHost: true, reuseConnection: true };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = script => window.webContents.executeJavaScript(script);
async function until(predicate, label) {
  const end = Date.now() + 8_000;
  while (!(await predicate())) { if (Date.now() > end) throw new Error('Timed out: ' + label); await delay(20); }
}
async function click(label) {
  const selector = `(() => [...document.querySelectorAll('button')].find(button => !button.disabled && (button.getAttribute('aria-label') === ${JSON.stringify(label)} || button.textContent.trim() === ${JSON.stringify(label)})))()`;
  await until(() => evaluate(`Boolean(${selector})`), label);
  await evaluate(`${selector}.click()`);
  await delay(30);
}
async function fill(selector, value) {
  // Selection setup is not under test; native select-all depends on the macOS
  // application edit menu, which this isolated hidden fixture does not install.
  await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); input.select(); })()`);
  await until(() => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); return input.selectionStart === 0 && input.selectionEnd === input.value.length; })()`), 'input selection');
  await window.webContents.insertText(value);
  await delay(30);
}
async function choose(selector, value) {
  await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await delay(30);
}
const ready = () => until(() => evaluate(`!!document.querySelector('#credential-remember') && !document.querySelector('#credential-remember').disabled`), 'credentials loaded');
async function picture(label) {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  window.webContents.invalidate();
  const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  await fs.writeFile(report + '.' + label + '.png', image.toPNG());
}
async function run() {
  await app.whenReady();
  ipcMain.handle('connection-ui:catalog', event => { assert.equal(event.sender, window.webContents); return { connections: [{ jumpHost: jumpPreset }, { jumpHost: { ...jumpPreset } }], profiles: [], groups: [], history: [] }; });
  ipcMain.handle('connection-ui:status', async (event, profile) => {
    assert.equal(event.sender, window.webContents);
    await delay(40);
    const existing = profile.id === 'one' && profile.host === 'dev.example.test' && profile.username === 'developer' && profile.auth === 'password' && !forgotten;
    const jumpExisting = profile.jumpHost?.id === jumpPreset.id && profile.jumpHost?.host === jumpPreset.host && !jumpForgotten;
    const jump = profile.jumpHost ? { remember: jumpExisting ? 'persistent' : 'never', hasPassword: jumpExisting, hasPassphrase: false, hasSudoPassword: false, sudoUsesLogin: false, secureStorageAvailable: true } : undefined;
    return { remember: existing ? 'persistent' : 'never', hasPassword: existing, hasPassphrase: false, hasSudoPassword: existing, sudoUsesLogin: true, secureStorageAvailable: true, jump };
  });
  ipcMain.handle('connection-ui:forget', (event, id) => { assert.equal(event.sender, window.webContents); assert.equal(id, 'one'); forgotten = true; });
  ipcMain.handle('connection-ui:forget-jump', (event, jump) => { assert.equal(event.sender, window.webContents); assert.equal(jump.id, jumpPreset.id); jumpForgotten = true; });
  window = new BrowserWindow({ show: false, width: 1150, height: 900, webPreferences: { preload: path.join(__dirname, 'connection-ui-render-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) result.errors.push(message); });
  window.webContents.on('render-process-gone', (_event, detail) => result.errors.push(JSON.stringify(detail)));
  await window.loadURL(url);
  await until(() => evaluate('Boolean(window.connectionFixture)'), 'fixture mount');
  phase = 'sidebar identity and collapsed groups';
  assert.equal(await evaluate(`document.querySelector('.host.active .host-name').textContent`), '开发服务器');
  assert.equal(await evaluate(`document.querySelectorAll('.host-icon').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('.connection-group-toggle svg').length`), 2);
  await picture('dark-expanded-sidebar');
  await evaluate(`document.querySelector('.host.active').click()`);
  assert.equal(await evaluate(`window.connectionFixture.actions.at(-1).type`), 'activate');
  await evaluate(`document.querySelector('.connection-group-toggle').click()`);
  await delay(25);
  assert.equal(await evaluate(`document.getElementById('connection-group-development').hidden`), true);
  await click('折叠侧边栏');
  assert.equal(await evaluate(`document.getElementById('connection-group-development').hidden`), false);
  assert.equal(await evaluate(`document.querySelector('.host-copy').getBoundingClientRect().width`), 0);
  assert.equal(await evaluate(`document.querySelector('.hosts').scrollWidth <= document.querySelector('.hosts').clientWidth`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.host-icon').length`), 2);
  await evaluate(`document.querySelector('.host.active').click()`);
  assert.equal(await evaluate(`window.connectionFixture.actions.at(-1).type`), 'activate');
  assert.equal(await evaluate(`window.connectionFixture.actions.at(-1).value`), 'one');
  await picture('dark-collapsed-sidebar');
  await click('展开侧边栏');
  assert.equal(await evaluate(`document.getElementById('connection-group-development').hidden`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.host-icon').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('.connection-group-toggle svg').length`), 2);
  await click('开发环境分组菜单');
  await click('名称与图标…');
  assert.equal(await evaluate(`window.connectionFixture.actions.at(-1).type`), 'editGroup');
  result.checks.groupCollapseAndPhysicalSession = true;

  phase = 'save settings without connection';
  await click('Edit fixture'); await ready();
  assert.equal(await evaluate(`document.getElementById('credential-remember').value`), 'persistent');
  assert.equal(await evaluate(`document.getElementById('host-password').value`), '');
  assert.match(await evaluate(`document.getElementById('host-password').placeholder`), /留空保留/);
  await fill('#host-name', '重新命名');
  await picture('dark-dialog');
  await click('保存');
  await until(() => evaluate(`!document.querySelector('[role="dialog"]')`), 'save closes dialog');
  const saved = await evaluate(`window.connectionFixture.actions.filter(action => action.type === 'save').at(-1).value`);
  assert.equal(saved.profile.id, 'one'); assert.equal(saved.profile.name, '重新命名'); assert.equal(saved.credentials.remember, 'persistent');
  assert.equal('password' in saved.credentials, false);
  assert.equal(await evaluate(`window.connectionFixture.actions.some(action => action.type === 'connect')`), false);
  result.checks.saveWithoutConnectingAndBlankSecretPreservation = true;

  phase = 'user preferences survive status refresh and changed identity';
  await click('Edit fixture'); await ready();
  await choose('#credential-remember', 'session');
  await evaluate(`document.querySelector('input[type="checkbox"]').click()`);
  await fill('#host-address', 'other.example.test');
  await ready();
  assert.equal(await evaluate(`document.getElementById('credential-remember').value`), 'session');
  assert.equal(await evaluate(`Boolean(document.getElementById('sudo-password'))`), true);
  assert.equal(await evaluate(`document.getElementById('host-password').placeholder`), '输入登录密码');
  assert.match(await evaluate(`document.body.innerText`), /原连接的密码不会自动用于新目标/);
  result.checks.statusRefreshPreservesUserChoice = true;
  await click('关闭连接设置');

  phase = 'new connection saves a chosen icon and credentials';
  await click('New fixture'); await ready();
  assert.equal(await evaluate(`document.getElementById('credential-remember').value`), 'session');
  await fill('#host-address', 'new.example.test'); await ready();
  await fill('#host-password', 'fixture-only-password');
  await choose('#credential-remember', 'persistent');
  await choose('#host-group', 'development');
  await click('云服务器');
  await evaluate(`window.connectionFixture.setTheme('light')`);
  await delay(60); await picture('light-dialog');
  await click('连接服务器');
  const connected = await evaluate(`window.connectionFixture.actions.filter(action => action.type === 'connect').at(-1).value`);
  assert.equal(connected.profile.icon, 'cloud'); assert.equal(connected.profile.groupId, 'development');
  assert.equal(connected.favorite, false); assert.equal(connected.credentials.password, 'fixture-only-password'); assert.equal(connected.credentials.remember, 'persistent');
  result.checks.newConnectionOptions = true;

  phase = 'advanced jump options reuse a snapshot and separate both passwords';
  await click('New fixture'); await ready();
  assert.equal(await evaluate(`document.querySelector('.connection-advanced-toggle').getAttribute('aria-expanded')`), 'false');
  assert.equal(await evaluate(`Boolean(document.getElementById('jump-enabled'))`), false);
  await fill('#host-address', 'internal.example.test'); await ready();
  await fill('#host-password', 'target-fixture-password');
  await evaluate(`document.querySelector('.connection-advanced-toggle').click()`); await delay(25);
  await evaluate(`document.getElementById('jump-enabled').click()`); await ready();
  assert.equal(await evaluate(`document.querySelectorAll('#jump-preset option').length`), 2, 'duplicate jump presets are consolidated');
  await choose('#jump-preset', jumpPreset.id); await ready();
  assert.equal(await evaluate(`document.getElementById('jump-address').value`), jumpPreset.host);
  assert.equal(await evaluate(`document.getElementById('jump-remember').value`), 'persistent');
  assert.equal(await evaluate(`document.getElementById('credential-remember').value`), 'session');
  assert.equal(await evaluate(`document.getElementById('jump-password').value`), '');
  assert.match(await evaluate(`document.getElementById('jump-password').placeholder`), /留空保留/);
  await choose('#jump-remember', 'session');
  await fill('#jump-name', '这台目标使用的网关');
  await fill('#jump-password', 'jump-fixture-password');
  await evaluate(`document.getElementById('jump-reuse').click()`);
  await evaluate(`document.getElementById('jump-address').scrollIntoView({block:'start'})`);
  await picture('light-jump-options');
  await click('保存到侧边栏');
  const jumpSaved = await evaluate(`window.connectionFixture.actions.filter(action => action.type === 'save').at(-1).value`);
  assert.equal(jumpSaved.profile.jumpHost.id, jumpPreset.id);
  assert.equal(jumpSaved.profile.jumpHost.reuseConnection, false);
  assert.equal(jumpSaved.credentials.password, 'target-fixture-password');
  assert.equal(jumpSaved.credentials.jump.password, 'jump-fixture-password');
  assert.equal(jumpSaved.credentials.jump.remember, 'session');
  assert.equal('password' in jumpSaved.profile.jumpHost, false);
  assert.equal('password' in jumpSaved.profile, false);
  assert.equal(jumpPreset.name, '公司网关');
  result.checks.jumpPresetAndSeparateSecrets = true;

  phase = 'editing a jump identity detaches credentials and disabling returns to direct SSH';
  await click('New fixture'); await ready();
  await fill('#host-address', 'next.internal.test'); await ready();
  await evaluate(`document.querySelector('.connection-advanced-toggle').click()`); await delay(25);
  await evaluate(`document.getElementById('jump-enabled').click()`); await ready();
  await choose('#jump-preset', jumpPreset.id); await ready();
  await fill('#jump-address', 'replacement.gateway.test'); await ready();
  assert.equal(await evaluate(`document.getElementById('jump-password').placeholder`), '输入跳板机密码');
  await fill('#jump-password', 'replacement-fixture-secret');
  await click('保存到侧边栏');
  const replacement = await evaluate(`window.connectionFixture.actions.filter(action => action.type === 'save').at(-1).value`);
  assert.notEqual(replacement.profile.jumpHost.id, jumpPreset.id);
  assert.equal(replacement.profile.jumpHost.host, 'replacement.gateway.test');
  assert.equal(replacement.credentials.jump.password, 'replacement-fixture-secret');
  await click('New fixture'); await ready();
  await fill('#host-address', 'direct.example.test'); await ready();
  await evaluate(`document.querySelector('.connection-advanced-toggle').click()`); await delay(25);
  await evaluate(`document.getElementById('jump-enabled').click()`); await ready();
  await choose('#jump-preset', jumpPreset.id); await ready();
  await click('清除跳板机密码');
  await until(() => evaluate(`document.getElementById('jump-password').placeholder === '输入跳板机密码'`), 'shared jump secret cleared');
  assert.equal(jumpForgotten, true); assert.equal(forgotten, false);
  await evaluate(`document.getElementById('jump-enabled').click()`); await ready();
  await click('保存到侧边栏');
  const direct = await evaluate(`window.connectionFixture.actions.filter(action => action.type === 'save').at(-1).value`);
  assert.equal(direct.profile.jumpHost, undefined); assert.equal(direct.credentials.jump, undefined);
  result.checks.jumpIdentityIsolationAndDisable = true;

  phase = 'cancel a pending connection';
  await click('Edit fixture'); await ready();
  await evaluate('window.connectionFixture.holdNextConnect = true');
  await click('保存并连接');
  assert.equal(await evaluate(`document.querySelector('fieldset').disabled`), true);
  await click('取消连接');
  await until(() => evaluate(`!document.querySelector('fieldset').disabled`), 'cancel releases form');
  assert.equal(await evaluate(`window.connectionFixture.actions.at(-1).type`), 'cancel');
  result.checks.cancelPendingConnection = true;
  await click('关闭连接设置');

  phase = 'forget stored secrets';
  await click('Edit fixture'); await ready();
  await click('清除已记住的密码');
  await until(() => evaluate(`document.body.innerText.includes('已清除记住的密码与口令')`), 'forget state');
  assert.equal(await evaluate(`document.getElementById('host-password').placeholder`), '输入登录密码');
  result.checks.forgetCredentials = true;
  result.success = true;
}
run().catch(error => { result.success = false; result.phase = phase; result.error = error.stack || String(error); }).finally(async () => {
  await fs.writeFile(report, JSON.stringify(result, null, 2));
  app.exit(result.success && result.errors.length === 0 ? 0 : 1);
});
