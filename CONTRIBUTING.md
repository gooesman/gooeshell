# 参与 GooeShell 开发

当前桌面程序在 `desktop/`。先阅读 [开发基线](docs/DEVELOPMENT.md) 和 [README](README.md)，再修改对应功能；废弃的 Rust 原型不再作为开发入口。

## 本地运行

```sh
cd desktop
npm ci
npm run dev
```

需要 Node.js 22.12+。第一次安装会下载 Electron，并准备 `node-pty` 的原生辅助文件。构建和打包使用 `npm run build`、`npm run pack`；各平台安装包应在对应系统上生成。

## 验证修改

- 默认回归：在 `desktop/` 执行 `npm test`。
- SSH / SFTP 集成：安装 `test-support/ssh/requirements.txt`，再在 `desktop/` 执行 `node scripts/ci-tests.mjs`。夹具只绑定回环地址，使用生成的临时身份与文件。
- 界面测试：先生产构建，按变更运行 `scripts/ci-editor-tests.mjs`、`ci-connection-tests.mjs`、`ci-command-tests.mjs` 或 `ci-workspace-tests.mjs`。Linux 使用 `xvfb-run -a`。
- 发布验收：运行成品启动检查和解压安装检查，参见 [发布流程](docs/RELEASING.md)。本地默认测试成功不代表所有环境测试都已执行。

修复缺陷时补充能复现问题的测试。界面异步加载应等待可观察的完成状态，不用固定短暂停顿代替完成判断，也不移除失败的验收要求。

## 提交与反馈

让每次修改对应明确的问题，避免混入无关重构。不要提交账号密码、私钥、应用数据、真实服务器截图、`node_modules`、安装包或测试运行目录。界面说明使用演示连接；截图中的身份、地址和输出都应是虚构数据。

问题反馈请附 GooeShell 版本、系统、复现步骤和预期行为。涉及 SSH 时补充认证类型、是否经跳板机，以及终端或文件操作的具体报错；无需提供密码、私钥或完整配置文件。
