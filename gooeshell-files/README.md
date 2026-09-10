# gooeshell-files

gooeshell 的独立 SFTP 文件面板，使用 Rust、termwiz 和 ssh2。由主程序在分屏中启动，网络及文件任务不会占用终端主程序的输入线程。

```text
gooeshell-files --host example.com --user alice --port 22
gooeshell-files --host example.com --user alice --identity C:\Users\alice\.ssh\id_ed25519 --path /home/alice
```

`GOOESHELL_KNOWN_HOSTS` 指定当前连接的主机指纹文件；未提供时使用 `GOOESHELL_DATA_DIR/known_hosts`，再回退到本机应用数据目录。主机身份在发送凭据之前校验。首次连接支持仅本次信任、保存和拒绝；已保存的密钥不匹配时中止。密码及私钥口令只在面板中无回显输入，不支持 CLI 或环境变量传密码。

未提供 `--identity` 时先尝试 SSH Agent；未完成认证时显示 **P 密码 / K 私钥文件 / Esc 取消**。私钥选择框可预填本机现有的 `~/.ssh/id_ed25519`，只有用户明确选择后才用于认证，不会自动枚举并提交其他身份。私钥文件和 CLI 指定身份共用口令处理，认证失败时显示原因并可返回选择。首版文件面板不会自动读取 OpenSSH 的 `IdentityFile` 设置；使用此类服务器时可在面板中选择相应私钥。

按键：方向键选择，Enter 打开目录，Backspace 返回上级，G 输入路径，R 刷新，U 上传，D 下载，Q 关闭。列表仅绘制可见行；目录查询仍一次性获取全部条目。

传输以 64 KiB 分块进行，Esc / Ctrl+C 可在块间取消，单次 SSH 调用最长等待约 10 秒。传输保留 `.gooeshell.part` 文件；再次选择相同源和目标时明确询问，逐字节校验已有前缀后继续，完成时再次比对源和目标全部内容并检查大小、修改时间。该验证会增加网络流量。首版不覆盖已有目标文件，不支持文件夹递归传输、后台队列或自动断网重连。仅支持 UTF-8 远程路径。

下载通过同目录硬链接发布结果，避免覆盖现有目标；不支持硬链接的本地文件系统会保留完整 `.part` 并报错。上传明确禁用 SFTP rename 的 overwrite 标志；服务器需支持 SFTP v3 普通文件读写。并发修改源文件仍应避免，本功能不构成远程文件快照。

开发检查：`cargo test -p gooeshell-files`、`cargo build -p gooeshell-files --release`。测试覆盖跨平台路径、显示宽度、错误续传前缀和块间取消；真实 SSH、输入法与 GUI 行为仍需连接测试环境验证。
