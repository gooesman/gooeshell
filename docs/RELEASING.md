# 正式发布流程

源码提交、本地打包与 GitHub Release 是三件不同的事。`main` 更新不会自动把 Releases 的 Latest 改成源码版本。

## 本机 Windows 交付与清理

1. 按功能变更更新使用说明，在 [验证记录](../VALIDATION.md) 写明实际测试、跳过项和已知限制。补录历史版本时附原始构建链接，注明用户反馈的来源。
2. 解压最终 ZIP 并实际启动。记录版本、源码提交号、字节数和 SHA-256。将验收过的 ZIP、构建清单和校验文件与本机正式版放在一起。
3. 核对日常桌面入口、Codex 和 WorkBuddy 的 MCP 配置。用 Codex 注册的配置检查握手版本、工具列表和桥接响应。对上一正式版执行回退入口的只读检查。把本次结果补入验证记录。
4. 保留当前版和可回退的上一版。检查运行进程、快捷方式与 MCP 配置引用的绝对路径，清理已停用的更早版本、试用版、重复 ZIP、临时构建和测试输出。把仍有用的验收报告归入对应版本目录。旧会话仍在使用的目录写入验证记录，下次清理时复查。
5. 逐项核对清理范围。保留用户配置、私钥、素材、移动原型及用途未确认的诊断文件。清理结束后再次核对当前入口、回退入口和两份正式包。公开发布仍遵循下方流程。

## 构建与验收

1. 更新 `desktop/package.json`、锁文件根版本及 README 版本，并编写 `.github/release-notes/v版本.md`。
2. 推送到 `main`，运行 **GooeShell Desktop**（`.github/workflows/gooeshell-windows.yml`）。手动构建可用于诊断，但正式发布脚本要求成功的 main 分支 push 构建。
3. Windows x64 执行回环 SSH/SFTP、生产构建、真实界面回归和成品启动。生成便携 ZIP，解压核对版本、架构、资源、源码提交与包内容，实际启动解压的程序。
4. Linux 独立任务在 Ubuntu 上验证回环 SSH/SFTP、服务器间直传及断点校验，在隔离容器中测试无 tmux 时的 sudo 受管任务。两项任务都须成功。
5. 构建产物包含版本、提交号、平台、架构、安装包校验和与验收记录。只上传生成文件不等于验收成功。

## 发布 Release

在 Actions 运行 **Publish GooeShell release**（`gooeshell-release.yml`），填写成功的构建 run ID 与稳定版本号，例如：

```sh
gh workflow run gooeshell-release.yml --repo gooesman/gooeshell \
  -f source_run=成功的构建ID -f version=1.3.5
```

PowerShell 可将上面的命令写成一行。发布脚本 `.github/scripts/publish-gooeshell.mjs` 检查构建来源、版本和两个任务的结果，再下载 Windows 构建产物。版本、提交号、最终 ZIP 启动记录、字节数和 SHA-256 均须匹配。随后创建或恢复草稿，上传 ZIP、校验文件与构建记录，核对三项附件后标记为 Latest。原版本的公开 Release 和标签继续保留。

## 验证结果

```sh
gh release view v1.3.5 --repo gooesman/gooeshell
gh release list --repo gooesman/gooeshell
```

确认 Latest 指向目标正式版本，包含 `GooeShell-版本-win-x64.zip`、`SHA256-win-x64.txt` 和 `BUILD-win-x64.json`。从公开 Release 下载 Windows ZIP，核对大小、SHA-256 和构建提交，再在隔离配置中解压启动。更新本机版本时也要核对桌面和 MCP 入口。

2026-10-28 排查发现 Releases 长期停在 1.0.3：后续仅同步源码和本地成品，云端界面测试还存在异步加载断言和测试替身接口缺失，未完成四平台验收与正式发布。本次整理保留这道验收门槛并修复测试同步问题。
