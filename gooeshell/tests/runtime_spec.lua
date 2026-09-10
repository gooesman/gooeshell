-- Run with: wezterm.exe --config-file <absolute path>/tests/runtime_spec.lua show-keys
-- The caller must set GOOESHELL_DATA_DIR to a disposable directory, and set
-- GOOESHELL_BIN_DIR / GOOESHELL_SESSION_KNOWN_HOSTS. No GUI or SSH is opened.
local wezterm = require 'wezterm'
local tests_dir = wezterm.config_dir:gsub('\\', '/')
local app_dir = tests_dir:gsub('/tests$', '')
assert((os.getenv('GOOESHELL_DATA_DIR') or ''):find('tests', 1, true), 'Use a disposable tests data directory')
arg = { [0] = tests_dir .. '/core_spec.lua' }
dofile(tests_dir .. '/core_spec.lua')
wezterm.config_dir = app_dir
local config = dofile(app_dir .. '/gooeshell.lua')

local captured, overrides, spawned, title
local mock_pane, mock_file, mock_window, mock_tab, mock_mux
local zoomed_state, active_pane, with_files = false, 10, false
local other_zoomed = true
local other_tab = { tab_id = function() return 8 end, set_zoomed = function(_, value) other_zoomed = value end }
local other_pane = { pane_id = function() return 12 end, tab = function() return other_tab end, activate = function() active_pane = 12 end }
mock_tab = {
  tab_id = function() return 7 end,
  set_title = function(_, value) title = value end,
  set_zoomed = function(_, value) local previous = zoomed_state; zoomed_state = value; return previous end,
  panes_with_info = function()
    local result = { { pane = mock_pane, is_zoomed = zoomed_state and active_pane == 10 } }
    if with_files then result[#result + 1] = { pane = mock_file, is_zoomed = zoomed_state and active_pane == 11 } end
    return result
  end,
}
mock_pane = { pane_id = function() return 10 end, tab = function() return mock_tab end, activate = function() active_pane = 10 end }
mock_file = { pane_id = function() return 11 end, tab = function() return mock_tab end, activate = function() active_pane = 11 end }
mock_mux = {
  spawn_tab = function(_, spec) spawned = spec; return mock_tab, mock_pane end,
  tabs = function() return { mock_tab, other_tab } end,
}
mock_window = {
  window_id = function() return 9 end,
  mux_window = function() return mock_mux end,
  perform_action = function(_, action) captured = action end,
  get_config_overrides = function() return overrides or {} end,
  set_config_overrides = function(_, value) overrides = value end,
  set_right_status = function() end,
}
local function emit(name, pane) wezterm.emit('gooeshell-' .. name, mock_window, pane or mock_pane) end
local function select_value(value)
  local overlay = captured.InputSelector or captured.PromptInputLine
  assert(overlay, 'Expected an actual validated WezTerm overlay assignment')
  local event = overlay.action.EmitEvent
  assert(event, 'Expected actual WezTerm action_callback event')
  wezterm.emit(event, mock_window, mock_pane, value, value)
end

emit('menu')
assert(#captured.InputSelector.choices >= 10, 'Chinese menu choices')
local extra_host_file = assert(io.open(os.getenv('GOOESHELL_DATA_DIR') .. '/hosts.json', 'wb'))
extra_host_file:write(wezterm.json_encode { { user = 'existing', host = 'example.test', port = 22, trust = 'permanent' } })
extra_host_file:close()
emit('connect')
assert(captured.PromptInputLine.description:find('IPv6', 1, true))
select_value('tester@[::1]:2222')
assert(captured.InputSelector.choices[2].id == 'session', 'Trust choices are real overlay')
select_value('session')
assert(spawned.args[#spawned.args] == '::1', 'IPv6 target passed as one argument')
assert(title == 'tester@[::1]:2222', 'Connection tab label')
assert(spawned.domain == 'DefaultDomain', 'SSH runs in local domain')
local saved_host_file = assert(io.open(os.getenv('GOOESHELL_DATA_DIR') .. '/hosts.json', 'rb'))
local saved_hosts = wezterm.json_parse(saved_host_file:read('*a'))
saved_host_file:close()
assert(#saved_hosts == 2, 'Host saved by another window after config loading is preserved')

emit('fonts')
select_value('size')
select_value('15.5')
assert(overrides.font_size == 15.5, 'Font size preview applied immediately')
select_value('cancel')
assert(overrides.font_size == nil, 'Cancel restores prior font settings')

emit('shortcuts')
select_value('copy')
select_value('Ctrl+R')
assert(captured.InputSelector.title:find('快捷键格式', 1, true), 'Shell history key protected')
emit('shortcuts')
select_value('files')
select_value('Ctrl+Shift+P')
assert(captured.InputSelector.title:find('快捷键冲突', 1, true), 'Duplicate mapping rejected')

emit('zen')
assert(overrides.enable_tab_bar == false and overrides.window_decorations == 'RESIZE', 'Zen hides controls')
emit('zen')
assert(overrides.enable_tab_bar == nil and overrides.window_decorations == nil, 'Zen restores configured controls')
assert(zoomed_state == false, 'Zen restores prior split layout')
with_files = true
wezterm.GLOBAL['gooeshell.files'] = { ['7'] = { file = 11, terminal = 10 } }
active_pane = 11
emit('zen', mock_file)
assert(active_pane == 10 and zoomed_state == true, 'Zen from file pane reveals terminal')
emit('files')
assert(zoomed_state == false and overrides.enable_tab_bar == nil, 'File shortcut exits zen and reveals files')
emit('zen')
emit('zen', other_pane)
assert(zoomed_state == false and other_zoomed == true, 'Exit zen from another tab restores original tab only')
assert(config.disable_default_key_bindings == true, 'Explicit shortcut dispatch only')
assert(config.key_map_preference == 'Physical', 'Shortcuts do not depend on shifted characters or Caps Lock')
assert(config.front_end == 'OpenGL', 'Verified renderer is default')
print('PASS: real WezTerm config, menu callbacks, SSH argument flow, font preview, shortcut conflicts, cross-tab zen/file restoration')
return config
