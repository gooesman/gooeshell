-- Pure data rules, shared by the configuration and the small Lua test suite.
local M = {}

function M.copy(value)
  if type(value) ~= 'table' then return value end
  local out = {}
  for key, item in pairs(value) do out[key] = M.copy(item) end
  return out
end

function M.trim(value)
  return (tostring(value or ''):gsub('^%s+', ''):gsub('%s+$', ''))
end

function M.parse_target(input)
  input = M.trim(input)
  local user, address = input:match('^([^@]+)@(.+)$')
  if not user or not user:match('^[%w_.-]+$') or user:sub(1, 1) == '-' then
    return nil, '请输入 用户名@主机，例如 root@192.168.1.10:22。用户名仅支持字母、数字、下划线、点和短横线。'
  end
  local host, port
  if address:sub(1, 1) == '[' then
    local remainder
    host, remainder = address:match('^%[([^%]]+)%](.*)$')
    if not host or not host:find(':', 1, true) or not host:match('^[%x:.%%_%w-]+$') then
      return nil, 'IPv6 请写为 user@[2001:db8::1]:22。'
    end
    if remainder == '' then port = 22
    elseif remainder:match('^:%d+$') then port = tonumber(remainder:sub(2))
    else return nil, 'IPv6 方括号后只能接 :端口。' end
  else
    local count = select(2, address:gsub(':', ''))
    if count > 1 then return nil, 'IPv6 地址需要方括号，例如 user@[2001:db8::1]:22。' end
    if count == 1 then
      host, port = address:match('^([^:]+):(%d+)$')
      port = tonumber(port)
    else host, port = address, 22 end
    if not host or not host:match('^[%w_.-]+$') or host:sub(1, 1) == '-' then
      return nil, '主机名不合法。请使用 IP、域名或 SSH 配置中的主机别名。'
    end
  end
  if not port or port % 1 ~= 0 or port < 1 or port > 65535 then
    return nil, '端口必须是 1–65535 之间的整数。'
  end
  return { user = user, host = host, port = port }
end

function M.target_label(host)
  local address = host.host:find(':', 1, true) and ('[' .. host.host .. ']') or host.host
  return host.user .. '@' .. address .. ':' .. tostring(host.port)
end

function M.valid_host(record)
  if type(record) ~= 'table' or type(record.user) ~= 'string' or type(record.host) ~= 'string' then return nil end
  local ok, label = pcall(M.target_label, record)
  if not ok then return nil end
  local host = M.parse_target(label)
  if not host then return nil end
  host.trust = record.trust == 'session' and 'session' or 'permanent'
  return host
end

M.defaults = {
  english_font = 'JetBrains Mono', chinese_font = 'Microsoft YaHei',
  font_size = 13, chinese_scale = 1.0, font_weight = 'Regular',
  line_height = 1.05, show_tab_bar = true, show_status = true,
  background_image = '', background_brightness = 0.16,
  right_click_paste = false, copy_on_select = false, welcome = true,
}

function M.preferences(saved)
  local result = M.copy(M.defaults)
  if type(saved) ~= 'table' then return result end
  for _, key in ipairs { 'english_font', 'chinese_font', 'background_image' } do
    if type(saved[key]) == 'string' and #saved[key] < 1024 and not saved[key]:find('[%z\r\n]') then result[key] = saved[key] end
  end
  for key, limits in pairs {
    font_size = { 6, 48 }, chinese_scale = { 0.7, 1.6 },
    line_height = { 0.8, 2 }, background_brightness = { 0, 1 },
  } do
    if type(saved[key]) == 'number' and saved[key] >= limits[1] and saved[key] <= limits[2] then result[key] = saved[key] end
  end
  for _, key in ipairs { 'show_tab_bar', 'show_status', 'right_click_paste', 'copy_on_select', 'welcome' } do
    if type(saved[key]) == 'boolean' then result[key] = saved[key] end
  end
  if saved.font_weight == 'Regular' or saved.font_weight == 'Medium' or saved.font_weight == 'Bold' then result.font_weight = saved.font_weight end
  return result
end

M.commands = {
  { id = 'menu', label = '操作菜单', key = 'P', mods = 'CTRL|SHIFT' },
  { id = 'connect', label = '新建 SSH 连接', key = 'N', mods = 'CTRL|SHIFT' },
  { id = 'hosts', label = '已保存的主机', key = 'O', mods = 'CTRL|SHIFT' },
  { id = 'files', label = '远程文件面板', key = 'E', mods = 'CTRL|SHIFT' },
  { id = 'fonts', label = '字体与字号', key = ',', mods = 'CTRL|SHIFT' },
  { id = 'shortcuts', label = '编辑快捷键', key = 'K', mods = 'CTRL|SHIFT' },
  { id = 'copy', label = '复制选中内容', key = 'C', mods = 'CTRL|SHIFT' },
  { id = 'paste', label = '粘贴', key = 'V', mods = 'CTRL|SHIFT' },
  { id = 'search', label = '搜索终端输出', key = 'F', mods = 'CTRL|SHIFT' },
  { id = 'new_tab', label = '新建本地终端', key = 'T', mods = 'CTRL|SHIFT' },
  { id = 'close_pane', label = '关闭当前面板（确认）', key = 'W', mods = 'CTRL|SHIFT' },
  { id = 'next_tab', label = '下一个标签', key = 'Tab', mods = 'CTRL' },
  { id = 'previous_tab', label = '上一个标签', key = 'Tab', mods = 'CTRL|SHIFT' },
  { id = 'font_larger', label = '增大字号', key = '=', mods = 'CTRL' },
  { id = 'font_smaller', label = '减小字号', key = '-', mods = 'CTRL' },
  { id = 'font_reset', label = '恢复 13 号字', key = '0', mods = 'CTRL' },
  { id = 'fullscreen', label = '无边框全屏', key = 'F11', mods = 'NONE' },
  { id = 'zen', label = '纯终端 / 恢复布局', key = 'F11', mods = 'CTRL|SHIFT' },
  { id = 'focus_left', label = '聚焦左侧面板', key = 'LeftArrow', mods = 'CTRL|SHIFT' },
  { id = 'focus_right', label = '聚焦右侧面板', key = 'RightArrow', mods = 'CTRL|SHIFT' },
  { id = 'focus_up', label = '聚焦上方面板', key = 'UpArrow', mods = 'CTRL|SHIFT' },
  { id = 'focus_down', label = '聚焦下方面板', key = 'DownArrow', mods = 'CTRL|SHIFT' },
}

local named_keys = { TAB = 'Tab', ENTER = 'Enter', SPACE = 'Space', INSERT = 'Insert',
  DELETE = 'Delete', HOME = 'Home', END = 'End', PAGEUP = 'PageUp', PAGEDOWN = 'PageDown',
  LEFT = 'LeftArrow', RIGHT = 'RightArrow', UP = 'UpArrow', DOWN = 'DownArrow',
  LEFTARROW = 'LeftArrow', RIGHTARROW = 'RightArrow', UPARROW = 'UpArrow', DOWNARROW = 'DownArrow',
  MINUS = '-', EQUAL = '=', COMMA = ',', PERIOD = '.', BACKSPACE = 'Backspace' }
local modifier_order = { 'CTRL', 'SHIFT', 'ALT', 'SUPER' }

function M.parse_binding(text)
  text = M.trim(text):upper():gsub('%s+', ''):gsub('|', '+')
  local parts = {}
  for part in text:gmatch('[^+]+') do parts[#parts + 1] = part end
  if #parts == 0 then return nil, '请输入组合键，例如 Ctrl+Shift+E 或 F11。' end
  local raw = table.remove(parts)
  local key = named_keys[raw] or raw
  local f = raw:match('^F(%d+)$')
  if #key ~= 1 and not named_keys[raw] and not (f and tonumber(f) >= 1 and tonumber(f) <= 24) then
    return nil, '不支持这个按键名。支持字母、数字、F1–F24、Tab、方向键等；加号请写 Equal。'
  end
  local mods, seen = {}, {}
  for _, modifier in ipairs(parts) do
    if modifier == 'CONTROL' then modifier = 'CTRL' end
    if modifier == 'WIN' then modifier = 'SUPER' end
    if modifier ~= 'CTRL' and modifier ~= 'SHIFT' and modifier ~= 'ALT' and modifier ~= 'SUPER' then
      return nil, '修饰键只支持 Ctrl、Shift、Alt、Win。'
    end
    if seen[modifier] then return nil, '同一个修饰键不能重复。' end
    seen[modifier] = true
  end
  for _, modifier in ipairs(modifier_order) do if seen[modifier] then mods[#mods + 1] = modifier end end
  -- A bare letter would swallow ordinary typing. Shift-only letters are also ordinary input.
  if not f and not seen.CTRL and not seen.ALT and not seen.SUPER then
    return nil, '字母和普通按键需要 Ctrl、Alt 或 Win 修饰，避免吞掉正常输入。'
  end
  if seen.CTRL and not seen.SHIFT and not seen.ALT and not seen.SUPER and key:match('^[A-Z]$') then
    return nil, 'Ctrl+字母保留给 Shell、Vim 和 tmux；请增加 Shift 或 Alt。'
  end
  if seen.SUPER or (seen.ALT and not seen.CTRL and not seen.SHIFT and (key == 'F4' or key == 'Tab')) then
    return nil, '这个组合通常由 Windows 接管，请换一个组合。'
  end
  return { key = key, mods = #mods > 0 and table.concat(mods, '|') or 'NONE' }
end

function M.binding_label(binding)
  if binding.mods == 'NONE' then return binding.key end
  return (binding.mods:gsub('|', '+')) .. '+' .. binding.key
end

function M.bindings(saved)
  local result = {}
  for _, command in ipairs(M.commands) do result[command.id] = { key = command.key, mods = command.mods } end
  if type(saved) == 'table' then
    for _, command in ipairs(M.commands) do
      local value = saved[command.id]
      if type(value) == 'table' and type(value.key) == 'string' and type(value.mods) == 'string' then
        local parsed = M.parse_binding(M.binding_label(value))
        if parsed then result[command.id] = parsed end
      end
    end
  end
  local occupied = {}
  for _, command in ipairs(M.commands) do
    local signature = M.binding_label(result[command.id])
    if occupied[signature] then
      -- A manually corrupted map must not leave critical actions inaccessible.
      return M.bindings(nil)
    end
    occupied[signature] = command.id
  end
  return result
end

function M.binding_conflict(bindings, id, candidate)
  local signature = M.binding_label(candidate)
  for _, command in ipairs(M.commands) do
    if command.id ~= id and M.binding_label(bindings[command.id]) == signature then return command.label end
  end
end

function M.ssh_args(ssh, target, known_hosts)
  -- Each argument is passed directly to CreateProcess, never through a shell.
  return { ssh, '-p', tostring(target.port), '-l', target.user,
    '-o', 'StrictHostKeyChecking=ask', '-o', 'GlobalKnownHostsFile=NUL',
    '-o', 'UserKnownHostsFile="' .. known_hosts:gsub('\\', '/') .. '"',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', target.host }
end

return M
