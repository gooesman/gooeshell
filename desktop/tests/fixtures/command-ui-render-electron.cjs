const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const url = process.env.GOOESHELL_COMMAND_UI_URL, report = process.env.GOOESHELL_COMMAND_UI_REPORT;
if (!url || new URL(url).hostname !== '127.0.0.1' || !report || !process.env.GOOESHELL_COMMAND_UI_DATA) throw new Error('An isolated loopback fixture and data directory are required');
app.setPath('userData', process.env.GOOESHELL_COMMAND_UI_DATA);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const result = { checks: {}, errors: [] };
let window, phase = 'startup', copied = '';
let library = {
  groups: [{ id: 'global', name: '常用', order: 0 }, { id: 'own', name: '维护', connectionId: 'one', connectionName: '开发服务器', order: 1 }, { id: 'other', name: '设备维护', connectionId: 'two', connectionName: '测试设备', order: 2 }, { id: 'orphan', name: '旧环境', connectionId: 'deleted', connectionName: '旧服务器', order: 3 }],
  commands: [
    { id: 'disk', groupId: 'global', name: '磁盘空间', command: 'df -h', description: '查看磁盘使用情况', mode: 'insert', confirmBeforeRun: false, order: 0 },
    { id: 'status', groupId: 'own', name: '服务状态', command: 'systemctl status app', description: '', mode: 'execute', confirmBeforeRun: false, order: 0 },
    { id: 'borrow', groupId: 'other', name: '设备日志', command: 'journalctl -n 30', description: '最近的系统日志', mode: 'insert', confirmBeforeRun: false, order: 0 },
  ],
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = script => window.webContents.executeJavaScript(script);
async function until(predicate, label) { const end = Date.now() + 8_000; while (!(await predicate())) { if (Date.now() > end) throw new Error('Timed out: ' + label); await delay(20); } }
async function click(label) {
  const selector = `(() => [...document.querySelectorAll('button')].find(button => !button.disabled && button.getClientRects().length > 0 && (button.getAttribute('aria-label') === ${JSON.stringify(label)} || button.textContent.trim() === ${JSON.stringify(label)})))()`;
  await until(() => evaluate(`Boolean(${selector})`), label); await evaluate(`${selector}.click()`); await delay(35);
}
async function fill(selector, value) {
  await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); input.select(); })()`);
  await window.webContents.insertText(value); await delay(35);
}
async function choose(selector, value) {
  await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('change', { bubbles: true })); })()`); await delay(35);
}
const sends = () => evaluate(`window.commandFixture.actions.filter(action => action.type === 'send')`);
const dialogClosed = () => until(() => evaluate(`!document.querySelector('[role="dialog"]')`), 'dialog closed');
async function picture(label) {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); window.webContents.invalidate();
  await fs.writeFile(report + '.' + label + '.png', (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
}
async function run() {
  await app.whenReady();
  const handle = (name, action) => ipcMain.handle('command-ui:' + name, async (event, value) => { assert.equal(event.sender, window.webContents); return action(value); });
  handle('read', () => library);
  handle('save-group', value => { library.groups = [...library.groups.filter(group => group.id !== value.id), value]; });
  handle('delete-group', id => { library.groups = library.groups.filter(group => group.id !== id); library.commands = library.commands.filter(command => command.groupId !== id); });
  handle('save-command', value => { assert.ok(library.groups.some(group => group.id === value.groupId)); library.commands = [...library.commands.filter(command => command.id !== value.id), value]; });
  handle('delete-command', id => { library.commands = library.commands.filter(command => command.id !== id); });
  handle('copy', text => { copied = text; });
  window = new BrowserWindow({ show: false, width: 1120, height: 920, webPreferences: { preload: path.join(__dirname, 'command-ui-render-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) result.errors.push(message); });
  window.webContents.on('render-process-gone', (_event, detail) => result.errors.push(JSON.stringify(detail)));
  await window.loadURL(url); await until(() => evaluate(`Boolean(window.commandFixture) && document.querySelectorAll('.command-card').length === 2`), 'fixture loaded');
  phase = 'scope and offline copy';
  assert.equal(await evaluate(`document.querySelector('.command-groups').innerText.includes('设备日志')`), false);
  assert.equal(await evaluate(`document.querySelector('#command-scope').innerText.includes('旧服务器（连接已删除）')`), true);
  await evaluate(`document.querySelector('.command-group-toggle').click()`); await delay(25);
  assert.equal(await evaluate(`document.querySelector('#command-group-global').hidden`), true);
  await evaluate(`document.querySelector('.command-group-toggle').click()`);
  await evaluate('window.commandFixture.setConnected(false)'); await delay(25);
  assert.equal(await evaluate(`document.querySelector('[aria-label="填入磁盘空间"]').disabled`), true);
  await click('复制磁盘空间'); assert.equal(copied, 'df -h'); assert.equal((await sends()).length, 0);
  await evaluate('window.commandFixture.setConnected(true)'); await delay(25); await picture('dark-sidebar');
  result.checks.scopeAndOfflineCopy = true;

  phase = 'borrowed preview target and invalidation';
  await choose('#command-scope', 'two'); await click('填入设备日志');
  assert.match(await evaluate(`document.querySelector('[role="dialog"]').innerText`), /测试设备.*设备维护[\s\S]*开发服务器[\s\S]*developer@dev.example.test:22/);
  assert.equal(await evaluate(`document.querySelector('.command-preview').textContent`), 'journalctl -n 30'); assert.equal((await sends()).length, 0);
  await evaluate(`window.commandFixture.switchSession('two')`); await delay(25); await evaluate(`window.commandFixture.switchSession('one')`); await delay(25);
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === '确认填入').disabled`), true);
  await click('取消'); await click('填入设备日志'); await click('确认填入'); await dialogClosed();
  assert.equal((await sends()).length, 1); assert.equal((await sends())[0].value.borrowed, true); assert.equal((await sends())[0].value.mode, 'insert'); assert.equal((await sends())[0].value.sessionId, 'transport-one');
  result.checks.borrowedPreviewBoundToTarget = true;

  phase = 'changed command rejects old preview';
  await click('运行设备日志'); await evaluate(`window.commandFixture.replaceCommand('borrow', 'journalctl -n 60')`); await delay(35);
  assert.equal(await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === '确认运行').disabled`), true);
  assert.equal(await evaluate(`document.querySelector('.command-preview').textContent`), 'journalctl -n 30');
  assert.match(await evaluate(`document.querySelector('[role="alert"]').textContent`), /命令或分组已发生变化/);
  await click('取消'); assert.equal((await sends()).length, 1); result.checks.changedCommandInvalidatesPreview = true;

  phase = 'CRUD without sending and persisted move';
  await choose('#command-scope', '@global'); await click('新建命令分组'); await fill('#command-editor-name', '日志');
  assert.equal(await evaluate(`document.querySelector('#command-group-owner').value`), '');
  await click('保存'); await dialogClosed(); const logs = library.groups.find(group => group.name === '日志'); assert.ok(logs); assert.equal(logs.connectionId, undefined);
  await click('向日志添加命令'); await fill('#command-editor-name', '查看应用日志'); await fill('#command-editor-text', 'cd /srv/app\ntail -n 50 app.log'); await fill('#command-editor-description', '只查看最近的应用日志'); await choose('#command-editor-mode', 'execute'); await evaluate(`document.querySelector('#command-editor-confirm').click()`);
  await evaluate(`window.commandFixture.setTheme('light')`); await picture('light-command-editor');
  await evaluate(`[...document.querySelectorAll('[role="dialog"] button')].at(-1).focus()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' }); await delay(35);
  assert.match(await evaluate(`document.activeElement.getAttribute('aria-label')`), /^关闭/); result.checks.focusTrapAndThemes = true;
  await click('保存'); await dialogClosed(); const command = library.commands.find(item => item.name === '查看应用日志'); assert.equal(command.command, 'cd /srv/app\ntail -n 50 app.log'); assert.equal(command.mode, 'execute'); assert.equal(command.confirmBeforeRun, true); assert.equal((await sends()).length, 1);
  await click('查看应用日志'); await fill('#command-editor-name', '放弃的名称'); await click('取消'); assert.match(await evaluate(`document.querySelector('.command-discard').textContent`), /放弃未保存/); await click('放弃修改'); assert.equal(library.commands.find(item => item.id === command.id).name, '查看应用日志');
  await click('查看应用日志'); await choose('#command-editor-group', 'global'); await click('保存'); await dialogClosed(); assert.equal(library.commands.find(item => item.id === command.id).groupId, 'global');
  await evaluate('window.commandFixture.reload()'); await until(() => evaluate(`document.querySelectorAll('.command-card').length === 3`), 'remounted library');
  await click('运行查看应用日志'); assert.equal((await sends()).length, 1); await click('确认运行'); await dialogClosed(); assert.equal((await sends()).at(-1).value.borrowed, false); assert.equal((await sends()).at(-1).value.mode, 'execute'); result.checks.createEditMoveAndPersistence = true;

  phase = 'content search, deletion confirmation and cascading group delete';
  await fill('[aria-label="搜索命令"]', 'tail -n 50'); assert.equal(await evaluate(`document.querySelectorAll('.command-card').length`), 1); await click('清除命令搜索');
  await click('删除查看应用日志'); assert.ok(library.commands.some(item => item.id === command.id)); await click('确认删除'); await dialogClosed(); assert.equal(library.commands.some(item => item.id === command.id), false);
  await click('删除维护分组'); assert.match(await evaluate(`document.querySelector('[role="dialog"]').innerText`), /1 条命令也会删除/); await click('确认删除'); await dialogClosed(); assert.equal(library.groups.some(group => group.id === 'own'), false); assert.equal(library.commands.some(item => item.groupId === 'own'), false); result.checks.searchAndDelete = true;

  phase = 'saved identity changes require borrowing';
  await evaluate(`window.commandFixture.switchSession('two'); window.commandFixture.setScopeConnectionId('')`); await delay(35);
  assert.equal(await evaluate(`document.querySelector('.command-groups').textContent.includes('设备日志')`), false);
  await choose('#command-scope', 'two'); await click('填入设备日志'); assert.match(await evaluate(`document.querySelector('[role="dialog"]').getAttribute('aria-label')`), /借用/); await click('取消');
  result.checks.identityChangeRequiresBorrowing = true;
  await evaluate(`window.commandFixture.setTheme('dark')`); await picture('dark-borrowed-sidebar');
  await click('收起命令库'); assert.equal(await evaluate(`window.commandFixture.actions.at(-1).type`), 'close');
  result.success = true;
}
run().catch(error => { result.success = false; result.phase = phase; result.error = error.stack || String(error); }).finally(async () => { await fs.writeFile(report, JSON.stringify(result, null, 2)); app.exit(result.success && result.errors.length === 0 ? 0 : 1); });
