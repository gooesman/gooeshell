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
  const expression = `(() => [...document.querySelectorAll('button')].find(button => !button.disabled && button.getClientRects().length > 0 && (button.getAttribute('aria-label') === ${JSON.stringify(label)} || button.title === ${JSON.stringify(label)} || button.textContent.trim() === ${JSON.stringify(label)})))()`;
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
const historySelector = '[aria-label="最近连接"] .recent-connection';
const activeSession = () => evaluate(`document.querySelector('[data-terminal-session][data-active="true"]')?.dataset.terminalSession || ''`);
async function shortcut(keyCode) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['control', 'shift'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['control', 'shift'] });
  await delay(35);
}
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
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(historySelector)})) && Boolean(document.querySelector("#connection-group-development .host"))`), 'App history and grouped sidebar');
  assert.equal(await evaluate(`document.getElementById('file-manager').hidden`), true);
  assert.equal(await evaluate(`document.getElementById('command-library-dock').hidden`), true);
  assert.equal(await connectCount(), 0);
  assert.equal(await evaluate(`document.querySelectorAll('.terminal-tab').length`), 1);
  assert.match(await evaluate(`document.querySelector('.terminal-tab.active').textContent`), /新标签页/);
  assert.equal(await evaluate(`document.querySelectorAll('.saved-connection').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('.host .host-icon').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('.connection-group-toggle svg').length`), 2);
  result.checks.initialHomeTab = true;
  phase = 'recent menu edits and saves without connecting';
  await context(historySelector); await click('编辑连接设置…');
  await until(() => evaluate(`!!document.getElementById('credential-remember') && !document.getElementById('credential-remember').disabled`), 'connection settings loaded');
  await fill('#host-name', '开发工作站'); await click('保存'); await noDialog();
  await until(() => evaluate(`document.querySelector('.recent-copy strong').textContent === '开发工作站' && document.querySelector('.host-name').textContent === '开发工作站'`), 'name synced in history and sidebar');
  assert.equal(await connectCount(), 0); assert.equal(await evaluate(`document.querySelectorAll('.terminal-tab').length`), 1);
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
  await context(historySelector); await click('删除这条最近记录');
  await until(() => evaluate(`!document.querySelector(${JSON.stringify(historySelector)})`), 'recent removed');
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
  // Wait for style/layout and :has() invalidation after the reconnect strip mounts.
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const geometry = await evaluate(`(() => { const strip = document.querySelector('.terminal-reconnect').getBoundingClientRect(), region = document.querySelector('.terminal-region').getBoundingClientRect(), button = document.querySelector('.terminal-reconnect button').getBoundingClientRect(); return { contained: strip.left >= region.left && strip.right <= region.right && strip.top >= region.top && strip.bottom <= region.bottom, buttonVisible: button.left >= strip.left && button.right <= strip.right && button.bottom <= strip.bottom, text: document.querySelector('.terminal-reconnect').textContent }; })()`);
  assert.equal(geometry.contained, true); assert.equal(geometry.buttonVisible, true); assert.match(geometry.text, /Ctrl \+ Shift \+ R/);
  const reconnectHit = await evaluate(`(() => { const button = document.querySelector('.terminal-reconnect button'); const bounds = button.getBoundingClientRect(); const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); return { visible: hit === button || button.contains(hit), hitTag: hit?.tagName, hitClass: typeof hit?.className === 'string' ? hit.className : '', bounds: bounds.toJSON(), viewport: { width: innerWidth, height: innerHeight }, toasts: [...document.querySelectorAll('.toast')].map(toast => ({ text: toast.textContent, bounds: toast.getBoundingClientRect().toJSON() })) }; })()`);
  assert.equal(reconnectHit.visible, true, 'disconnect toasts must not cover the reconnect button: ' + JSON.stringify(reconnectHit));
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

  phase = 'plus opens independent home tabs and quick connect remains separate';
  const reconnectedId = await activeSession(), connectsBeforeHomes = await connectCount();
  await evaluate(`window.fixtureOriginalTab = document.querySelector('.terminal-tab.active')`);
  await click('新建标签页');
  await until(() => evaluate(`document.querySelectorAll('.terminal-tab').length === 2 && Boolean(document.querySelector('.connection-home'))`), 'first new home tab');
  assert.equal(await activeSession(), ''); assert.equal(await connectCount(), connectsBeforeHomes);
  assert.equal(await evaluate(`Boolean(document.querySelector('[role="dialog"]'))`), false);
  assert.equal(await evaluate(`document.querySelector('.xterm') === window.fixtureTerminalNode`), true);
  await evaluate(`window.fixtureFirstHomeTab = document.querySelector('.terminal-tab.active')`);
  await evaluate(`document.querySelector('.host').click()`);
  await until(async () => await activeSession() === reconnectedId, 'sidebar reuses the live connection from a home');
  assert.equal(await connectCount(), connectsBeforeHomes);
  await evaluate(`window.fixtureFirstHomeTab.click()`);
  await click('新建标签页');
  await until(() => evaluate(`document.querySelectorAll('.terminal-tab').length === 3`), 'second independent home tab');
  await evaluate(`window.fixtureSecondHomeTab = document.querySelector('.terminal-tab.active')`);
  assert.equal(await evaluate(`window.fixtureFirstHomeTab !== window.fixtureSecondHomeTab && [...document.querySelectorAll('.terminal-tab')].filter(tab => tab.textContent.includes('新标签页')).length === 2`), true);
  await shortcut('P'); await until(() => evaluate(`Boolean(document.getElementById('host-address'))`), 'quick-connect shortcut opens settings');
  await click('关闭连接设置'); await noDialog();
  assert.equal(await connectCount(), connectsBeforeHomes);
  assert.equal(await evaluate(`document.querySelector('.terminal-tab.active') === window.fixtureSecondHomeTab`), true);
  result.checks.plusCreatesIndependentHomeTabs = true;

  phase = 'home only lists recent choices and never lists a remote home identity';
  const listsBeforeHome = await evaluate(`window.appConnectionsFixture.calls.filter(call => call.method === 'remoteList').length`);
  await click('展开文件管理'); await delay(100);
  assert.equal(await evaluate(`window.appConnectionsFixture.calls.filter(call => call.method === 'remoteList').length`), listsBeforeHome);
  assert.equal(await evaluate(`document.querySelector('[aria-label="远程目录路径"]').disabled`), true);
  await click('收起文件管理');
  await picture('dark-new-tab');
  assert.equal(await evaluate(`document.querySelectorAll('.saved-connection').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(historySelector)}).length`), 1);
  window.setSize(960, 760); await click('切换为白色主题'); await picture('light-new-tab-small');
  const homeLayout = await evaluate(`(() => { const home = document.querySelector('.connection-home'), cards = [...home.querySelectorAll('.recent-connection')].map(card => card.getBoundingClientRect()), bounds = home.getBoundingClientRect(); return { overflow: document.documentElement.scrollWidth > innerWidth, contained: cards.every(card => card.left >= bounds.left && card.right <= bounds.right && card.width > 100) }; })()`);
  assert.equal(homeLayout.overflow, false); assert.equal(homeLayout.contained, true);
  await click('切换为黑色主题'); window.setSize(1280, 860); await delay(60);
  result.checks.homeRemoteOperationsDisabled = true;

  phase = 'recent selections replace their blank tabs without reusing another session';
  await evaluate(`window.fixtureFirstHomeTab.click()`);
  await click('连接最近服务器 开发工作站');
  await until(async () => (await activeSession()) !== '' && (await activeSession()) !== reconnectedId, 'recent choice fills first home');
  const firstNewSession = await activeSession();
  assert.equal(await connectCount(), connectsBeforeHomes + 1);
  assert.equal(await evaluate(`document.querySelectorAll('.terminal-tab').length`), 3);
  assert.equal(await evaluate(`document.querySelector('.terminal-tab.active') === window.fixtureFirstHomeTab && !window.fixtureFirstHomeTab.textContent.includes('新标签页')`), true);
  await evaluate(`window.fixtureSecondHomeTab.click()`);
  await click('连接最近服务器 开发工作站');
  await until(async () => (await activeSession()) !== '' && ![reconnectedId, firstNewSession].includes(await activeSession()), 'recent choice fills second home');
  const secondNewSession = await activeSession();
  assert.equal(await connectCount(), connectsBeforeHomes + 2);
  assert.equal(await evaluate(`document.querySelectorAll('.terminal-tab').length`), 3);
  assert.equal(await evaluate(`document.querySelector('.terminal-tab.active') === window.fixtureSecondHomeTab && document.querySelector('.xterm') === window.fixtureTerminalNode`), true);
  result.checks.homeSelectionsReplaceExactTabs = true;

  phase = 'tab navigation includes homes and terminal renderers stay mounted';
  await shortcut('Left'); assert.equal(await activeSession(), firstNewSession);
  await shortcut('Left'); assert.equal(await activeSession(), reconnectedId);
  await shortcut('Right'); assert.equal(await activeSession(), firstNewSession);
  await evaluate(`window.fixtureOriginalTab.click(); window.fixtureFirstHomeTab.querySelector('.tab-close').click(); window.fixtureSecondHomeTab.querySelector('.tab-close').click()`);
  await until(() => evaluate(`document.querySelectorAll('.terminal-tab').length === 1`), 'extra sessions closed');
  assert.equal(await activeSession(), reconnectedId);
  await click('新建标签页'); await evaluate(`window.fixturePendingHomeTab = document.querySelector('.terminal-tab.active')`);
  await shortcut('Left'); assert.equal(await activeSession(), reconnectedId);
  await shortcut('Right'); assert.equal(await activeSession(), '');
  assert.equal(await evaluate(`document.querySelector('.terminal-tab.active') === window.fixturePendingHomeTab && document.querySelector('.xterm') === window.fixtureTerminalNode`), true);
  result.checks.homeTabNavigationPreservesRenderers = true;

  phase = 'closing a pending home cancels its attempt and disposes a late transport';
  const disconnectsBeforePending = await evaluate(`window.appConnectionsFixture.calls.filter(call => call.method === 'disconnect').length`);
  const pendingConnectCount = await connectCount();
  await evaluate(`window.appConnectionsFixture.holdConnect = true`); await click('连接最近服务器 开发工作站');
  await until(async () => await connectCount() === pendingConnectCount + 1, 'held home attempt started');
  const pendingAttempt = await evaluate(`window.appConnectionsFixture.calls.filter(call => call.method === 'connect').at(-1).requestId`);
  await evaluate(`window.fixturePendingHomeTab.querySelector('.tab-close').click()`);
  await until(() => evaluate(`document.querySelectorAll('.terminal-tab').length === 1`), 'pending home closed');
  assert.equal(await activeSession(), reconnectedId);
  assert.equal(await evaluate(`window.appConnectionsFixture.calls.some(call => call.method === 'cancelConnect' && call.requestId === ${JSON.stringify(pendingAttempt)})`), true);
  assert.equal(await evaluate(`window.appConnectionsFixture.calls.filter(call => call.method === 'disconnect').length`), disconnectsBeforePending);
  await evaluate(`window.appConnectionsFixture.holdConnect = false; window.appConnectionsFixture.releaseConnect()`);
  await until(() => evaluate(`window.appConnectionsFixture.calls.filter(call => call.method === 'disconnect').length === ${disconnectsBeforePending + 1}`), 'late transport disposed');
  assert.equal(await activeSession(), reconnectedId);
  assert.equal(await evaluate(`document.querySelectorAll('.terminal-tab').length === 1 && document.querySelector('.xterm') === window.fixtureTerminalNode`), true);
  assert.equal(await evaluate(`window.appConnectionsFixture.calls.filter(call => call.method === 'disconnect').at(-1).sessionId === ${JSON.stringify(reconnectedId)}`), false);
  result.checks.pendingHomeCloseCancelsOnlyItsAttempt = true;

  phase = 'command dock shortcut and connection-scoped editing';
  await evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'M', modifiers: ['control', 'shift'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'M', modifiers: ['control', 'shift'] });
  await until(() => evaluate(`!document.getElementById('command-library-dock').hidden`), 'command dock shown');
  await click('新建命令分组'); await fill('#command-editor-name', '此连接命令');
  assert.equal(await evaluate(`document.getElementById('command-group-owner').value`), 'preview');
  await click('保存'); await noDialog();
  await click('向此连接命令添加命令'); await fill('#command-editor-name', '查看工作目录'); await fill('#command-editor-text', 'pwd'); await click('保存'); await noDialog();
  await click('新建命令分组'); await fill('#command-editor-name', '常用操作'); await choose('#command-group-owner', ''); await click('保存'); await noDialog();
  await click('向常用操作添加命令'); await fill('#command-editor-name', '查看系统时间'); await fill('#command-editor-text', 'date'); await click('保存'); await noDialog();
  assert.equal(await evaluate(`window.appConnectionsFixture.commandLibrary().then(library => library.commands.length)`), 2);
  await click('收起命令库'); assert.equal(await evaluate(`document.getElementById('command-library-dock').hidden`), true);
  await evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'M', modifiers: ['control', 'shift'] }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'M', modifiers: ['control', 'shift'] });
  await until(() => evaluate(`!document.getElementById('command-library-dock').hidden && document.querySelectorAll('.command-card').length === 2`), 'command dock reopened with saved commands');
  assert.equal(await evaluate(`document.querySelector('.xterm') === window.fixtureTerminalNode`), true);
  result.checks.commandDockShortcutAndPersistence = true;

  phase = 'terminal palette remains independent of interface theme';
  await click('设置'); await click('终端配色');
  await evaluate(`[...document.querySelectorAll('.terminal-palette-choice')].find(button => button.querySelector('strong').textContent === '石墨').click()`);
  await click('保存设置'); await noDialog();
  await until(() => evaluate(`getComputedStyle(document.querySelector('[data-terminal-session][data-active="true"]')).backgroundColor === 'rgb(23, 23, 23)'`), 'palette applied live');
  assert.equal(await evaluate(`window.appConnectionsFixture.settings().then(settings => settings.terminalPalette)`), 'graphite');
  await picture('dark-command-dock');
  await click('切换为白色主题'); await until(() => evaluate(`document.documentElement.dataset.theme === 'light'`), 'light dock');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-terminal-session][data-active="true"]')).backgroundColor`), 'rgb(23, 23, 23)');
  assert.equal(await evaluate(`document.querySelector('.xterm') === window.fixtureTerminalNode`), true);
  await picture('light-command-dock');
  window.setSize(960, 760); await delay(100);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const dockLayout = await evaluate(`(() => { const dock = document.querySelector('.commands-dock').getBoundingClientRect(), terminal = document.querySelector('.terminal-region').getBoundingClientRect(); return { dockWidth: dock.width, terminalWidth: terminal.width, adjacent: terminal.right <= dock.left + 1, withinViewport: dock.right <= innerWidth + 1, overflow: document.documentElement.scrollWidth > innerWidth }; })()`);
  assert.ok(dockLayout.dockWidth >= 270 && dockLayout.dockWidth <= 321, JSON.stringify(dockLayout)); assert.ok(dockLayout.terminalWidth >= 200, JSON.stringify(dockLayout)); assert.equal(dockLayout.adjacent, true); assert.equal(dockLayout.withinViewport, true); assert.equal(dockLayout.overflow, false);
  await picture('light-command-dock-small'); await click('切换为黑色主题'); await picture('dark-command-dock-small');
  window.setSize(1280, 860); await delay(60); await click('收起命令库');
  result.checks.independentTerminalPaletteAndDockLayout = true;

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
  await click('新建标签页'); await evaluate(`window.fixtureSaveOnlyHome = document.querySelector('.terminal-tab.active')`);
  await click('快速连接');
  await fill('#host-address', 'new.example.test');
  await until(() => evaluate(`!!document.getElementById('credential-remember') && !document.getElementById('credential-remember').disabled`), 'new connection ready');
  await click('保存到侧边栏'); await noDialog();
  await until(() => evaluate(`document.querySelectorAll('.host').length === 2`), 'saved connection is visible');
  assert.equal(await connectCount(), connectsBeforeSave);
  assert.equal(await evaluate(`window.appConnectionsFixture.state().then(state => state.profiles.some(profile => profile.host === 'new.example.test'))`), true);
  assert.equal(await evaluate(`document.querySelector('.terminal-tab.active') === window.fixtureSaveOnlyHome && Boolean(document.querySelector('.connection-home')) && document.querySelectorAll('.saved-connection').length === 0`), true);
  assert.equal(await evaluate(`document.querySelector('.connection-home').textContent.includes('new.example.test')`), false);
  await evaluate(`window.fixtureSaveOnlyHome.querySelector('.tab-close').click()`);
  await until(() => evaluate(`document.querySelectorAll('.terminal-tab').length === 1 && !document.querySelector('.connection-home')`), 'saved-only home closed without altering original terminal');
  result.checks.newSaveCreatesVisibleFavorite = true;

  phase = 'closing the last terminal and last home always leaves a usable home';
  await evaluate(`document.querySelector('.terminal-tab.active .tab-close').click()`);
  await until(() => evaluate(`document.querySelectorAll('.terminal-tab').length === 1 && Boolean(document.querySelector('.connection-home')) && !document.querySelector('.xterm')`), 'last terminal replaced by home');
  assert.match(await evaluate(`document.querySelector('.terminal-tab.active').textContent`), /新标签页/);
  assert.equal(await evaluate(`document.querySelectorAll('.saved-connection').length`), 0);
  const disconnectsBeforeHomeClose = await evaluate(`window.appConnectionsFixture.calls.filter(call => call.method === 'disconnect').length`);
  await evaluate(`window.fixtureLastHome = document.querySelector('.terminal-tab.active'); window.fixtureLastHome.querySelector('.tab-close').click()`);
  await until(() => evaluate(`document.querySelectorAll('.terminal-tab').length === 1 && document.querySelector('.terminal-tab.active') !== window.fixtureLastHome && Boolean(document.querySelector('.connection-home'))`), 'last home replaced by a fresh home');
  assert.equal(await evaluate(`window.appConnectionsFixture.calls.filter(call => call.method === 'disconnect').length`), disconnectsBeforeHomeClose);
  assert.equal(await connectCount(), connectsBeforeSave);
  result.checks.lastTabCloseReturnsToFreshHome = true;
  result.success = true;
}
run().catch(error => { result.success = false; result.phase = phase; result.error = error.stack || String(error); }).finally(async () => {
  if (window && !window.isDestroyed() && !result.success) { try { await picture('failure'); result.body = await evaluate('document.body.innerText'); } catch {} }
  await fs.writeFile(report, JSON.stringify(result, null, 2)); app.exit(result.success && result.errors.length === 0 ? 0 : 1);
});
