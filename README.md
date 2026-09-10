# gooeshell

Windows 优先的原生 SSH 终端与 SFTP 工作区，基于 WezTerm。

默认纯黑；字体、快捷键、连接和文件操作尽量保持直接。

## 运行

从本仓库 **Actions → gooeshell Windows** 的成功构建下载 `gooeshell-windows-x64`，解压其中的 ZIP 到可写目录，双击 **gooeshell.exe**。

首次启动打开操作菜单，可新建 SSH 连接或使用本地终端。连接信息保存在便携目录 `gooeshell/data`，不保存密码。文件面板通过独立 SSH 连接工作，因此首次打开可能需要再次认证。

## 第一版范围

- WezTerm 原生终端、中文输入、纯黑背景和字体回退。
- SSH 连接向导、已保存主机、永久或本次会话的主机指纹记录。
- 中英文字体选择、字号与窗口布局设置。
- 快捷键设置与冲突检查；Ctrl+C 保持终端中断语义。
- 无边框全屏、纯终端布局、文件侧栏。
- 独立 Rust SFTP 文件面板：目录导航、上传和下载。

快捷键：`Ctrl+Shift+P` 操作菜单，`Ctrl+Shift+E` 文件面板，`F11` 全屏，`Ctrl+Shift+F11` 纯终端，`Ctrl+Shift+C/V` 复制粘贴。以程序内快捷键设置为准。

这是首个可体验版本。开发中的功能和验证结果记录在 `VALIDATION.md`；不能把目标设计当成已经实现的能力。尚不宣称公网零延迟，也不以渲染技术名称作为性能测试结果。

## 构建

使用 Rust stable 的 MSVC 工具链、Visual Studio C++ Build Tools、Windows SDK 和 Strawberry Perl：

```powershell
git clone --recurse-submodules https://github.com/gooesman/gooeshell.git
cd gooeshell
cargo build --locked --release -p wezterm -p wezterm-gui -p gooeshell-launcher -p gooeshell-files
cargo test --locked --release -p gooeshell-files -p gooeshell-launcher
```

便携包的完整打包步骤见 `.github/workflows/gooeshell-windows.yml`。GitHub Actions 使用 `windows-2025`，保留上游静态 C 运行时设置。

## 源码结构

- `gooeshell/`：产品设置、交互菜单、启动脚本和配置测试。
- `gooeshell-launcher/`：原生 Windows 启动入口。
- `gooeshell-files/`：独立连接的 SFTP 文件面板。
- `wezterm-gui/`、`term/`、`window/` 等：上游终端、渲染和窗口代码。
- `DESIGN.md`、`FONT-KEYBOARD.md`：产品设计与功能边界。

## 来源与许可

原始 WezTerm 来源、导入提交和第三方说明见 [UPSTREAM.md](UPSTREAM.md)。保留上游 [LICENSE.md](LICENSE.md)、`licenses/` 及各组件许可证。原始项目说明见 [README-UPSTREAM.md](README-UPSTREAM.md)。新增 gooeshell 代码使用 MIT 许可证。

仓库不包含参考软件的字体资源、用户私钥、连接配置、传输文件或本机构建工具。
