# GooeShell 开发约定

- 当前桌面应用在 `desktop/`，采用 Electron、React、TypeScript、xterm.js、ssh2 与 node-pty。先阅读 `docs/DEVELOPMENT.md`；旧 WezTerm / Rust 原型不再参与构建，不要恢复旧工作区或子模块。
- Windows 优先，同时维护 macOS arm64/x64 和 Linux x64。输入延迟、终端兼容、配置兼容和文件数据完整性是持续要求。
- 开始修改前说明假设、范围和可验证目标。简单优先，精准修改；不混入无关重构，不添加未要求的配置项。
- 缺陷先复现，再验证修复。默认 `npm test` 会跳过部分环境测试；涉及界面、SSH、传输或发布时运行对应真实集成和成品检查，准确报告跳过项。
- 共享 SSH/SFTP 测试夹具位于 `test-support/ssh/`。使用隔离配置、回环服务器与测试身份，不使用用户真实凭据制作测试、截图或日志。
- README 面向使用者，详细功能和边界放在 `docs/`。截图使用演示数据，并实际检查图像内容和文档链接。
- 正式发布遵循 `docs/RELEASING.md`。源码推送与本地打包不等于 Release 发布；四平台与七个最终分发包验收成功后才发布 Latest，不绕过失败检查。
- 保留未提交的移动端原型和用户素材。清理旧源码不清理用户配置、不重写 Git 历史；历史来源说明位于 `docs/history/`。
