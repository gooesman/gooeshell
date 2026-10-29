# GooeShell CLI

CLI 是运行中桌面程序的轻量客户端，与 MCP 共用桥接、参数校验、现有 SSH 会话、登录身份和 sudo 管理，不另建一套凭据或 SSH 实现。先在**设置 → AI 与 MCP**启用桥接，点击**复制 CLI 命令**。不需要安装 Node.js。

程序随附启动器：Windows 解压目录的 `resources/cli/gooeshell-cli.cmd`；macOS 应用内 `Contents/Resources/cli/gooeshell-cli`；Linux 程序目录的 `resources/cli/gooeshell-cli`。AppImage 需解包后使用内部启动器，不依赖临时挂载目录的长期路径。

在 PowerShell 中调用启动器，例如：

```powershell
& 'D:\Apps\GooeShell\resources\cli\gooeshell-cli.cmd' list-sessions
& 'D:\Apps\GooeShell\resources\cli\gooeshell-cli.cmd' --help
```

开发目录可使用 `npm run cli -- list-sessions`。也可将 `ELECTRON_RUN_AS_NODE=1` 仅设置在当前子进程环境，以内置 Electron 程序运行 `resources/app.asar/dist-main/main/cli.js`。

## 参数与结果

`操作 [JSON参数] [--watch]`，操作名支持连字符或下划线。没有 JSON 参数时使用空对象。`--bridge 文件` 可以选择一个指定的桥接描述文件；默认采用当前用户的 GooeShell 数据目录。描述文件包含本机访问令牌，勿复制到日志或分享。

macOS / Linux 的参数示例：

```sh
./gooeshell-cli list-connections
./gooeshell-cli connect '{"connectionId":"连接编号"}'
./gooeshell-cli run-command '{"sessionId":"会话编号","command":"uname -a","sudo":false}'
./gooeshell-cli start-task '{"sessionId":"会话编号","command":"journalctl -f --no-pager","sudo":true}'
./gooeshell-cli read-task '{"sessionId":"会话编号","taskId":"任务编号"}' --watch
./gooeshell-cli stop-task '{"sessionId":"会话编号","taskId":"任务编号"}'
./gooeshell-cli read-log '{"sessionId":"会话编号","path":"/var/log/app.log"}' --watch
./gooeshell-cli transfer-between-servers '{"sessionId":"源会话","targetSessionId":"目标会话","source":"/data/model.bin","destinationDir":"/srv/models","route":"auto"}'
./gooeshell-cli read-transfer '{"transferId":"传输编号"}' --watch
./gooeshell-cli stop-transfer '{"transferId":"传输编号"}'
```

Windows 的命令行对 JSON 内双引号有不同的转义规则。可用 `@参数文件.json` 传参，避免嵌套转义；文件只填写普通工具参数，不填写密码。例如创建 `{ "sessionId": "会话编号", "command": "uname -a" }` 后运行：

```powershell
& 'D:\Apps\GooeShell\resources\cli\gooeshell-cli.cmd' run-command '@params.json'
```

标准输出是 JSON；`--watch` 每秒查询一次，逐条输出 NDJSON。日志 watch 将下一次偏移量与游标自动接上，不反复读取完整文件；任务 watch 读取最近终端滚动内容，可能重复出现。Ctrl+C 结束观察，不隐式停止远端后台任务；停止任务应调用 `stop-task`。

`run-command`、完成的 `read-task` 返回实际命令退出码；没有退出状态时退出码为 2。调用失败返回 1，取消客户端返回 130。传输启动只表示进入队列；以 `read-transfer` 的最终状态为准。使用 `--help` 查看所有工具和参数说明，完整参数表见 [MCP](MCP.md)。

## 体验与性能边界

长期 AI 会话适合复用 MCP stdio 进程；一次性脚本适合 CLI。CLI 省去 MCP 协议适配，但每次启动仍有进程和模块加载成本，不能保证比已预热的 MCP 更快。两者共用后端，所以不会因为换成 CLI 就自动提高远程传输带宽。
