# 来源与许可

当前 GooeShell 桌面版是位于 `desktop/` 的独立应用，新增代码采用 [MIT](LICENSE.md)。打包保留 Electron 和各依赖原始许可证。它不运行或重新打包 WezTerm。

## 当前组件

| 组件 | 用途 | 来源 / 许可 |
| --- | --- | --- |
| Electron | 桌面窗口与运行时 | <https://github.com/electron/electron>，MIT，分发中另附 Chromium 等第三方许可。 |
| React / TypeScript | 界面与应用代码 | <https://github.com/facebook/react>（MIT）、<https://github.com/microsoft/TypeScript>（Apache-2.0）。 |
| xterm.js | 终端仿真与 WebGL 渲染 | <https://github.com/xtermjs/xterm.js>，MIT。 |
| ssh2 | SSH、SFTP 与跳板机 | <https://github.com/mscdex/ssh2>，MIT。 |
| node-pty | Windows ConPTY 与 POSIX PTY | <https://github.com/microsoft/node-pty>，MIT。 |
| CodeMirror | 内置文本编辑器 | <https://github.com/codemirror/dev>，MIT。 |
| TypeScript MCP SDK / Zod | 本机 MCP 协议与参数校验 | <https://github.com/modelcontextprotocol/typescript-sdk>、<https://github.com/colinhacks/zod>，MIT。 |
| node-tar | 本地压缩传输 | <https://github.com/isaacs/node-tar>，BlueOak-1.0.0。 |

实际依赖版本以 `desktop/package-lock.json` 为准。远程归档与部分文件操作使用 Python 标准库，不安装常驻远端服务。连接、任务、校验、编辑回传和界面编排是 GooeShell 自有实现。

`desktop/scripts/prepare-native-pty.mjs` 对固定的 node-pty 1.1.0 应用两项幂等打包修正：恢复 macOS spawn helper 的可执行位，以及避免重复替换已经 unpack 的 ASAR 路径。相关上游问题为 [850](https://github.com/microsoft/node-pty/issues/850) 和 [923](https://github.com/microsoft/node-pty/issues/923)；升级该依赖时需重新审查。

## 字体

内置 DejaVu Sans Mono、JetBrains Mono 和 IBM Plex Mono，使用上游原始文件并保留许可证、固定版本和来源说明，见 [字体目录](desktop/public/fonts/README.md)。系统字体只从用户设备枚举，不随程序重新分发；没有从 FinalShell 或 Xshell 提取字体用于分发。

中英文独立字重使用 CSS 复合字体与 Unicode 范围；字体目录读取实际可用字体信息，不修改 xterm.js 或 WebGL 内部实现。

## 历史原型

早期 WezTerm / Rust 原型已退出当前构建。导入提交、许可证和历史恢复位置见 [历史说明](docs/history/native-prototype.md)。移除旧源码不改变其原始许可，也不重写仓库历史。
