# 本机 MCP 连接桥接

在 GooeShell“设置 → AI 与 MCP”中启用桥接，复制 Codex 配置到客户端的 MCP 配置文件；其他支持本机 stdio 的客户端可使用通用 JSON 配置。配置中的程序和脚本路径必须保留，升级后如果安装目录变化，需要重新复制。GooeShell 需要保持运行，不需要另行安装 Node.js。

开关默认关闭。启用后，受信任的本机客户端可以使用所有已保存 SSH 连接及其登录身份、私钥、Agent、跳板机和 sudo 配置。MCP 不接收或返回保存的密码。客户端适配器通过本机回环地址和每次启动重新生成的访问令牌与应用通信，配置中只记录适配器和本机状态文件路径。

桥接运行期间每 5 秒检查一次本机状态文件；打开 MCP 设置时也会立即检查。状态文件缺失、损坏或被旧记录覆盖时，恢复当前端口和令牌，不重启 SSH 连接、不重复执行命令。应用退出后不再恢复文件，重新启动时生成新的令牌；客户端每次调用都会读取最新记录。连接失败会显示本机端口和检查方法，不返回令牌。

## Windows 客户端读到旧端口

如果 GooeShell 已运行，重启和重新复制配置后客户端仍报告同一个旧端口，先对照桌面文本编辑器与客户端读取的 `mcp-bridge.json`。只核对端口，不公开其中的访问令牌。

已在 Windows 商店版 Codex 中确认过一种情况：程序读取 `%APPDATA%\gooeshell\mcp-bridge.json` 时，实际命中自己包目录 `LocalCache\Roaming\gooeshell\mcp-bridge.json` 中的过期副本；GooeShell 更新的则是真实 Roaming 目录。两者路径看似相同，但端口和令牌不同，所以桥接自身的文件修复不能更新客户端私有副本。

可在客户端执行环境的 PowerShell 中查看实际文件位置：

```powershell
fsutil hardlink list "$env:APPDATA\gooeshell\mcp-bridge.json"
```

若结果指向 `AppData\Local\Packages\OpenAI.Codex_…\LocalCache\Roaming\gooeshell`，并确认它与桌面程序读取的记录不同，先备份，再移出该目录中这一份过期的 `mcp-bridge.json`。客户端随后可重新读取真实文件；本次恢复无需修改 MCP 配置或重启 SSH。不要清理整个包缓存或复制令牌到配置里，也不要通过客户端手工改写 Roaming 下的桥接记录，以免重新生成私有副本。无法确认文件位置时先保留原文件排查。

## 可用操作

| 操作 | 参数 | 结果 |
| --- | --- | --- |
| `list_connections` | 无 | 保存的连接编号、名称、地址、用户名和登录身份名称 |
| `list_sessions` | 无 | 当前 SSH 会话编号；`source=terminal` 属于普通终端，`source=mcp` 属于桥接 |
| `list_connection_options` | 无 | 可用于新建连接的分组和共享登录身份的编号、名称、用户名及密码是否已保存，不包含密码 |
| `create_connection` | `host`；可选 `name`、`port`、`username`、`auth`、`privateKeyPath`、`loginIdentityId`、`groupId`、`icon`、`encoding`、`favorite`、`shellIntegration` 和 `jumpHost` | 保存 SSH 连接并返回编号与 `created`；默认收藏，不建立连接 |
| `connect` | `connectionId`；可选 `hostKeyPolicy`：`once`（默认）或 `save` | 优先复用同配置的已连接会话；否则使用保存的身份在后台建立连接 |
| `run_command` | `sessionId`、`command`；可选 `cwd`、`sudo`、`timeoutMs` | `stdout`、`stderr`、`exitCode`、`signal`、`truncated` |
| `start_task` | `sessionId`、`command`；可选 `cwd`、`sudo` | `taskId`、tmux 会话/窗口/窗格编号、当前真实状态与退出码 |
| `read_task` | `sessionId`、`taskId`；可选 `tailLines`（默认 200，范围 1–1000） | `running` / `finishing` / `exited`、`exitCode`、`signal`、最近合并输出及截断标记 |
| `stop_task` | `sessionId`、`taskId` | 停止受管任务并等待真实退出；早期未启用托管停止的任务需手动停止 |
| `read_log` | `sessionId`、绝对 `path`；可选 `offset`、`cursor`、`maxBytes` | 最多 16 KiB 的 UTF-8 增量、下一偏移量、游标、EOF 和轮转 / 截断重置状态 |
| `read_remote_text` | `sessionId`、绝对 `path`；可选 `encoding` | 读取远程文本、版本、编码、BOM 与换行信息 |
| `write_remote_text` | `sessionId`、`path`、`text`、`encoding`、`expectedRevision`；可选 `bom` | 创建或完整保存远程文本；版本不一致时拒绝覆盖 |
| `edit_remote_text` | `sessionId`、`path`、`expectedRevision`、`oldText`、`newText`；可选 `encoding` | 精确替换一处原文，保留其余内容和编码；原文必须恰好出现一次 |
| `transfer_file` | `sessionId`、`direction`、`source`、`destinationDir`；可选 `resume`、`mode` | 本机上传 / 下载进入队列，返回 `transferId` |
| `transfer_between_servers` | `sessionId`、`targetSessionId`、绝对 `source`、绝对 `destinationDir`；可选 `route` | 直推 / 反向拉取进入队列，返回 `transferId` |
| `read_transfer` | `transferId` | 传输、校验、速度和路线状态；最近 200 项在程序运行期间保留 |
| `stop_transfer` | `transferId` | 请求取消；之后使用 `read_transfer` 确认结束 |
| `show_in_app` | `kind=activity`；或 `kind=task` 与 `sessionId`、`taskId`；或 `kind=log` 与 `sessionId`、绝对 `path`；或 `kind=transfer` 与 `transferId` | 请求在 GooeShell 显示命令活动、任务输出、跟踪日志或展开传输队列 |

AI 通过 `connect` 建立新连接时默认使用 `hostKeyPolicy=once`：自动接受目标服务器和跳板机给出的指纹，本次不核验已保存指纹，也不保存新指纹。仅当用户明确要求持久保存时使用 `hostKeyPolicy=save`；它会接受并保存本次目标服务器及跳板机指纹，已有不同记录会被替换。为了确保保存实际生效，`save` 会建立新的桥接连接，而不复用已有会话。**自动接受指纹不能验证服务器身份，可能将登录凭据交给冒充服务器；同一会话的后续连接仍会检查指纹是否改变。**普通桌面连接的确认方式和已有地址策略不受影响。没有可用密码时会返回 `AUTH_REQUIRED`，请在应用中连接或保存该连接的凭据，再重试；不用把密码写进聊天内容。

## 新建连接

先用 `list_connection_options` 查找已有共享登录身份和侧边栏分组的编号，再调用 `create_connection`。`port` 默认 22，`auth` 默认 `password`；选用共享登录身份时使用 `loginIdentityId`，用户名由该身份提供。也可传入用户名并选择 `key`（`privateKeyPath` 为本机绝对路径）或 `agent`。`jumpHost` 可提供一层跳板机的 `host`、`port`、`username`、`auth`、`privateKeyPath`、`loginIdentityId`、`rememberHost` 和 `reuseConnection`；默认端口 22、记住指纹、允许复用。目标连接支持 `groupId`、图标、编码、侧边栏收藏和 Bash 命令识别选项。

接口不会接收密码、sudo 密码、私钥内容或口令。需要这些凭据时，请在 GooeShell 中保存身份或连接时输入。接口不建立 SSH 会话、不修改已有地址的指纹策略；AI 随后调用 `connect` 时按上面的指纹选项处理。相同地址、端口、身份验证及跳板机配置会返回已有连接（`created=false`），不会改写名称、收藏或凭据；同一地址的不同账号或身份可以分别保存。随后需要连接时，使用返回的 `connectionId` 调用 `connect`。CLI 操作名为 `list-connection-options` 和 `create-connection`。

## 在窗口中查看 AI 活动

顶部“AI”活动按钮可展开独立面板。短命令显示命令文本、实时输出及实际退出码，后台任务显示启动状态并可点击查看；不会向已有终端输入内容。AI 也可使用 `show_in_app` 请求显示指定后台任务或持续跟踪普通日志文件；面板展开时约每两秒刷新，收起后停止读取。传输可通过同一接口展开现有文件管理与传输队列，查看进度、速度和剩余时间。

活动记录仅保存在当前程序运行期间，最多保留最近 40 条。短命令输出受 64 KiB 上限约束，远程日志显示最近约 64 KiB；后台任务内容是 tmux 最近输出，并非完整日志。日志与任务依赖对应 SSH 会话；面板会显示读取错误和未知退出状态，不会把未知状态当成成功。

## 在服务器上编辑文本

AI 可以使用 `read_remote_text` 读取目标文件，然后使用返回的 `revision` 调用 `edit_remote_text` 做精确替换；也可以使用 `write_remote_text` 和读取结果中的 `revision`、`encoding`、`bom` 保存完整内容。创建新文件时使用 `expectedRevision="missing"`，如果文件已存在则拒绝覆盖。保存成功返回新的版本和字节数，接下来的修改需使用新版本。工具通过既有 SSH/SFTP 连接直接读写服务器文件，不需要在本机创建脚本文件。

文件改变、删除或替换后会返回 `TEXT_CONFLICT`，应重新读取和比较，不能盲目重试覆盖。精确替换的原文不存在或出现多次时返回 `TEXT_MATCH_ERROR`；可以提供更多上下文后重试。原文件的编码、BOM 和未修改部分的换行会保留；非 UTF-8 且没有 BOM 的文件，需要显式指定 `encoding`。单个文件最多编辑 2 MiB，更大文件只能预览；单次 MCP 桥接请求最多 256 KiB，因此大文件宜分次做精确替换。CLI 使用相同操作，名称改用连字符，例如 `read-remote-text`。

这三个操作使用连接用户的普通文件权限，不使用 sudo，只支持普通文本文件；需要提权时使用现有终端或桌面编辑器的 sudo 操作。新建文件采用普通编辑器的 0600 权限，不自动加执行位。远程权限、服务器的 SFTP 原子替换支持、ACL / 扩展属性，以及外部进程在最终检查与替换之间写入的竞争窗口，仍受现有编辑器的限制。若请求中断或超时，保存结果可能未知，应先重新读取再决定下一步。

## 执行命令

每次 `run_command` 使用同一 SSH 连接上的独立执行通道和新的 `/bin/sh`。普通终端的当前输入、目录和环境变量不会被这一通道接管。需要指定目录时传入 `cwd`；本版面向有 `/bin/sh` 的远程服务器，不操作本地终端。

命令默认最长执行 30 秒，可设置 100–60,000 毫秒。stdout 与 stderr 合计保留至多 64 KiB，超过后 `truncated=true`；大日志可使用 `read_log` 按偏移量持续读取。退出码非零仍作为命令结果返回；启动、超时、取消和连接错误才是工具调用错误。没有收到远端退出状态时 `exitCode=null`，不猜测成功。

`sudo=true` 使用 GooeShell 保存的登录密码或独立 sudo 密码；没有保存密码时尝试服务器已有的免密授权。密码经独立 SSH 标准输入传入，不出现在命令参数中。被授权命令的 stdin 固定为空，避免 sudo 已缓存时把未读取的密码传给命令。本版不提供交互式输入，也不向 tmux 既有窗格的密码提示自动填入密码。

## 后台任务与安全 sudo

短命令继续使用 `run_command`，不需要 tmux。长时间或需要人在终端查看的命令使用 `start_task`，例如 `command="journalctl -f -n 30 --no-pager"`；需要提权时同时传 `sudo=true`。服务器需安装 tmux 和 Python 3，未安装会明确报错，不会自动安装。

每个任务创建独立窗口，放在 `gooeshell-ai` 会话内；不会向用户当前窗格输入命令。`start_task` 返回 `taskId` 后，使用 `read_task` 获取实际完成状态：只有 `state=exited` 且 `exitCode=0` 才能判定成功。外层 Shell 等待任务并把实际等待状态写入该窗格的私有选项，信号终止采用 Shell 状态（例如 SIGTERM 为 143）；不会据此猜测信号名称。tmux 能提供外层终止信号时才填充 `signal`。终端已关闭、但退出状态尚未收到时返回 `finishing` 与 null，稍后再查；旧版 tmux 的外层进程被强制杀死时，状态可能无法补齐，不推测成功。快速失败的命令可直接在启动结果中返回失败退出码；不把“任务已创建”当成“命令成功”。查询间隔由客户端安排，避免连续轮询。

sudo 密码只经 SSH 标准输入和一次性 FIFO（命名管道）传递。管道位于随机的 0700 临时目录内，创建时使用 077 权限掩码；密码不写入普通文件、命令参数、环境变量、tmux 输入缓冲或 Shell 历史。接收端打开后立即移除管道路径和目录；被授权命令的 stdin 固定为空，并关闭传递用文件描述符，因此认证缓存/免密分支未读取的密码不会流入任务。服务器原有 sudo 权限及 requiretty 规则仍有效，不修改 sudoers。

`stop_task` 通过任务标识定位本版创建的受管窗格，向专用进程组发送终止信号，必要时强制停止，并等待实际退出状态。主动脱离进程组或自行守护化的后代不在保证范围内；旧版任务需在终端手动停止。

`read_log` 读取普通文件，不跟随符号链接；将上次 `nextOffset` 和 `cursor` 一起传给下一次调用。轮转、更短截断和边界内容变化会返回 `reset=true` 并从新文件开始；如果截断后重新增长并保留相同的边界内容，无法保证检测出来。文件采用 UTF-8，无法解码的字节会替换。`--watch` 的使用见 [CLI](CLI.md)。

运行 `tmux attach -t gooeshell-ai` 可以查看任务。完成的窗格会保留，便于核对输出；可用 tmux 正常关闭不再需要的窗口。输出是最近的终端滚动内容（stdout/stderr 合并，可能含 tmux 的完成提示），并非完整持久日志；重要长日志由命令自行保存到合适文件。删除窗格或重启 tmux 后无法恢复其退出状态，会明确报错。重新连接同一服务器、同一用户后可用新的 `sessionId` 查询原 `taskId`。

任务启动超时或连接中断时，任务可能已经启动；先查看 `gooeshell-ai`，不要直接重试造成重复执行。该功能适合非交互命令，不向任意既有 tmux 窗格的密码提示填入密码。

## 手动 tmux 工作方式

长任务通过 tmux 持续运行。例如先使用 `connect` 得到 `sessionId`，然后调用 `run_command`：

```sh
tmux has-session -t '=gooeshell-ai' 2>/dev/null || tmux new-session -d -s gooeshell-ai
tmux split-window -d -P -F '#{pane_id}' -t gooeshell-ai:0
```

第二条命令返回新窗格编号，例如 `%1`。之后始终指定此编号：

```sh
tmux send-keys -t %1 -l 'tail -n 200 /var/log/app.log'
tmux send-keys -t %1 Enter
tmux capture-pane -p -S -200 -t %1
```

使用同一登录用户，在普通终端运行 `tmux attach -t gooeshell-ai` 即可查看。按服务器配置的脱离快捷键返回自己的 Shell；tmux 默认是 Ctrl+B 再按 D。MCP 不创建额外任务数据库，任务、窗口和滚动历史由 tmux 管理。工具返回的是 tmux 控制命令的退出码，长期任务的执行结果需再读取相应窗格。

关闭桥接会撤销在途请求并释放桥接自己新建的 SSH 连接，保留普通终端连接；独立 tmux 任务继续在服务器运行。AI 继续调度、分析日志需要客户端和 GooeShell 保持在线。该本机 stdio 配置不能直接给云端 API 使用。

## 文件传输

本机上传下载使用 `transfer_file`；两台远程 Linux 服务器之间选择 `transfer_between_servers`。后者的文件数据不经过本机，首版依赖 rsync / rrsync 和 SSH 临时授权。路线、认证、续传、校验及限制见[服务器之间传输文件](SERVER-TRANSFER.md)。两种任务启动后均通过 `read_transfer` 查询，速度只代表传输阶段，不包括校验；使用 `stop_transfer` 发出取消请求，再查询最终状态。
