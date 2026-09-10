local wezterm = require 'wezterm'
local act = wezterm.action
local app_dir = wezterm.config_dir:gsub('\\', '/')
local core = dofile(app_dir .. '/core.lua')
local bin_dir = (os.getenv('GOOESHELL_BIN_DIR') or wezterm.executable_dir):gsub('\\', '/')
local data_dir = (os.getenv('GOOESHELL_DATA_DIR') or (app_dir .. '/data')):gsub('\\', '/')
local session_hosts = os.getenv('GOOESHELL_SESSION_KNOWN_HOSTS')
local settings_path = data_dir .. '/preferences.json'
local shortcuts_path = data_dir .. '/shortcuts.json'
local hosts_path = data_dir .. '/hosts.json'

local function read_json(path)
  local file = io.open(path, 'rb')
  if not file then return nil end
  local raw = file:read('*a')
  file:close()
  local ok, value = pcall(wezterm.json_parse, raw)
  if ok then return value end
  wezterm.log_error('gooeshell: 无法读取 ' .. path .. '；使用默认设置，原文件保留。')
end

local function write_json(path, value)
  local ok, encoded = pcall(wezterm.json_encode, value)
  if not ok then return nil, tostring(encoded) end
  local temp = path .. '.tmp'
  local file, err = io.open(temp, 'wb')
  if not file then return nil, tostring(err) end
  local written, write_error = file:write(encoded .. '\n')
  local closed, close_error = file:close()
  if not written or not closed then os.remove(temp); return nil, tostring(write_error or close_error) end
  -- Windows rename cannot replace an existing destination. Keep one recoverable backup.
  local existing = io.open(path, 'rb')
  if existing then
    existing:close()
    os.remove(path .. '.bak')
    local moved, move_error = os.rename(path, path .. '.bak')
    if not moved then os.remove(temp); return nil, tostring(move_error) end
  end
  local replaced, replace_error = os.rename(temp, path)
  if not replaced then os.rename(path .. '.bak', path); return nil, tostring(replace_error) end
  return true
end

local prefs = core.preferences(read_json(settings_path))
local bindings = core.bindings(read_json(shortcuts_path))
local hosts = {}
local saved_hosts = read_json(hosts_path)
if type(saved_hosts) ~= 'table' then saved_hosts = {} end
for _, record in ipairs(saved_hosts) do
  local host = core.valid_host(record)
  if host then hosts[#hosts + 1] = host end
end

local function global_map(name)
  return wezterm.GLOBAL['gooeshell.' .. name] or {}
end

local function set_global(name, key, value)
  local values = global_map(name)
  values[tostring(key)] = value
  wezterm.GLOBAL['gooeshell.' .. name] = values
end

local function session_for(pane)
  return global_map('sessions')[tostring(pane:pane_id())]
end

local function selector(window, pane, title, choices, callback, fuzzy, description)
  window:perform_action(act.InputSelector {
    title = title, choices = choices, fuzzy = fuzzy == true,
    description = description or '↑↓ 选择  ·  Enter 确认  ·  / 搜索  ·  Esc 返回终端',
    fuzzy_description = '搜索：',
    action = wezterm.action_callback(callback),
  }, pane)
end

local function message(window, pane, title, detail)
  selector(window, pane, 'gooeshell · ' .. title,
    { { id = 'ok', label = detail }, { id = 'close', label = '返回终端' } }, function() end)
end

local function prompt(window, pane, description, initial, callback, cancel)
  window:perform_action(act.PromptInputLine {
    description = description, initial_value = initial or '', prompt = '> ',
    action = wezterm.action_callback(function(w, p, line)
      if line ~= nil then callback(w, p, core.trim(line))
      elseif cancel then cancel(w, p) end
    end),
  }, pane)
end

local function persist(window, pane, path, data)
  local ok, err = write_json(path, data)
  if not ok then message(window, pane, '保存失败', '请检查 data 目录是否可写。' .. tostring(err)) end
  return ok
end

local function font(p)
  local families = { { family = p.english_font, weight = p.font_weight } }
  for _, fallback in ipairs { 'Consolas', 'JetBrains Mono' } do
    if fallback ~= p.english_font then families[#families + 1] = { family = fallback, weight = p.font_weight } end
  end
  families[#families + 1] = { family = p.chinese_font, scale = p.chinese_scale }
  families[#families + 1] = 'Symbols Nerd Font Mono'
  families[#families + 1] = 'Noto Color Emoji'
  return wezterm.font_with_fallback(families)
end

local function set_font_override(window, p)
  local overrides = window:get_config_overrides() or {}
  overrides.font = font(p)
  overrides.font_size = p.font_size
  overrides.line_height = p.line_height
  window:set_config_overrides(overrides)
end

local function save_preferences(window, pane, updated)
  if not persist(window, pane, settings_path, core.preferences(updated)) then return false end
  prefs = core.preferences(updated)
  wezterm.reload_configuration()
  return true
end

local function save_host(window, pane, host)
  local updated, found = {}, false
  for _, entry in ipairs(hosts) do
    if core.target_label(entry) == core.target_label(host) then updated[#updated + 1] = core.copy(host); found = true
    else updated[#updated + 1] = entry end
  end
  if not found then updated[#updated + 1] = core.copy(host) end
  if not persist(window, pane, hosts_path, updated) then return false end
  hosts = updated
  return true
end

local function known_hosts_for(host)
  if host.trust == 'session' then return session_hosts end
  return data_dir .. '/known_hosts'
end

local function ssh_program()
  return os.getenv('GOOESHELL_SSH') or ((os.getenv('SystemRoot') or 'C:/Windows') .. '/System32/OpenSSH/ssh.exe')
end

local handlers = {}
local connect, show_hosts, show_fonts, show_shortcuts, show_appearance

local function start_ssh(window, pane, host)
  local trust_file = known_hosts_for(host)
  if not trust_file or trust_file == '' then
    message(window, pane, '需要启动器', '仅本次信任需要通过 gooeshell.exe 或 start.ps1 启动，以便退出时清理指纹。')
    return
  end
  local ssh = ssh_program()
  local exists = io.open(ssh, 'rb')
  if not exists then message(window, pane, '未找到 SSH', '请安装 Windows 的 OpenSSH 客户端可选功能。'); return end
  exists:close()
  local ok, err = pcall(function()
    local tab, remote = window:mux_window():spawn_tab {
      args = core.ssh_args(ssh, host, trust_file), domain = 'DefaultDomain',
      cwd = wezterm.home_dir,
    }
    tab:set_title(core.target_label(host))
    local session = core.copy(host)
    session.known_hosts = trust_file
    set_global('sessions', remote:pane_id(), session)
  end)
  if not ok then message(window, pane, '连接未启动', tostring(err)) end
end

local function choose_trust(window, pane, host, after)
  selector(window, pane, '连接 ' .. core.target_label(host), {
    { id = 'permanent', label = '保存主机指纹 · 首次连接在终端确认，后续检查变化' },
    { id = 'session', label = '仅本次信任 · 退出应用后清理本次指纹' },
  }, function(w, p, id)
    if not id then return end
    host.trust = id
    if save_host(w, p, host) then after(w, p, host) end
  end, false, '只保存主机地址、用户名、端口和信任偏好；密码直接在 SSH 中输入。')
end

connect = function(window, pane, after)
  prompt(window, pane,
    '新建 SSH 连接\n格式：user@host[:port]；IPv6：user@[2001:db8::1]:22\n密码、公钥与主机指纹在真实 SSH 终端中处理。',
    '', function(w, p, input)
      local host, err = core.parse_target(input)
      if not host then message(w, p, '地址格式', err); return end
      choose_trust(w, p, host, after or start_ssh)
    end)
end

show_hosts = function(window, pane, after)
  local choices = { { id = 'new', label = '+ 新建 SSH 连接' } }
  for index, host in ipairs(hosts) do
    choices[#choices + 1] = { id = tostring(index), label = core.target_label(host)
      .. (host.trust == 'session' and '  [仅本次指纹]' or '') }
  end
  if #hosts > 0 and not after then choices[#choices + 1] = { id = 'manage', label = '管理已保存的主机…' } end
  selector(window, pane, 'gooeshell · 主机', choices, function(w, p, id)
    if not id then return end
    if id == 'new' then connect(w, p, after)
    elseif id == 'manage' then handlers.manage_hosts(w, p)
    else
      local host = hosts[tonumber(id)]
      if host then (after or start_ssh)(w, p, host) end
    end
  end, true)
end

handlers.manage_hosts = function(window, pane)
  local choices = {}
  for index, host in ipairs(hosts) do choices[#choices + 1] = { id = tostring(index), label = core.target_label(host) } end
  selector(window, pane, '选择要管理的主机', choices, function(w, p, id)
    local index = tonumber(id)
    if not index or not hosts[index] then return end
    local host = core.copy(hosts[index])
    selector(w, p, core.target_label(host), {
      { id = 'trust', label = '更改指纹保存方式并连接' },
      { id = 'remove', label = '从主机列表移除（不删除服务器文件）' },
    }, function(w2, p2, operation)
      if operation == 'trust' then choose_trust(w2, p2, host, start_ssh)
      elseif operation == 'remove' then
        local updated = core.copy(hosts)
        table.remove(updated, index)
        if persist(w2, p2, hosts_path, updated) then hosts = updated; show_hosts(w2, p2) end
      end
    end)
  end, true)
end

local function pane_by_id(tab, id)
  for _, info in ipairs(tab:panes_with_info()) do
    if info.pane:pane_id() == id then return info.pane, info.is_zoomed end
  end
end

local function open_files(window, pane, host)
  local executable = bin_dir .. '/gooeshell-files.exe'
  local exists = io.open(executable, 'rb')
  if not exists then message(window, pane, '文件面板未打包', '同目录需要 gooeshell-files.exe。'); return end
  exists:close()
  local trust_file = host.known_hosts or known_hosts_for(host)
  if not trust_file then message(window, pane, '需要启动器', '请通过 gooeshell.exe 启动后使用仅本次信任。'); return end
  local ok, err = pcall(function()
    local files = pane:split {
      direction = 'Left', size = 0.38, top_level = true, domain = 'DefaultDomain',
      args = { executable, '--host', host.host, '--user', host.user, '--port', tostring(host.port) },
      cwd = wezterm.home_dir,
      set_environment_variables = {
        GOOESHELL_DATA_DIR = data_dir, GOOESHELL_KNOWN_HOSTS = trust_file,
      },
    }
    set_global('files', pane:tab():tab_id(), { file = files:pane_id(), terminal = pane:pane_id() })
    set_global('sessions', files:pane_id(), core.copy(host))
  end)
  if not ok then message(window, pane, '无法打开文件面板', tostring(err)) end
end

handlers.files = function(window, pane)
  local tab = pane:tab()
  local state = global_map('files')[tostring(tab:tab_id())]
  if state then
    local file_pane, file_zoomed = pane_by_id(tab, state.file)
    local terminal, terminal_zoomed = pane_by_id(tab, state.terminal)
    if file_pane and terminal then
      terminal:activate()
      -- Zoom only hides the file pane; active transfers continue in its own process.
      window:perform_action(act.SetPaneZoomState(not (file_zoomed or terminal_zoomed)), terminal)
      return
    end
  end
  local host = session_for(pane)
  if host then open_files(window, pane, host)
  else show_hosts(window, pane, open_files) end
end

local function list_fonts()
  local cached = wezterm.GLOBAL['gooeshell.fonts']
  if cached then return cached end
  local found = { ['JetBrains Mono'] = true, ['Fira Code'] = true, ['Roboto'] = true }
  local ok, stdout = wezterm.run_child_process {
    bin_dir .. '/wezterm.exe', '--config-file', app_dir .. '/gooeshell.lua', 'ls-fonts', '--list-system',
  }
  if ok then
    for name in stdout:gmatch('wezterm%.font%("([^"]+)"') do
      if name:sub(1, 1) ~= '@' then found[name] = true end
    end
  else
    -- Windows ships these families; the CLI may be absent from a development build.
    found.Consolas = true
    found['Microsoft YaHei'] = true
    found['Microsoft JhengHei'] = true
    found.SimSun = true
  end
  local names = {}
  for name in pairs(found) do names[#names + 1] = name end
  table.sort(names)
  wezterm.GLOBAL['gooeshell.fonts'] = names
  return names
end

local font_preview
local function choose_font(window, pane, draft, original, category)
  local preferred = category == 'english_font'
    and { 'DejaVu Sans Mono', 'Consolas', 'JetBrains Mono', 'Cascadia Mono', 'Cascadia Code', 'IBM Plex Mono', 'Ubuntu Mono', 'Fira Code' }
    or { 'Microsoft YaHei', 'Microsoft YaHei UI', 'Noto Sans Mono CJK SC', 'Noto Sans SC', 'Microsoft JhengHei', 'SimSun', 'NSimSun', '黑体', '宋体', '微软雅黑' }
  local all, existing, listed, choices = list_fonts(), {}, {}, {}
  for _, name in ipairs(all) do existing[name] = true end
  for _, name in ipairs(preferred) do
    if existing[name] then choices[#choices + 1] = { id = name, label = name .. '  · 常用' }; listed[name] = true end
  end
  for _, name in ipairs(all) do if not listed[name] then choices[#choices + 1] = { id = name, label = name } end end
  selector(window, pane, category == 'english_font' and '英文字体 · 系统与内置字体' or '中文回退字体 · 系统与内置字体',
    choices, function(w, p, id)
      if not id then show_fonts(w, p, draft, original); return end
      draft[category] = id
      font_preview(w, p, draft, original)
    end, true)
end

font_preview = function(window, pane, draft, original)
  set_font_override(window, draft)
  selector(window, pane, '实时字体预览 · ' .. draft.english_font .. ' / ' .. draft.chinese_font, {
    { id = 'save', label = '保存字体设置' },
    { id = 'larger', label = '字号 +0.5  · 当前 ' .. tostring(draft.font_size) .. ' pt' },
    { id = 'smaller', label = '字号 −0.5' },
    { id = 'back', label = '继续调整字体、字重或中文比例' },
    { id = 'cancel', label = '撤销预览，恢复之前设置' },
  }, function(w, p, id)
    if id == 'save' then
      if save_preferences(w, p, draft) then
        local clean = core.copy(original)
        clean.font, clean.font_size, clean.line_height = nil, nil, nil
        w:set_config_overrides(clean)
      end
    elseif id == 'larger' or id == 'smaller' then
      draft.font_size = math.max(6, math.min(48, draft.font_size + (id == 'larger' and 0.5 or -0.5)))
      font_preview(w, p, draft, original)
    elseif id == 'back' then show_fonts(w, p, draft, original)
    else w:set_config_overrides(original) end
  end, false, '0123456789  Il1O0  abcdefgh ABCDEFGH\n终端中文字体预览  ┌──┬──┐  →  ≠  ✓\n↑↓ 选择 · Enter 确认 · Esc 撤销预览')
end

show_fonts = function(window, pane, draft, original)
  draft = draft or core.copy(prefs)
  original = original or core.copy(window:get_config_overrides() or {})
  selector(window, pane, 'gooeshell · 字体与字号', {
    { id = 'english', label = '英文字体    ' .. draft.english_font },
    { id = 'chinese', label = '中文字体    ' .. draft.chinese_font },
    { id = 'size', label = '字号        ' .. tostring(draft.font_size) .. ' pt' },
    { id = 'weight', label = '英文字重    ' .. draft.font_weight },
    { id = 'scale', label = '中文比例    ' .. string.format('%.2f', draft.chinese_scale) },
    { id = 'preview', label = '实时预览并保存' },
    { id = 'refresh', label = '重新扫描系统字体 / fonts 文件夹' },
  }, function(w, p, id)
    if not id then w:set_config_overrides(original); return end
    if id == 'english' or id == 'chinese' then choose_font(w, p, draft, original, id == 'english' and 'english_font' or 'chinese_font')
    elseif id == 'size' or id == 'scale' then
      local key = id == 'size' and 'font_size' or 'chinese_scale'
      local lower, upper = id == 'size' and 6 or 0.7, id == 'size' and 48 or 1.6
      prompt(w, p, id == 'size' and '字号：6–48 pt，支持小数' or '中文缩放比例：0.7–1.6，不改变终端网格列数',
        tostring(draft[key]), function(w2, p2, input)
          local value = tonumber(input)
          if not value or value < lower or value > upper then message(w2, p2, '数值范围', '请输入范围内的数字。'); w2:set_config_overrides(original); return end
          draft[key] = value
          font_preview(w2, p2, draft, original)
        end, function(w2) w2:set_config_overrides(original) end)
    elseif id == 'weight' then
      selector(w, p, '英文字重', {
        { id = 'Regular', label = '常规 Regular' }, { id = 'Medium', label = '中等 Medium' }, { id = 'Bold', label = '粗体 Bold' },
      }, function(w2, p2, selected)
        if selected then draft.font_weight = selected; font_preview(w2, p2, draft, original)
        else show_fonts(w2, p2, draft, original) end
      end)
    elseif id == 'refresh' then wezterm.GLOBAL['gooeshell.fonts'] = nil; show_fonts(w, p, draft, original)
    else font_preview(w, p, draft, original) end
  end)
end

show_shortcuts = function(window, pane)
  local choices = {}
  for _, command in ipairs(core.commands) do
    choices[#choices + 1] = { id = command.id, label = string.format('%-23s  %s', core.binding_label(bindings[command.id]), command.label) }
  end
  choices[#choices + 1] = { id = 'reset', label = '恢复全部默认快捷键…' }
  selector(window, pane, 'gooeshell · 快捷键（选择一项修改）', choices, function(w, p, id)
    if not id then return end
    if id == 'reset' then
      selector(w, p, '恢复默认快捷键？', { { id = 'yes', label = '恢复默认' }, { id = 'no', label = '取消' } }, function(w2, p2, answer)
        if answer == 'yes' and persist(w2, p2, shortcuts_path, core.bindings(nil)) then wezterm.reload_configuration() end
      end)
      return
    end
    local current = bindings[id]
    if not current then return end
    prompt(w, p, '输入组合键，例如 Ctrl+Shift+E、Ctrl+Alt+K、F11\nCtrl+字母保留给远程程序；Esc 取消。',
      core.binding_label(current), function(w2, p2, input)
        local candidate, err = core.parse_binding(input)
        if not candidate then message(w2, p2, '快捷键格式', err); return end
        local conflict = core.binding_conflict(bindings, id, candidate)
        if conflict then message(w2, p2, '快捷键冲突', core.binding_label(candidate) .. ' 已用于“' .. conflict .. '”。'); return end
        local updated = core.copy(bindings)
        updated[id] = candidate
        if persist(w2, p2, shortcuts_path, updated) then bindings = updated; wezterm.reload_configuration() end
      end)
  end, true, 'Enter 修改 · / 搜索 · 组合键更改立即生效 · 普通输入不等待组合键超时')
end

show_appearance = function(window, pane)
  selector(window, pane, 'gooeshell · 外观与鼠标', {
    { id = 'background', label = '设置本地背景图片…' },
    { id = 'black', label = '恢复纯黑背景' },
    { id = 'show_tab_bar', label = '标签栏：' .. (prefs.show_tab_bar and '显示' or '隐藏') },
    { id = 'show_status', label = '状态提示：' .. (prefs.show_status and '显示' or '隐藏') },
    { id = 'copy_on_select', label = '选择即复制：' .. (prefs.copy_on_select and '开' or '关') },
    { id = 'right_click_paste', label = '右键粘贴：' .. (prefs.right_click_paste and '开' or '关') },
    { id = 'welcome', label = '启动显示操作菜单：' .. (prefs.welcome and '开' or '关') },
  }, function(w, p, id)
    if not id then return end
    local updated = core.copy(prefs)
    if id == 'background' then
      prompt(w, p, '粘贴本地图片完整路径（PNG / JPG 等）；图片亮度固定为 16%，保持文字清楚。', prefs.background_image,
        function(w2, p2, path)
          path = path:gsub('^"(.*)"$', '%1')
          local file = io.open(path, 'rb')
          if not file then message(w2, p2, '找不到图片', '请检查本地路径。'); return end
          file:close()
          updated.background_image = path
          save_preferences(w2, p2, updated)
        end)
    elseif id == 'black' then updated.background_image = ''; save_preferences(w, p, updated)
    else updated[id] = not updated[id]; save_preferences(w, p, updated) end
  end)
end

handlers.menu = function(window, pane)
  selector(window, pane, 'gooeshell · 从这里开始', {
    { id = 'connect', label = '连接服务器          ' .. core.binding_label(bindings.connect) },
    { id = 'hosts', label = '已保存的主机        ' .. core.binding_label(bindings.hosts) },
    { id = 'files', label = '远程文件面板        ' .. core.binding_label(bindings.files) },
    { id = 'fonts', label = '字体与字号          ' .. core.binding_label(bindings.fonts) },
    { id = 'shortcuts', label = '编辑快捷键          ' .. core.binding_label(bindings.shortcuts) },
    { id = 'appearance', label = '外观、背景与鼠标' },
    { id = 'new_tab', label = '新建本地终端        ' .. core.binding_label(bindings.new_tab) },
    { id = 'search', label = '搜索终端输出        ' .. core.binding_label(bindings.search) },
    { id = 'fullscreen', label = '无边框全屏          ' .. core.binding_label(bindings.fullscreen) },
    { id = 'zen', label = '纯终端 / 恢复布局   ' .. core.binding_label(bindings.zen) },
    { id = 'help', label = '使用说明与当前版本边界' },
  }, function(w, p, id) if id and handlers[id] then handlers[id](w, p) end end, true,
    '↑↓ / 搜索 · Enter 打开 · Esc 回到终端 · Ctrl+C 中断，Ctrl+R 使用 Shell 历史')
end

handlers.help = function(window, pane)
  selector(window, pane, 'gooeshell · 原生终端预览版', {
    { id = 'info1', label = 'SSH 登录由 Windows OpenSSH 完成；首次指纹与密码在终端输入。' },
    { id = 'info2', label = '仅本次信任仍检查指纹，临时文件在应用正常退出时清理。' },
    { id = 'info3', label = 'Ctrl+R 和上下键继续使用服务器自己的命令历史；此版不记录密码或按键。' },
    { id = 'info4', label = '终端编码当前为 UTF-8；GBK / Big5 尚未接入。' },
    { id = 'info5', label = '文件面板独立连接；隐藏面板不终止传输，退出面板前先等待任务完成。' },
    { id = 'info6', label = '字体可放 fonts 目录；快捷键支持组合键文本编辑、冲突检查、即时生效。' },
    { id = 'back', label = '返回操作菜单' },
  }, function(w, p, id) if id then handlers.menu(w, p) end end)
end

handlers.connect = function(w, p) connect(w, p) end
handlers.hosts = function(w, p) show_hosts(w, p) end
handlers.fonts = function(w, p) show_fonts(w, p) end
handlers.shortcuts = show_shortcuts
handlers.appearance = show_appearance
handlers.copy = function(w, p) w:perform_action(act.CopyTo 'Clipboard', p) end
handlers.paste = function(w, p) w:perform_action(act.PasteFrom 'Clipboard', p) end
handlers.search = function(w, p) w:perform_action(act.Search { CaseInSensitiveString = '' }, p) end
handlers.new_tab = function(w, p) w:perform_action(act.SpawnTab 'DefaultDomain', p) end
handlers.close_pane = function(w, p) w:perform_action(act.CloseCurrentPane { confirm = true }, p) end
handlers.next_tab = function(w, p) w:perform_action(act.ActivateTabRelative(1), p) end
handlers.previous_tab = function(w, p) w:perform_action(act.ActivateTabRelative(-1), p) end
handlers.fullscreen = function(w, p) w:perform_action(act.ToggleFullScreen, p) end
handlers.zen = function(window, pane)
  local active = global_map('zen')[tostring(window:window_id())]
  local overrides = window:get_config_overrides() or {}
  if active then
    overrides.enable_tab_bar, overrides.window_decorations = nil, nil
    overrides.window_padding = nil
    window:perform_action(act.SetPaneZoomState(active.zoomed), pane)
    set_global('zen', window:window_id(), nil)
  else
    local zoomed = false
    for _, info in ipairs(pane:tab():panes_with_info()) do zoomed = zoomed or info.is_zoomed end
    set_global('zen', window:window_id(), { zoomed = zoomed })
    overrides.enable_tab_bar = false
    overrides.window_decorations = 'RESIZE'
    overrides.window_padding = { left = 4, right = 4, top = 4, bottom = 4 }
    window:perform_action(act.SetPaneZoomState(true), pane)
  end
  window:set_config_overrides(overrides)
end

local function change_size(window, pane, amount)
  local updated = core.copy(prefs)
  updated.font_size = amount == 0 and 13 or math.max(6, math.min(48, updated.font_size + amount))
  if save_preferences(window, pane, updated) then
    local overrides = window:get_config_overrides() or {}
    overrides.font_size = nil
    window:set_config_overrides(overrides)
  end
end
handlers.font_larger = function(w, p) change_size(w, p, 0.5) end
handlers.font_smaller = function(w, p) change_size(w, p, -0.5) end
handlers.font_reset = function(w, p) change_size(w, p, 0) end
for _, direction in ipairs { 'Left', 'Right', 'Up', 'Down' } do
  handlers['focus_' .. direction:lower()] = function(w, p) w:perform_action(act.ActivatePaneDirection(direction), p) end
end

local keys = {}
for _, command in ipairs(core.commands) do
  local id = command.id
  wezterm.on('gooeshell-' .. id, function(window, pane) handlers[id](window, pane) end)
  local binding = bindings[id]
  keys[#keys + 1] = { key = binding.key, mods = binding.mods, action = act.EmitEvent('gooeshell-' .. id) }
end

wezterm.on('format-window-title', function(tab)
  return 'gooeshell  ·  ' .. ((tab and tab.tab_title ~= '' and tab.tab_title) or '终端')
end)

wezterm.on('format-tab-title', function(tab, _, _, _, _, max_width)
  local title = tab.tab_title
  if not title or title == '' then title = '本地终端' end
  return ' ' .. tostring(tab.tab_index + 1) .. '  ' .. wezterm.truncate_right(title, math.max(4, max_width - 6)) .. ' '
end)

wezterm.on('update-status', function(window, pane)
  if not prefs.show_status then window:set_right_status(''); return end
  local session = session_for(pane)
  local label = session and core.target_label(session) or '本地'
  window:set_right_status(wezterm.format {
    { Foreground = { Color = '#77958c' } },
    { Text = ' ' .. label .. '  ·  UTF-8  ·  ' .. core.binding_label(bindings.menu) .. ' 菜单  ' },
  })
end)

wezterm.on('gui-startup', function(cmd)
  local _, pane, window = wezterm.mux.spawn_window(cmd or {})
  if prefs.welcome and os.getenv('GOOESHELL_NO_WELCOME') ~= '1' and not (cmd and cmd.args and #cmd.args > 0) then
    wezterm.time.call_after(0.25, function()
      local gui = window:gui_window()
      if gui then handlers.menu(gui, pane) end
    end)
  end
end)

local config = wezterm.config_builder()
config.font = font(prefs)
config.font_size = prefs.font_size
config.line_height = prefs.line_height
config.font_dirs = { app_dir .. '/fonts' }
config.harfbuzz_features = { 'calt=0', 'clig=0', 'liga=0' }
config.use_ime = true
config.adjust_window_size_when_changing_font_size = false
config.front_end = 'WebGpu'
config.max_fps = 120
config.animation_fps = 1
config.default_cursor_style = 'SteadyBlock'
config.cursor_blink_rate = 0
config.enable_scroll_bar = false
config.scrollback_lines = 10000
config.check_for_updates = false
config.automatically_reload_config = true
config.audible_bell = 'Disabled'
config.window_close_confirmation = 'AlwaysPrompt'
config.window_decorations = 'TITLE|RESIZE'
config.window_background_opacity = 1
config.window_padding = { left = 10, right = 10, top = 8, bottom = 8 }
config.initial_cols = 125
config.initial_rows = 34
config.enable_tab_bar = prefs.show_tab_bar
config.hide_tab_bar_if_only_one_tab = false
config.use_fancy_tab_bar = false
config.tab_max_width = 36
config.tab_bar_at_bottom = false
config.status_update_interval = 1500
config.disable_default_key_bindings = true
config.keys = keys
config.default_prog = { os.getenv('GOOESHELL_DEFAULT_SHELL') or 'powershell.exe', '-NoLogo' }
config.default_cwd = wezterm.home_dir
config.colors = {
  foreground = '#dddddd', background = '#000000', cursor_bg = '#72e0b5', cursor_fg = '#000000',
  selection_bg = '#263b33', selection_fg = '#ffffff', split = '#26322d',
  ansi = { '#1b1b1b', '#ef7474', '#8dc891', '#dfc483', '#7caadc', '#c49edc', '#7ccac2', '#d4d4d4' },
  brights = { '#686868', '#ff9999', '#ace6af', '#f8e0a5', '#a0caff', '#e1b9f5', '#a3e8e0', '#ffffff' },
  tab_bar = {
    background = '#0b0e0c',
    active_tab = { bg_color = '#163127', fg_color = '#9ee4c4', intensity = 'Normal' },
    inactive_tab = { bg_color = '#0b0e0c', fg_color = '#84928b' },
    inactive_tab_hover = { bg_color = '#16231c', fg_color = '#cfddd5' },
    new_tab = { bg_color = '#0b0e0c', fg_color = '#84928b' },
    new_tab_hover = { bg_color = '#163127', fg_color = '#9ee4c4' },
  },
}
config.command_palette_bg_color = '#0b100d'
config.command_palette_fg_color = '#dce6df'
config.command_palette_font_size = 13
if prefs.background_image ~= '' then
  config.window_background_image = prefs.background_image
  config.window_background_image_hsb = { brightness = prefs.background_brightness, saturation = 0.8, hue = 1.0 }
end
config.mouse_bindings = {}
for _, mods in ipairs { 'NONE', 'SHIFT', 'ALT', 'SHIFT|ALT' } do
  for streak = 1, 3 do
    config.mouse_bindings[#config.mouse_bindings + 1] = {
      event = { Up = { streak = streak, button = 'Left' } }, mods = mods,
      action = prefs.copy_on_select and act.CompleteSelection 'Clipboard' or act.Nop,
    }
  end
end
if prefs.right_click_paste then
  config.mouse_bindings[#config.mouse_bindings + 1] = {
    event = { Down = { streak = 1, button = 'Right' } }, mods = 'NONE', action = act.PasteFrom 'Clipboard',
  }
end
return config
