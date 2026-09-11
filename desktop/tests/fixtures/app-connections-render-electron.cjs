const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const url = process.env.GOOESHELL_APP_CONNECTIONS_URL;
const report = process.env.GOOESHELL_APP_CONNECTIONS_REPORT;
if (!url || new URL(url).hostname !== '127.0.0.1' || !report || !process.env.GOOESHELL_APP_CONNECTIONS_DATA) throw new Error('An isolated loopback fixture and data directory are required');
app.setPath('userData', process.env.GOOESHELL_APP_CONNECTIONS_DATA);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const result = { checks: {}, errors: [], visuals: {} };
let window, phase = 'startup';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = script => window.webContents.executeJavaScript(script);
async function until(predicate, label) {
  const end = Date.now() + 10_000;
  while (!(await predicate())) { if (Date.now() > end) throw new Error('Timed out: ' + label); await delay(25); }
}
async function click(label) {
  const expression = `(() => [...document.querySelectorAll('button')].find(button => !button.disabled && (button.getAttribute('aria-label') === ${JSON.stringify(label)} || button.title === ${JSON.stringify(label)} || button.textContent.trim() === ${JSON.stringify(label)})))()`;
  await until(() => evaluate(`Boolean(${expression})`), label); await evaluate(`${expression}.click()`); await delay(30);
}
async function fill(selector, text) {
  await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); input.select(); })()`);
  await until(() => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); return input.selectionStart === 0 && input.selectionEnd === input.value.length; })()`), 'input selection');
  await window.webContents.insertText(text); await delay(30);
}
async function choose(selector, value) {
  await evaluate(`(() => { const select = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(value)}); select.dispatchEvent(new Event('change', { bubbles: true })); })()`); await delay(30);
}
async function context(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 340, clientY: 240 }))`);
  await until(() => evaluate('Boolean(document.querySelector(".connection-context-menu"))'), 'connection menu');
}
const connectCount = () => evaluate(`window.appConnectionsFixture.calls.filter(call => call.method === 'connect').length`);
const noDialog = () => until(() => evaluate('!document.querySelector("[role=dialog]")'), 'dialog closed');
async function picture(label) {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  window.webContents.invalidate();
  await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  await fs.writeFile(report + '.' + label + '.png', image.toPNG());
  result.visuals[label] = { width: image.getSize().width, height: image.getSize().height, theme: await evaluate('document.documentElement.dataset.theme') };
}
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 1280, height: 860, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.on('console-message', (...args) => { const details = args[0], message = typeof args[2] === 'string' ? args[2] : details.message, level = typeof args[1] === 'number' ? args[1] : details.level; if (level >= 3 || level === 'error') result.errors.push(message); });
  window.webContents.on('render-process-gone', (_event, detail) => result.errors.push(JSON.stringify(detail)));
  await window.loadURL(url);
  await until(() => evaluate('Boolean(document.querySelector(".recent-connection")) && Boolean(document.querySelector("#connection-group-development .host"))'), 'App history and grouped sidebar');
  assert.equal(await evaluate(`document.getElementById('file-manager').hidden`), true);
  assert.equal(await connectCount(), 0);
  phase = 'recent menu edits and saves without connecting';
  await context('.recent-connection'); await click('编辑连接设置…');
  await until(() => evaluate(`!!document.getElementById('credential-remember') && !document.getElementById('credential-remember').disabled`), 'connection settings loaded');
  await fill('#host-name', '开发工作站'); await click('保存'); await noDialog();
  await until(() => evaluate(`document.querySelector('.recent-copy strong').textContent === '开发工作站' && document.querySelector('.host-name').textContent === '开发工作站'`), 'name synced in history and sidebar');
  assert.equal(await connectCount(), 0); assert.equal(await evaluate(`document.querySelectorAll('.terminal-tab').length`), 0);
  result.checks.recentEditSavesWithoutConnection = true;

  phase = 'host-key cancellation advances the pending dialog queue';
  await evaluate(`window.appConnectionsFixture.emit({ type: 'hostKey', requestId: 'key-one', host: 'one.example.test', port: 22, fingerprint: 'SHA256:fixture-one' }); window.appConnectionsFixture.emit({ type: 'hostKey', requestId: 'key-two', host: 'two.example.test', port: 22, fingerprint: 'SHA256:fixture-two' })`);
  await until(() => evaluate(`document.querySelector('.trust-fingerprint')?.textContent === 'SHA256:fixture-one'`), 'first fingerprint');
  await evaluate(`window.appConnectionsFixture.emit({ type: 'hostKeyCancelled', requestId: 'key-one' })`);
  await until(() => evaluate(`document.querySelector('.trust-fingerprint')?.textContent === 'SHA256:fixture-two'`), 'remaining fingerprint');
  await click('仅信任本次'); await noDialog();
  assert.equal(await evaluate(`window.appConnectionsFixture.calls.filter(call => call.method === 'hostKey').length`), 1);
  assert.equal(await evaluate(`window.appConnectionsFixture.calls.find(call => call.method === 'hostKey').requestId`), 'key-two');
  result.checks.hostKeyCancellationQueue = true;

  phase = 'group creation and context move';
  await click('新建连接分组'); await fill('#connection-group-name', '实验设备'); await choose('#connection-group-icon', 'router'); await click('保存分组'); await noDialog();
  const newGroupId = await evaluate(`window.appConnectionsFixture.state().then(state => state.groups.find(group => group.name === '实验设备').id)`);
  await context('.host'); await choose('[aria-label="移到连接分组"]', newGroupId);
  await until(() => evaluate(`Boolean(document.getElementById(${JSON.stringify('connection-group-' + newGroupId)}).querySelector('.host'))`), 'host moved into new group');
  await click('实验设备分组菜单'); await click('上移');
  await until(() => evaluate(`document.querySelector('.connection-group').getAttribute('aria-label') === '实验设备'`), 'group reordered');
  assert.equal(await connectCount(), 0);
  result.checks.groupCreateMoveAndSort = true;
  await picture('dark-home');
  await click('切换为白色主题'); await until(() => evaluate(`document.documentElement.dataset.theme === 'light'`), 'light theme'); await picture('light-home');

  phase = 'group deletion retains saved connection';
  await click('实验设备分组菜单'); await click('删除分组（保留连接）'); await click('确认删除'); await noDialog();
  await until(() => evaluate(`Boolean(document.querySelector('.ungrouped .host'))`), 'deleted group moves host to ungrouped');
  assert.equal(await evaluate(`document.querySelectorAll('.host').length`), 1);
  assert.equal(await evaluate(`window.appConnectionsFixture.state().then(state => state.profiles.length)`), 1);
  result.checks.groupDeletionPreservesConnections = true;

  phase = 'delete recent record keeps the saved connection';
  await context('.recent-connection'); await click('删除这条最近记录');
  await until(() => evaluate(`!document.querySelector('.recent-connection')`), 'recent removed');
  assert.equal(await evaluate(`document.querySelectorAll('.host').length`), 1);
  result.checks.historyDeletionPreservesFavorite = true;

  phase = 'single click connects directly and repeated clicks reuse tab';
  await evaluate(`document.querySelector('.host').click()`);
  await until(() => evaluate(`document.querySelectorAll('.terminal-tab').length === 1 && Boolean(document.querySelector('.xterm'))`), 'terminal opened');
  assert.equal(await evaluate(`Boolean(document.querySelector('[role="dialog"]'))`), false);
  const before = await connectCount(); await evaluate(`document.querySelector('.host').click()`); await delay(50);
  assert.equal(await connectCount(), before);
  result.checks.sidebarDirectConnectsAndReusesTab = true;
  await delay(550);
  const originalId = await evaluate(`document.querySelector('[data-terminal-session][data-active="true"]').dataset.terminalSession`);
  await evaluate(`window.fixtureTerminalNode = document.querySelector('.xterm')`);
  await evaluate(`window.appConnectionsFixture.disconnect(${JSON.stringify(originalId)})`);
  await until(() => evaluate(`Boolean(document.querySelector('.terminal-reconnect'))`), 'disconnected strip');
  const geometry = await evaluate(`(() => { const strip = document.querySelector('.terminal-reconnect').getBoundingClientRect(), region = document.querySelector('.terminal-region').getBoundingClientRect(), button = document.querySelector('.terminal-reconnect button').getBoundingClientRect(); return { contained: strip.left >= region.left && strip.right <= region.right && strip.top >= region.top && strip.bottom <= region.bottom, buttonVisible: button.left >= strip.left && button.right <= strip.right && button.bottom <= strip.bottom, text: document.querySelector('.terminal-reconnect').textContent }; })()`);
  assert.equal(geometry.contained, true); assert.equal(geometry.buttonVisible, true); assert.match(geometry.text, /Ctrl \+ Shift \+ R/);
  assert.equal(await evaluate(`(() => { const button = document.querySelector('.terminal-reconnect button'); const bounds = button.getBoundingClientRect(); const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); return hit === button || button.contains(hit); })()`), true, 'disconnect toasts must not cover the reconnect button');
  await picture('light-disconnected');
  await click('切换为黑色主题'); await until(() => evaluate(`document.documentElement.dataset.theme === 'dark'`), 'dark theme'); await picture('dark-disconnected');
  result.checks.reconnectStripLayout = true;

  phase = 'reconnect shortcut keeps original terminal renderer';
  await evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control', 'shift'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['control', 'shift'] });
  await until(() => evaluate(`document.querySelector('[data-terminal-session][data-active="true"]').dataset.terminalSession !== ${JSON.stringify(originalId)} && !document.querySelector('.terminal-reconnect')`), 'shortcut reconnected');
  assert.equal(await evaluate(`document.querySelector('.xterm') === window.fixtureTerminalNode`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.terminal-tab').length`), 1);
  result.checks.reconnectShortcutPreservesRenderer = true;

  phase = 'cancel reconnect is wired to the current attempt';
  const activeId = await evaluate(`document.querySelector('[data-terminal-session][data-active="true"]').dataset.terminalSession`);
  await evaluate(`window.appConnectionsFixture.disconnect(${JSON.stringify(activeId)}); window.appConnectionsFixture.holdConnect = true`);
  await until(() => evaluate(`Boolean(document.querySelector('.terminal-reconnect'))`), 'second disconnect');
  await evaluate(`document.querySelector('.terminal-reconnect button').click()`); await click('取消重连');
  await evaluate(`window.appConnectionsFixture.holdConnect = false; window.appConnectionsFixture.releaseConnect()`);
  await until(() => evaluate(`document.querySelector('.terminal-reconnect strong')?.textContent === '连接已断开'`), 'cancel settled');
  assert.equal(await evaluate(`document.querySelector('[data-terminal-session][data-active="true"]').dataset.terminalSession`), activeId);
  result.checks.cancelReconnectWiring = true;

  phase = 'saving a brand-new connection adds a visible favorite without connecting';
  const connectsBeforeSave = await connectCount();
  await click('快速连接');
  await fill('#host-address', 'new.example.test');
  await until(() => evaluate(`!!document.getElementById('credential-remember') && !document.getElementById('credential-remember').disabled`), 'new connection ready');
  await click('保存到侧边栏'); await noDialog();
  await until(() => evaluate(`document.querySelectorAll('.host').length === 2`), 'saved connection is visible');
  assert.equal(await connectCount(), connectsBeforeSave);
  assert.equal(await evaluate(`window.appConnectionsFixture.state().then(state => state.profiles.some(profile => profile.host === 'new.example.test'))`), true);
  result.checks.newSaveCreatesVisibleFavorite = true;
  result.success = true;
}
run().catch(error => { result.success = false; result.phase = phase; result.error = error.stack || String(error); }).finally(async () => {
  if (window && !window.isDestroyed() && !result.success) { try { await picture('failure'); result.body = await evaluate('document.body.innerText'); } catch {} }
  await fs.writeFile(report, JSON.stringify(result, null, 2)); app.exit(result.success && result.errors.length === 0 ? 0 : 1);
});
