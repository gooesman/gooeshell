# 正式发布流程

源码提交、本地打包与 GitHub Release 是三件不同的事。`main` 更新不会自动把 Releases 的 Latest 改成源码版本。

## 构建与验收

1. 更新 `desktop/package.json`、锁文件根版本及 README 版本，并编写 `.github/release-notes/v版本.md`。
2. 推送到 `main`，运行 **GooeShell Desktop**（`.github/workflows/gooeshell-windows.yml`）。手动构建可用于诊断，但正式发布脚本要求成功的 main 分支 push 构建。
3. 等待 Windows x64、macOS arm64、macOS x64、Linux x64 四项全部成功。
4. 每个平台必须执行回环 SSH/SFTP 测试、生产构建、相关真实界面回归、成品启动，以及最终分发包的解压 / 安装启动检查。
5. 构建产物包含版本、提交号、平台、架构、安装包校验和与验收记录。只上传生成文件不等于验收成功。

## 发布 Release

在 Actions 运行 **Publish GooeShell release**（`gooeshell-release.yml`），填写成功的构建 run ID 与稳定版本号，例如：

```sh
gh workflow run gooeshell-release.yml --repo gooesman/gooeshell \
  -f source_run=成功的构建ID -f version=1.3.5
```

PowerShell 可将上面的命令写成一行。发布脚本 `.github/scripts/publish-gooeshell.mjs` 会检查源构建来源和版本，下载四平台产物，逐个核对 SHA-256、字节数和最终安装包验收记录；随后创建或恢复草稿、上传资产，再转为正式版并标记 Latest。

Windows ZIP、两种 Mac 架构各自的 ZIP / DMG、Linux AppImage / DEB 共七个分发包必须完整通过。既有正式发布不会被覆盖，已有标签若指向不同提交也会停止。不要为了让页面版本变新而跳过失败测试或发布缺少验收的包。

## 验证结果

```sh
gh release view v1.3.5 --repo gooesman/gooeshell
gh release list --repo gooesman/gooeshell
```

确认不是草稿或预发布，Latest 指向目标版本，七个分发包及四组构建信息和校验文件都在。更新桌面快捷方式和本机 MCP 配置时，也要核对新程序版本、目录和实际连接。

2026-10-28 排查发现 Releases 长期停在 1.0.3：后续仅同步源码和本地成品，云端界面测试还存在异步加载断言和测试替身接口缺失，未完成四平台验收与正式发布。本次整理保留这道验收门槛并修复测试同步问题。
