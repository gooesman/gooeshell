# 早期原型与仓库整理

GooeShell 最初试验过基于 WezTerm 的 Lua 配置与 Rust 原生扩展。导入的上游版本为 `9fa147c9532c7b175335f6453a4dd7ad7e6473b2`，项目为 <https://github.com/wezterm/wezterm>，原始 MIT 许可证见 [WEZTERM-LICENSE.md](WEZTERM-LICENSE.md)。

后续图形版采用独立的 Electron、React、TypeScript、xterm.js 与 ssh2 实现，不运行或打包 WezTerm 可执行文件。旧 Cargo 工作区、Lua 原型、上游文档网站、构建工具和子模块已经不参与当前产品构建。

2026-10-28 从当前源码树移除这些旧内容，将仍在使用的回环 SSH/SFTP 夹具迁至 `test-support/ssh/`，并更新桌面 CI 和本地 Android 原型的引用。源码树不再要求 Rust、Lua 或 Git 子模块。

原型及其完整来源、许可证仍可在清理前提交 `ac13492c2d62cdf4b3aff250a681d02f2fb68389` 及更早的 Git 历史中查阅。此次清理不重写 Git 历史。原有设计稿记录历史目标，不能作为当前功能完成情况的依据；现状以 [开发基线](../DEVELOPMENT.md) 和当前源码为准。
