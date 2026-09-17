const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const url = process.env.GOOESHELL_SETTINGS_IDENTITIES_URL, report = process.env.GOOESHELL_SETTINGS_IDENTITIES_REPORT;
if (!url || new URL(url).hostname !== '127.0.0.1' || !report || !process.env.GOOESHELL_SETTINGS_IDENTITIES_DATA) throw new Error('Isolated loopback fixture and data directory required');
app.setPath('userData', process.env.GOOESHELL_SETTINGS_IDENTITIES_DATA);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const result = { checks: {}, errors: [] }; let window, phase = 'startup';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = script => window.webContents.executeJavaScript(script);
async function until(predicate, label) { const end = Date.now() + 8000; while (!(await predicate())) { if (Date.now() > end) throw new Error('Timed out: ' + label); await delay(25); } }
async function click(label) {
  const expression = `(() => [...document.querySelectorAll('button')].find(button => !button.disabled && button.getClientRects().length > 0 && (button.getAttribute('aria-label') === ${JSON.stringify(label)} || button.textContent.trim() === ${JSON.stringify(label)})))()`;
  await until(() => evaluate(`Boolean(${expression})`), label); await evaluate(`${expression}.click()`); await delay(50);
}
async function fill(selector, text) { await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); input.select(); })()`); await window.webContents.insertText(text); await delay(35); }
async function choose(selector, value) { await evaluate(`(() => { const select = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(value)}); select.dispatchEvent(new Event('change', { bubbles: true })); })()`); await delay(35); }
async function keyboard(keyCode, modifiers = []) { window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await delay(35); }
async function picture(label) { await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); window.webContents.invalidate(); await window.webContents.capturePage(); await fs.writeFile(report + '.' + label + '.png', (await window.webContents.capturePage()).toPNG()); }
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 1100, height: 860, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', (...args) => { const details = args[0], message = typeof args[2] === 'string' ? args[2] : details.message, level = typeof args[1] === 'number' ? args[1] : details.level; if (level >= 3 || level === 'error') result.errors.push(message); });
  await window.loadURL(url); window.show(); window.focus(); window.webContents.focus();
  await until(() => evaluate('Boolean(document.querySelector(".settings-dialog"))'), 'settings ready');
  phase = 'navigation';
  const tabs = await evaluate('[...document.querySelectorAll(".settings-tabs button")].map(button => button.textContent)');
  assert.deepEqual(tabs, ['通用', '字体与外观', '终端配色', '键盘与鼠标', '登录身份', '关于']); result.checks.simplifiedNavigation = true;
  const bounds = await evaluate('(() => { const {x,y,width,height}=document.querySelector(".settings-dialog").getBoundingClientRect();return{x,y,width,height};})()');
  for (const label of tabs) { await click(label); assert.deepEqual(await evaluate('(() => { const {x,y,width,height}=document.querySelector(".settings-dialog").getBoundingClientRect();return{x,y,width,height};})()'), bounds); }
  result.checks.fixedDialogDimensions = true;
  await click('字体与外观'); assert.equal(await evaluate('Boolean(document.querySelector("[aria-label=光标闪烁]"))'), true); assert.equal(await evaluate('Boolean(document.querySelector("[aria-label=右键粘贴]"))'), false);
  await click('键盘与鼠标'); assert.equal(await evaluate('Boolean(document.querySelector("[aria-label=光标闪烁]"))'), false);
  const oldPaste = await evaluate('document.querySelector("[aria-label=右键粘贴]").getAttribute("aria-checked")'); await click('右键粘贴');
  await click('关于'); await click('键盘与鼠标'); assert.notEqual(await evaluate('document.querySelector("[aria-label=右键粘贴]").getAttribute("aria-checked")'), oldPaste); result.checks.inputOptionsStayInKeyboard = true;
  phase = 'shortcuts';
  await click('录入查找终端内容快捷方式'); await keyboard('P', ['control', 'shift']); assert.match(await evaluate('document.querySelector(".form-error").textContent'), /已用于/);
  await keyboard('F8'); assert.equal(await evaluate('document.querySelector("[aria-label=录入查找终端内容快捷方式]").textContent'), 'F8'); result.checks.shortcutConflictAndSingleKey = true;
  await click('选择粘贴的鼠标按钮'); await choose('[aria-label="粘贴鼠标按钮"]', 'MouseMiddle');
  await evaluate('[...document.querySelectorAll(".mouse-binding-modifiers input:checked")].forEach(input => input.click())'); await delay(35);
  await click('应用'); await picture('keyboard');
  await click('保存设置'); assert.equal(await evaluate('window.settingsIdentityFixture.savedSettings.shortcuts.paste'), 'MouseMiddle'); assert.equal(await evaluate('window.settingsIdentityFixture.savedSettings.shortcuts.search'), 'F8'); assert.equal(await evaluate('String(window.settingsIdentityFixture.savedSettings.rightClickPaste)'), oldPaste === 'true' ? 'false' : 'true'); result.checks.mouseMappingPersists = true;
  phase = 'identity references and edit';
  await click('通用');
  const beforeIdentity = await evaluate('document.querySelector("[aria-label=主页显示最近连接]").getAttribute("aria-checked")'); await click('主页显示最近连接');
  await click('登录身份');
  assert.equal(await evaluate('[...document.querySelectorAll(".modal-footer button")].some(button => button.textContent.trim() === "保存设置")'), false);
  assert.equal(await evaluate('[...document.querySelectorAll(".modal-footer button")].some(button => button.textContent.trim() === "关闭")'), true);
  await click('通用'); assert.notEqual(await evaluate('document.querySelector("[aria-label=主页显示最近连接]").getAttribute("aria-checked")'), beforeIdentity);
  result.checks.identityFooterPreservesOtherDrafts = true;
  await click('登录身份'); await until(() => evaluate('Boolean(document.querySelector(".identity-list-item"))'), 'identity list'); await evaluate('document.querySelector(".identity-list-item").click()'); await delay(35);
  assert.equal(await evaluate('document.querySelector("#login-identity-password").value'), ''); assert.match(await evaluate('document.querySelector("#login-identity-password").placeholder'), /留空保留/); result.checks.passwordNeverReturned = true;
  assert.match(await evaluate('document.querySelector(".identity-references").textContent'), /开发服务器/); assert.equal(await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "删除身份").disabled'), true); result.checks.referencesPreventDeletion = true;
  assert.equal(await evaluate('(() => { const content=document.querySelector(".settings-content").getBoundingClientRect(), actions=document.querySelector(".identity-form-actions").getBoundingClientRect();return actions.top >= content.top && actions.bottom <= content.bottom + 1;})()'), true);
  result.checks.identityActionsStayVisible = true;
  await fill('#login-identity-name', '共享开发账号'); await picture('identity-edit'); await click('保存身份'); await until(() => evaluate('window.settingsIdentityFixture.updates.length === 1'), 'identity saved');
  const update = await evaluate('window.settingsIdentityFixture.updates[0]'); assert.equal(update.expectedVersion, 3); assert.equal(update.password, undefined); assert.equal(update.name, '共享开发账号'); assert.equal(await evaluate('window.settingsIdentityFixture.changes'), 1); result.checks.editKeepsPasswordAndVersion = true;
  phase = 'new identity';
  await click('新建身份'); await fill('#login-identity-name', '测试账号'); await fill('#login-identity-username', 'tester'); await click('保存身份'); assert.equal(await evaluate('window.settingsIdentityFixture.updates.length'), 1); assert.equal(await evaluate('document.querySelector("#login-identity-password").validity.valueMissing'), true); result.checks.newIdentityRequiresPassword = true;
  await fill('#login-identity-password', 'fixture-only-secret'); await choose('#login-identity-remember', 'persistent'); await click('保存身份'); await until(() => evaluate('window.settingsIdentityFixture.updates.length === 2'), 'new identity saved');
  assert.equal(await evaluate('window.settingsIdentityFixture.updates[1].remember'), 'persistent');
  await fill('[aria-label="搜索登录身份"]', 'tester'); assert.equal(await evaluate('document.querySelectorAll(".identity-list-item").length'), 1); await evaluate('document.querySelector(".identity-list-item").click()'); await delay(35); await click('删除身份'); assert.equal(await evaluate('window.settingsIdentityFixture.deletions.length'), 0); await click('确认删除'); await until(() => evaluate('window.settingsIdentityFixture.deletions.length === 1'), 'delete confirmed'); result.checks.identitySearchAndDelete = true;
  phase = 'storage capability';
  await evaluate('window.settingsIdentityFixture.secureStorageAvailable = false'); await click('关于'); await click('登录身份'); await until(() => evaluate('Boolean(document.querySelector(".identity-list-item"))'), 'reloaded list'); await click('新建身份'); assert.equal(await evaluate('document.querySelector("#login-identity-remember option[value=persistent]").disabled'), true); result.checks.storageUnavailableDisablesPersistence = true;
  await evaluate('document.documentElement.dataset.theme="light"'); await picture('identity-new-light');
  result.success = true;
}
run().catch(error => { result.success = false; result.phase = phase; result.error = error.stack || String(error); }).finally(async () => { if (window && !window.isDestroyed() && !result.success) { try { result.body = await evaluate('document.body.innerText'); await picture('failure'); } catch {} } await fs.writeFile(report, JSON.stringify(result, null, 2)); app.exit(result.success && result.errors.length === 0 ? 0 : 1); });
