# gooeshell 原生终端预览版

解压完整便携包后双击 `gooeshell.exe`。也可以右键运行本目录的 `start.ps1`，或执行 `powershell -ExecutionPolicy Bypass -File .\gooeshell\start.ps1`。启动器只在本机启动终端，不会自动连接服务器。默认打开本地 PowerShell 并读取正常的用户配置。

按 `Ctrl+Shift+P` 打开中文操作菜单；按 `Esc` 返回终端。首次连接输入 `root@192.168.1.10:22`，IPv6 使用 `root@[2001:db8::1]:22`。SSH 的真实主机指纹与密码提示出现在新标签里。

| 操作 | 默认快捷键 |
| --- | --- |
| 操作菜单 | Ctrl+Shift+P |
| 新建 SSH 连接 / 已保存主机 | Ctrl+Shift+N / Ctrl+Shift+O |
| 远程文件面板 / 隐藏或恢复 | Ctrl+Shift+E |
| 字体与字号 / 编辑快捷键 | Ctrl+Shift+逗号 / Ctrl+Shift+K |
| 复制 / 粘贴 | Ctrl+Shift+C / Ctrl+Shift+V |
| 搜索终端输出 | Ctrl+Shift+F |
| 新建本地终端 / 关闭当前面板 | Ctrl+Shift+T / Ctrl+Shift+W |
| 下一个 / 上一个标签 | Ctrl+Tab / Ctrl+Shift+Tab |
| 增大 / 减小 / 恢复字号 | Ctrl+= / Ctrl+- / Ctrl+0 |
| 无边框全屏 | F11 |
| 纯终端与恢复布局 | Ctrl+Shift+F11 |
| 聚焦相邻面板 | Ctrl+Shift+方向键 |

字体设置列出系统字体、内置字体以及 `fonts/` 中的字体文件。可分别选择英文和中文回退字体，调整字号、英文字重、中文比例，并在保存前实时预览。背景默认为纯黑，可在操作菜单中换成本地图片。

快捷键编辑器列出当前映射，选择后输入如 `Ctrl+Shift+E` 的组合；修改前检查重复和输入冲突，保存后立即生效。首版使用组合键文本编辑，不提供任意按键捕捉。`Ctrl+C`、`Ctrl+R`、tmux 的 `Ctrl+B` 等原样交给终端。快捷键文件为 `data/shortcuts.json`，可以复制迁移；手工修改文件后重启。

主机列表只保存用户名、主机、端口与信任偏好。永久主机指纹保存在 `data/known_hosts`。选择“仅本次信任”时，指纹写入本次启动专用的临时文件，仍会检查主机身份；应用正常退出时启动器删除这个文件。系统崩溃或强制终止启动器时临时文件可能保留在 `data/sessions/`。终端连接与文件面板共用选定的指纹文件，但使用独立 SSH 连接。

远程文件面板需要同包内的 `gooeshell-files.exe`。隐藏面板使用终端缩放，不结束后台任务。文件传输与终端分别连接，文件面板可能需要再次认证。

当前终端按 UTF-8 工作。命令历史继续使用远端 Shell 自己的上下键与 `Ctrl+R`；应用尚未建立跨服务器历史数据库，也未提供一键部署公钥或传统编码转换。此版不在后台抓取终端按键。

数据与设置都保存在本目录的 `data/` 中，带密码的会话无需导出。目录需可写。`preferences.json.bak` 与 `shortcuts.json.bak` 保留最近一次设置备份。
