# 配置与备份

程序名称为 **GooeShell**，内部应用标识和配置目录继续使用 `gooeshell`，以保留旧版连接和系统加密凭据的兼容性。

| 系统 | 默认目录 |
| --- | --- |
| Windows | `%APPDATA%\gooeshell` |
| macOS | `~/Library/Application Support/gooeshell` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/gooeshell` |

配置位于当前系统用户目录，不放在所有用户共用的 `.ssh` 目录。`--user-data-dir` 可显式指定独立配置；开发测试应使用临时目录。

| 文件或目录 | 内容 |
| --- | --- |
| `connections.json` | 服务器、跳板机快照、收藏、分组和最近连接。 |
| `settings.json` | 字体、主题、快捷键、外部编辑器等设置。 |
| `known-hosts.json` | 保存的服务器指纹。 |
| `host-key-preferences.json` | 按地址和端口保存的指纹策略。 |
| `credentials.encrypted.json` | 系统加密的长期密码、sudo 密码和私钥口令。 |
| `login-identities.json` | 共享身份名称、用户名、版本及加密的长期密码。 |
| `keys/` | 应用内生成的密钥；已有外部私钥仍在原路径。 |
| `command-library.json` | 命令及其分组；命令正文不加密。 |
| `external-editor/` | 外部编辑草稿、回传基线和冲突备份。 |
| `mcp-bridge.json` | 本机桥接状态、运行端口与访问令牌；不要公开或手动复制到其他设备。 |

部分文件在首次使用对应功能后才创建。应用不读取或修改 OpenSSH 的 `~/.ssh/config` 和 `~/.ssh/known_hosts`。

## 密码保存

“本次使用期间记住”仅在进程内保留，退出或重启后需重新输入。“长期记住 · 系统加密”可跨重启使用；密钥依赖操作系统用户和系统安全存储，不能保证将密文复制到另一台电脑后仍可解密。

Windows 使用系统加密，macOS 使用系统钥匙串支持的加密，Linux 需要可用的 libsecret / KWallet。安全存储不可用时，可以选择本次记住；程序不降级为明文保存。

## 备份与升级

先退出 GooeShell，复制整个配置目录，并另行备份应用外的私钥。目录可能包含草稿、敏感命令和凭据数据，备份应按私人数据保管。

替换安装包或删除旧程序目录不会主动清理配置。升级到不同安装目录后，重新复制 MCP 接入配置；其中的程序和脚本路径需要与新位置一致。不要将临时 `mcp-bridge.json` 当作长期连接配置恢复。
