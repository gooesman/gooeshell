local root = (arg and arg[0] or ''):gsub('\\', '/'):match('^(.*)/tests/[^/]+$') or 'gooeshell'
local core = dofile(root .. '/core.lua')
local checks = 0
local function check(value, message)
  checks = checks + 1
  assert(value, message)
end

local host = assert(core.parse_target('  root@192.168.1.2:2222  '))
check(host.host == '192.168.1.2' and host.port == 2222 and host.user == 'root', 'IPv4 target')
check(core.target_label(host) == 'root@192.168.1.2:2222', 'round-trip target label')
check(assert(core.parse_target('alice@server')).port == 22, 'default SSH port')
local ipv6 = assert(core.parse_target('alice@[2001:db8::10]:2200'))
check(ipv6.host == '2001:db8::10' and ipv6.port == 2200, 'bracketed IPv6')
check(assert(core.parse_target('alice@[fe80::1%12]')).port == 22, 'IPv6 scope')
for _, invalid in ipairs {
  '', 'server', 'user@', 'user@host:0', 'user@host:65536', 'user@host:abc',
  'user@2001:db8::1', 'user@host;whoami', '-oProxyCommand@host', 'user@-oProxyCommand',
  'user@host\nwhoami', 'user@[::1]:22;whoami', 'user@[host]', 'user@host:2:2',
} do check(core.parse_target(invalid) == nil, 'reject unsafe or ambiguous target: ' .. invalid) end

local b = assert(core.parse_binding(' Shift + ctrl + e '))
check(b.key == 'E' and b.mods == 'CTRL|SHIFT', 'normalize modifiers and key')
check(assert(core.parse_binding('F11')).mods == 'NONE', 'bare function key')
check(assert(core.parse_binding('ctrl+equal')).key == '=', 'punctuation alias')
check(assert(core.parse_binding('Ctrl+Shift+left')).key == 'LeftArrow', 'arrow alias')
for _, reserved in ipairs { 'C', 'Shift+C', 'Ctrl+C', 'Ctrl+R', 'Ctrl+B', 'Win+L', 'Alt+F4', 'Ctrl+Ctrl+K', 'Ctrl+Unknown' } do
  check(core.parse_binding(reserved) == nil, 'preserve terminal/system shortcut: ' .. reserved)
end
local defaults = core.bindings(nil)
check(core.binding_conflict(defaults, 'fonts', assert(core.parse_binding('Ctrl+Shift+P'))) == '操作菜单', 'shortcut conflict')
check(core.binding_conflict(defaults, 'menu', assert(core.parse_binding('Ctrl+Shift+P'))) == nil, 'same action unchanged')
local bad = core.copy(defaults)
bad.files = core.copy(bad.menu)
check(core.bindings(bad).files.key == 'E', 'corrupt duplicate map safely resets')

local prefs = core.preferences { font_size = -3, chinese_scale = 100, right_click_paste = 'yes', english_font = 'Consolas' }
check(core.defaults.english_font == 'DejaVu Sans Mono', 'default matches user font reference')
check(prefs.font_size == 13 and prefs.chinese_scale == 1, 'validate persisted font ranges')
check(prefs.right_click_paste == false and prefs.english_font == 'Consolas', 'validate persisted field types')
check(core.valid_host { host = '-evil', user = 'root', port = 22 } == nil, 'validate persisted hosts')
local args = core.ssh_args('ssh.exe', host, 'D:/App With Space/data/known_hosts')
check(args[1] == 'ssh.exe' and args[#args] == host.host, 'direct argument SSH launch')
local options = table.concat(args, '\n')
check(options:find('StrictHostKeyChecking=ask', 1, true) ~= nil, 'never disable host identity checking')
check(options:find('UserKnownHostsFile="D:/App With Space/data/known_hosts"', 1, true) ~= nil, 'SSH config path with spaces')
print('PASS: ' .. checks .. ' data/shortcut/SSH checks')
