# 正式发布流程

源码提交、本地打包与 GitHub Release 是三件不同的事。`main` 更新不会自动把 Releases 的 Latest 改成源码版本。

## 本机 Windows 交付与清理

1. 按功能变更更新使用说明，在 [验证记录](../VALIDATION.md) 写明实际测试、跳过项和已知限制。补录历史版本时附原始构建链接，注明用户反馈的来源。
2. 解压最终 ZIP 并实际启动。记录版本、源码提交号、字节数和 SHA-256。将验收过的 ZIP、构建清单和校验文件与本机正式版放在一起。
3. 核对日常桌面入口、Codex 和 WorkBuddy 的 MCP 配置。用 Codex 注册的配置检查握手版本、工具列表和桥接响应。对上一正式版执行回退入口的只读检查。把本次结果补入验证记录。
4. 保留当前版和可回退的上一版。检查运行进程、快捷方式与 MCP 配置引用的绝对路径，清理已停用的更早版本、试用版、重复 ZIP、临时构建和测试输出。把仍有用的验收报告归入对应版本目录。旧会话仍在使用的目录写入验证记录，下次清理时复查。
5. 逐项核对清理范围。保留用户配置、私钥、素材、移动原型及用途未确认的诊断文件。清理结束后再次核对当前入口、回退入口和两份正式包。公开发布仍遵循下方流程。

## 从本机发布正式版

1. 更新版本号、README 和 `.github/release-notes/v版本.md`，将构建使用的源码推送到 `main`。
2. 在 Windows 上构建并运行相关回归。用 `ci-package-check.mjs` 解压并启动最终 ZIP，核对架构、版本、资源、提交号和应用内容，再用 `ci-artifacts.mjs collect win x64` 生成构建记录和 SHA-256。已在本机交付时验收过的同一份 ZIP 可以直接使用。涉及 Linux 远端功能时，记录隔离 Linux 环境的实际测试结果。
3. 在仓库根目录执行下面的命令，将末尾的目录换为对应版本。脚本核对 ZIP 与验收记录，检查构建提交已进入 GitHub 的 `main`。上传后逐项核对草稿附件，再标记为 Latest。保留现有的公开 Release。

```powershell
node .github/scripts/publish-gooeshell.mjs desktop/release/1.5.10-final
```

## 可选的云端构建

需要独立复核时，在 Actions 中手动运行 **GooeShell Desktop**，选择 `main`。Windows 任务打包并启动最终 ZIP。Linux 任务验证回环 SSH/SFTP、服务器间直传和 sudo 受管任务。若要发布该次云端生成的包，再手动运行 **Publish GooeShell release**，填写成功构建的 run ID 和版本号。普通代码推送不会触发云端构建。

## 验证结果

```sh
gh release view v1.5.10 --repo gooesman/gooeshell
gh release list --repo gooesman/gooeshell
```

确认 Latest 指向目标正式版本，包含 `GooeShell-版本-win-x64.zip`、`SHA256-win-x64.txt` 和 `BUILD-win-x64.json`。从公开 Release 下载 Windows ZIP，核对大小、SHA-256 和构建提交，再在隔离配置中解压启动。更新本机版本时也要核对桌面和 MCP 入口。

2026-10-28 排查发现 Releases 长期停在 1.0.3：后续仅同步源码和本地成品，云端界面测试还存在异步加载断言和测试替身接口缺失，未完成四平台验收与正式发布。本次整理保留这道验收门槛并修复测试同步问题。
