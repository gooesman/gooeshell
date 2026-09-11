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
let window, forgotten = false, phase = 'startup';
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
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
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
  ipcMain.handle('connection-ui:status', async (event, profile) => {
    assert.equal(event.sender, window.webContents);
    await delay(40);
    const existing = profile.id === 'one' && profile.host === 'dev.example.test' && profile.username === 'developer' && profile.auth === 'password' && !forgotten;
    return { remember: existing ? 'persistent' : 'never', hasPassword: existing, hasPassphrase: false, hasSudoPassword: existing, sudoUsesLogin: true, secureStorageAvailable: true };
  });
  ipcMain.handle('connection-ui:forget', (event, id) => { assert.equal(event.sender, window.webContents); assert.equal(id, 'one'); forgotten = true; });
  window = new BrowserWindow({ show: false, width: 1150, height: 900, webPreferences: { preload: path.join(__dirname, 'connection-ui-render-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) result.errors.push(message); });
  window.webContents.on('render-process-gone', (_event, detail) => result.errors.push(JSON.stringify(detail)));
  await window.loadURL(url);
  await until(() => evaluate('Boolean(window.connectionFixture)'), 'fixture mount');
  phase = 'sidebar identity and collapsed groups';
  assert.equal(await evaluate(`document.querySelector('.host.active .host-name').textContent`), '开发服务器');
  await evaluate(`document.querySelector('.host.active').click()`);
  assert.equal(await evaluate(`window.connectionFixture.actions.at(-1).type`), 'activate');
  await evaluate(`document.querySelector('.connection-group-toggle').click()`);
  await delay(25);
  assert.equal(await evaluate(`document.getElementById('connection-group-development').hidden`), true);
  await click('折叠侧边栏');
  assert.equal(await evaluate(`document.getElementById('connection-group-development').hidden`), false);
  assert.equal(await evaluate(`document.querySelector('.host-copy').getBoundingClientRect().width`), 0);
  assert.equal(await evaluate(`document.querySelector('.hosts').scrollWidth <= document.querySelector('.hosts').clientWidth`), true);
  await click('展开侧边栏');
  assert.equal(await evaluate(`document.getElementById('connection-group-development').hidden`), true);
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
