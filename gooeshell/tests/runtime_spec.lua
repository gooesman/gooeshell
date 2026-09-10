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
local mock_pane, mock_window, mock_tab, mock_mux
mock_tab = {
  tab_id = function() return 7 end,
  set_title = function(_, value) title = value end,
  panes_with_info = function() return { { pane = mock_pane, is_zoomed = false } } end,
}
mock_pane = { pane_id = function() return 10 end, tab = function() return mock_tab end, activate = function() end }
mock_mux = {
  spawn_tab = function(_, spec) spawned = spec; return mock_tab, mock_pane end,
}
mock_window = {
  window_id = function() return 9 end,
  mux_window = function() return mock_mux end,
  perform_action = function(_, action) captured = action end,
  get_config_overrides = function() return overrides or {} end,
  set_config_overrides = function(_, value) overrides = value end,
  set_right_status = function() end,
}
local function emit(name) wezterm.emit('gooeshell-' .. name, mock_window, mock_pane) end
local function select_value(value)
  local overlay = captured.InputSelector or captured.PromptInputLine
  assert(overlay, 'Expected an actual validated WezTerm overlay assignment')
  local event = overlay.action.EmitEvent
  assert(event, 'Expected actual WezTerm action_callback event')
  wezterm.emit(event, mock_window, mock_pane, value, value)
end

emit('menu')
assert(#captured.InputSelector.choices >= 10, 'Chinese menu choices')
emit('connect')
assert(captured.PromptInputLine.description:find('IPv6', 1, true))
select_value('tester@[::1]:2222')
assert(captured.InputSelector.choices[2].id == 'session', 'Trust choices are real overlay')
select_value('session')
assert(spawned.args[#spawned.args] == '::1', 'IPv6 target passed as one argument')
assert(title == 'tester@[::1]:2222', 'Connection tab label')
assert(spawned.domain == 'DefaultDomain', 'SSH runs in local domain')

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
assert(config.disable_default_key_bindings == true, 'Explicit shortcut dispatch only')
print('PASS: real WezTerm config, menu callbacks, SSH argument flow, font preview, shortcut conflicts, zen restoration')
return config
