const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { finishRendererFixture } = require('./renderer-fixture-report.cjs');
const url = process.env.GOOESHELL_LOCAL_APP_URL, report = process.env.GOOESHELL_LOCAL_APP_REPORT, userData = process.env.GOOESHELL_LOCAL_APP_DATA;
if (!url || new URL(url).hostname !== '127.0.0.1' || !report || !userData) throw new Error('Explicit isolated fixture paths required');
app.setPath('userData', userData); app.commandLine.appendSwitch('force-device-scale-factor', '1');
const result = { checks: {}, errors: [] }; let window, phase = 'startup';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => window.webContents.executeJavaScript(code);
async function until(predicate, label) { const end = Date.now() + 9000; while (!await predicate()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await wait(25); } }
async function click(label) {
  const expression = `(() => { const buttons = [...document.querySelectorAll('button')].filter(button => !button.disabled && button.getClientRects().length); return buttons.find(button => button.getAttribute('aria-label') === ${JSON.stringify(label)} || button.textContent.trim() === ${JSON.stringify(label)}) || buttons.find(button => button.title === ${JSON.stringify(label)}); })()`;
  await until(() => evaluate(`Boolean(${expression})`), label); await evaluate(`${expression}.click()`); await wait(40);
}
async function value(selector, value, select = false) {
  await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(${select ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype, 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event(${select ? "'change'" : "'input'"}, { bubbles: true })); })()`); await wait(40);
}
const active = () => evaluate(`document.querySelector('[data-terminal-session][data-active="true"]')?.dataset.terminalSession || ''`);
const count = method => evaluate(`window.localTerminalFixture.calls.filter(call => call.method === ${JSON.stringify(method)}).length`);
const buffers = () => evaluate(`(window.__appConnectionTerminals || []).filter(term => term.element?.isConnected).map(term => ({ node: term.element.parentElement.closest('[data-terminal-session]').dataset.terminalSession, text: Array.from({length:term.buffer.normal.length}, (_, index) => term.buffer.normal.getLine(index)?.translateToString(true) || '').join('\\n') }))`);
async function key(keyCode, modifiers = []) {
  await evaluate(`document.querySelector('[data-terminal-session][data-active="true"] .xterm-helper-textarea')?.focus()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (!modifiers.length && keyCode.length === 1) window.webContents.sendInputEvent({ type: 'char', keyCode });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await wait(45);
}
async function picture(name) {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  window.webContents.invalidate();
  await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  const pixels = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  await fs.writeFile(report + '.' + name + '.png', pixels.toPNG());
}
async function selectSession(id) {
  await evaluate(`(() => { const instance = document.querySelector('[data-terminal-session="${id}"]'); const index = [...document.querySelectorAll('[data-terminal-session]')].indexOf(instance); const tabs = [...document.querySelectorAll('.terminal-tab')]; const target = tabs.find(tab => tab.dataset.workspaceTab === window.localTabs?.[${JSON.stringify(id)}]); if (target) target.click(); else tabs[index]?.click(); })()`);
  await until(async () => await active() === id, 'switch to ' + id);
}
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } }); window.setMenu(null);
  window.webContents.on('console-message', (...args) => { const details = args[0], message = typeof args[2] === 'string' ? args[2] : details.message, level = typeof args[1] === 'number' ? args[1] : details.level; if (level >= 3 || level === 'error') result.errors.push(message); });
  await window.loadURL(url);
  await until(() => evaluate(`Boolean(document.querySelector('.connection-home select option[value="cmd"]'))`), 'home');
  assert.equal(await evaluate(`document.querySelectorAll('.terminal-tab').length`), 1);
  assert.equal(await evaluate(`document.querySelectorAll('.recent-connection').length`), 1);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.connection-home select option')].map(option => option.value)`), ['pwsh', 'powershell', 'cmd']);
  await picture('dark-home'); await click('切换为白色主题'); await picture('light-home'); await click('切换为黑色主题');
  result.checks.homeRetainsHistoryAndShellChoices = true;

  phase = 'home shell and graphical directory choice';
  await click('选择本地终端启动目录');
  assert.equal(await evaluate(`document.querySelector('[aria-label="本地终端启动目录"]').value`), 'C:\\Fixture\\工作项目');
  await click('使用默认启动目录');
  await value('[aria-label="本地终端 Shell"]', 'cmd', true);
  await evaluate(`window.originalHome = document.querySelector('.terminal-tab');`);
  await click('打开本地终端'); await until(async () => await active() === 'local-1', 'local in home');
  await until(async () => (await buffers()).some(term => term.text.includes('OUTPUT local-1 中文 ✓')), 'UTF-8 local output');
  assert.equal(await evaluate(`document.querySelectorAll('.terminal-tab').length === 1 && document.querySelector('.terminal-tab') === window.originalHome && !document.querySelector('.connection-home')`), true);
  assert.equal(await evaluate(`window.localTerminalFixture.calls.find(call => call.method === 'createLocalSession').request.shell`), 'cmd');
  assert.equal(await evaluate(`document.querySelector('.connection-state').textContent`), '运行中');
  assert.equal(await count('remoteList'), 0); assert.equal(await count('connect'), 0);
  result.checks.homeLaunchInPlace = true;

  phase = 'local input and file capabilities';
  await key('x'); await until(async () => await count('terminalInput') > 0, 'local terminal input');
  assert.equal(await evaluate(`window.localTerminalFixture.calls.find(call => call.method === 'terminalInput').id`), 'local-1');
  result.checks.inputAndUnicodeOutput = true;
  await click('展开文件管理');
  assert.equal(await evaluate(`document.querySelector('[aria-label="远程目录路径"]').disabled && document.querySelector('[aria-label="跟随终端目录"]').disabled`), true);
  assert.equal(await evaluate(`document.querySelector('.dual-files').textContent.includes('本地终端不使用远程文件')`), true);
  assert.equal(await evaluate(`document.querySelector('[aria-label="本地目录路径"]').disabled`), false);
  await value('[aria-label="本地目录路径"]', 'C:\\Fixture\\子目录');
  await evaluate(`document.querySelector('[aria-label="本地目录路径"]').form.requestSubmit()`);
  await until(() => evaluate(`window.localTerminalFixture.calls.some(call => call.method === 'localList' && call.request === 'C:\\\\Fixture\\\\子目录')`), 'local browsing');
  await key('P', ['control', 'alt']);
  assert.equal(await count('sendSudoPassword'), 0); assert.equal(await count('terminalCwd'), 0); assert.equal(await count('remoteList'), 0);
  result.checks.localFilesEnabledRemoteDisabled = true;

  phase = 'SSH and local tabs';
  await click('新建标签页');
  await evaluate(`document.querySelector('.host').click()`); await until(async () => await active() === 'ssh-1', 'SSH tab');
  await until(async () => (await buffers()).some(term => term.text.includes('OUTPUT ssh-1')), 'SSH output');
  assert.equal(await evaluate(`document.querySelectorAll('.terminal-tab').length`), 2);
  const remoteCalls = await count('remoteList'); assert.ok(remoteCalls > 0);
  await evaluate(`window.localTabs = { 'local-1': document.querySelectorAll('.terminal-tab')[0].dataset.workspaceTab, 'ssh-1': document.querySelectorAll('.terminal-tab')[1].dataset.workspaceTab }; window.originalTerminals = [...document.querySelectorAll('.xterm')];`);
  await selectSession('local-1');
  assert.equal(await count('remoteList'), remoteCalls);
  assert.equal(await evaluate(`document.querySelector('.host').getAttribute('aria-current')`), null);
  await selectSession('ssh-1');
  assert.equal(await evaluate(`document.querySelector('[aria-label="远程目录路径"]').disabled`), false);
  assert.equal(await evaluate(`window.originalTerminals.every(term => term.isConnected)`), true);
  result.checks.sshAndLocalTabsIndependent = true;

  phase = 'local entry from a live SSH terminal';
  await click('打开本地终端设置'); await value('[role="dialog"] [aria-label="本地终端 Shell"]', 'powershell', true);
  await click('打开本地终端'); await until(async () => await active() === 'local-2', 'new local tab from SSH');
  assert.equal(await evaluate(`document.querySelectorAll('.terminal-tab').length`), 3);
  assert.equal(await count('disconnect'), 0); assert.equal(await count('connect'), 1);
  await evaluate(`window.localTabs['local-2'] = document.querySelector('.terminal-tab.active').dataset.workspaceTab;`);
  await key('Left', ['control', 'shift']); await until(async () => await active() === 'ssh-1', 'previous terminal shortcut');
  await key('Right', ['control', 'shift']); await until(async () => await active() === 'local-2', 'next terminal shortcut');
  result.checks.launchFromSshCreatesTab = true;

  phase = 'local global command use';
  await evaluate(`[...document.querySelectorAll('button')].find(button => button.title.startsWith('展开命令管理')).click()`);
  await click('填入全局示例');
  assert.equal(await evaluate(`window.localTerminalFixture.calls.find(call => call.method === 'sendCommand').id`), 'local-2');
  await value('#command-scope', 'fixture-server', true);
  assert.equal(await evaluate(`document.querySelector('[aria-label="填入专属示例"]').disabled && document.querySelector('[aria-label="运行专属示例"]').disabled`), true);
  result.checks.localGlobalCommandsOnly = true;
  await click('收起命令库');

  phase = 'local exit and in-place reopen';
  await selectSession('local-1');
  await evaluate(`window.localTerminalFixture.emit({ type:'sessionClosed', sessionId:'local-1', message:'本地进程已退出（退出码 0）' }); window.localBeforeReopen = document.querySelector('.terminal-tab.active'); window.localTermBeforeReopen = document.querySelector('[data-terminal-session="local-1"] .xterm');`);
  await until(() => evaluate(`document.querySelector('.terminal-reconnect strong')?.textContent === '本地进程已退出'`), 'local exit prompt');
  assert.equal(await evaluate(`document.querySelector('.terminal-reconnect').textContent.includes('重新连接')`), false);
  await key('R', ['control', 'shift']); await until(async () => await active() === 'local-3', 'local reopen shortcut');
  await until(async () => (await buffers()).some(term => term.node === 'local-3' && term.text.includes('OUTPUT local-3')), 'reopened output');
  assert.equal(await evaluate(`document.querySelector('.terminal-tab.active') === window.localBeforeReopen && document.querySelector('[data-terminal-session="local-3"] .xterm') === window.localTermBeforeReopen`), true);
  assert.equal(await count('connect'), 1);
  assert.equal((await buffers()).some(term => term.node === 'local-3' && term.text.includes('OUTPUT local-1')), true);
  await evaluate(`window.localTabs['local-3'] = window.localTabs['local-1'];`);
  result.checks.localExitAndReopen = true;

  phase = 'cancelling a pending local tab';
  await evaluate(`window.localTerminalFixture.holdLocal = true;`); await click('新建标签页'); await click('打开本地终端');
  await until(() => evaluate(`document.body.textContent.includes('正在打开本地终端…')`), 'local launch pending');
  await evaluate(`document.querySelector('.terminal-tab.active .tab-close').click(); window.localTerminalFixture.holdLocal = false; window.localTerminalFixture.releaseLocal();`);
  await until(() => evaluate(`window.localTerminalFixture.calls.some(call => call.method === 'disconnect' && call.id === 'local-4')`), 'late process stopped');
  assert.equal(await evaluate(`document.querySelectorAll('.terminal-tab').length`), 3);
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-terminal-session="local-4"]'))`), false);
  result.checks.cancelLateLocalLaunch = true;

  phase = 'closing local tabs while SSH survives';
  await selectSession('local-3'); await evaluate(`document.querySelector('.terminal-tab.active .tab-close').click()`);
  await selectSession('local-2'); await evaluate(`document.querySelector('.terminal-tab.active .tab-close').click()`);
  await until(async () => await active() === 'ssh-1', 'remaining SSH tab');
  assert.equal(await evaluate(`document.querySelectorAll('.terminal-tab').length`), 1);
  assert.equal(await evaluate(`window.localTerminalFixture.calls.some(call => call.method === 'disconnect' && call.id === 'ssh-1')`), false);
  assert.equal((await buffers()).some(term => term.node === 'ssh-1' && term.text.includes('OUTPUT ssh-1')), true);
  result.checks.closingLocalPreservesSsh = true;
  result.success = true;
}
run().catch(error => { result.success = false; result.phase = phase; result.error = error.stack || String(error); }).finally(async () => {
  if (window && !window.isDestroyed() && !result.success) { try { await picture('failure'); result.body = await evaluate('document.body.innerText'); } catch {} }
  await finishRendererFixture(app, report, result, result.success && !result.errors.length ? 0 : 1);
});
