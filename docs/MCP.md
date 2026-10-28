# 本机 MCP 连接桥接

在 GooeShell“设置 → AI 与 MCP”中启用桥接，复制 Codex 配置到客户端的 MCP 配置文件；其他支持本机 stdio 的客户端可使用通用 JSON 配置。配置中的程序和脚本路径必须保留，升级后如果安装目录变化，需要重新复制。GooeShell 需要保持运行，不需要另行安装 Node.js。

开关默认关闭。启用后，受信任的本机客户端可以使用所有已保存 SSH 连接及其登录身份、私钥、Agent、跳板机和 sudo 配置。MCP 不接收或返回保存的密码。客户端适配器通过本机回环地址和每次启动重新生成的访问令牌与应用通信，配置中只记录适配器和本机状态文件路径。

桥接运行期间每 5 秒检查一次本机状态文件；打开 MCP 设置时也会立即检查。状态文件缺失、损坏或被旧记录覆盖时，恢复当前端口和令牌，不重启 SSH 连接、不重复执行命令。应用退出后不再恢复文件，重新启动时生成新的令牌；客户端每次调用都会读取最新记录。连接失败会显示本机端口和检查方法，不返回令牌。

| 操作 | 参数 | 结果 |
| --- | --- | --- |
| `list_connections` | 无 | 保存的连接编号、名称、地址、用户名和登录身份名称 |
| `list_sessions` | 无 | 当前 SSH 会话编号；`source=terminal` 属于普通终端，`source=mcp` 属于桥接 |
| `connect` | `connectionId` | 优先复用同配置的已连接会话；否则使用保存的身份在后台建立连接 |
| `run_command` | `sessionId`、`command`；可选 `cwd`、`sudo`、`timeoutMs` | `stdout`、`stderr`、`exitCode`、`signal`、`truncated` |
| `start_task` | `sessionId`、`command`；可选 `cwd`、`sudo` | `taskId`、tmux 会话/窗口/窗格编号、当前真实状态与退出码 |
| `read_task` | `sessionId`、`taskId`；可选 `tailLines`（默认 200，范围 1–1000） | `running` / `finishing` / `exited`、`exitCode`、`signal`、最近合并输出及截断标记 |

首次服务器指纹继续在 GooeShell 窗口中确认。没有可用密码时会返回 `AUTH_REQUIRED`，请在应用中连接或保存该连接的凭据，再重试；不用把密码写进聊天内容。

## 执行命令

每次 `run_command` 使用同一 SSH 连接上的独立执行通道和新的 `/bin/sh`。普通终端的当前输入、目录和环境变量不会被这一通道接管。需要指定目录时传入 `cwd`；本版面向有 `/bin/sh` 的远程服务器，不操作本地终端。

命令默认最长执行 30 秒，可设置 100–60,000 毫秒。stdout 与 stderr 合计保留至多 64 KiB，超过后 `truncated=true`；大日志应在服务器先筛选或使用 `tail`。退出码非零仍作为命令结果返回；启动、超时、取消和连接错误才是工具调用错误。没有收到远端退出状态时 `exitCode=null`，不猜测成功。

`sudo=true` 使用 GooeShell 保存的登录密码或独立 sudo 密码；没有保存密码时尝试服务器已有的免密授权。密码经独立 SSH 标准输入传入，不出现在命令参数中。被授权命令的 stdin 固定为空，避免 sudo 已缓存时把未读取的密码传给命令。本版不提供交互式输入，也不向 tmux 既有窗格的密码提示自动填入密码。

## 后台任务与安全 sudo

短命令继续使用 `run_command`，不需要 tmux。长时间或需要人在终端查看的命令使用 `start_task`，例如 `command="journalctl -f -n 30 --no-pager"`；需要提权时同时传 `sudo=true`。服务器需安装 tmux，未安装会明确报错，不会自动安装。

每个任务创建独立窗口，放在 `gooeshell-ai` 会话内；不会向用户当前窗格输入命令。`start_task` 返回 `taskId` 后，使用 `read_task` 获取实际完成状态：只有 `state=exited` 且 `exitCode=0` 才能判定成功。外层 Shell 等待任务并把实际等待状态写入该窗格的私有选项，信号终止采用 Shell 状态（例如 SIGTERM 为 143）；不会据此猜测信号名称。tmux 能提供外层终止信号时才填充 `signal`。终端已关闭、但退出状态尚未收到时返回 `finishing` 与 null，稍后再查；旧版 tmux 的外层进程被强制杀死时，状态可能无法补齐，不推测成功。快速失败的命令可直接在启动结果中返回失败退出码；不把“任务已创建”当成“命令成功”。查询间隔由客户端安排，避免连续轮询。

sudo 密码只经 SSH 标准输入和一次性 FIFO（命名管道）传递。管道位于随机的 0700 临时目录内，创建时使用 077 权限掩码；密码不写入普通文件、命令参数、环境变量、tmux 输入缓冲或 Shell 历史。接收端打开后立即移除管道路径和目录；被授权命令的 stdin 固定为空，并关闭传递用文件描述符，因此认证缓存/免密分支未读取的密码不会流入任务。服务器原有 sudo 权限及 requiretty 规则仍有效，不修改 sudoers。

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
