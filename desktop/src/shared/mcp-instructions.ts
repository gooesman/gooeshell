/** Sent during MCP initialization and available for users to copy in settings. */
export const GOOESHELL_MCP_INSTRUCTIONS = `GooeShell MCP 使用指引

先遵循用户的具体要求和客户端的安全规则。调用 list_sessions 查看在线会话，必要时用 list_connections 查找已保存连接，connect 复用会话或建立连接；身份与分组可用 list_connection_options 查询。create_connection 默认不加入侧边栏，只有用户明确要求收藏时才传 favorite=true。connect 默认本次自动接受指纹，不验证或保存；只有用户明确要求持久信任时才选 hostKeyPolicy=save。凭据由 GooeShell 管理，不要索取、回显或把密码写入命令与日志。

短命令用 run_command；需要在窗口中查看命令活动时可调用 show_in_app（kind=activity）。需要持续运行、观察输出或保留真实退出状态的非交互任务，优先直接用 start_task 运行实际命令，不要在命令末尾加 &、nohup 或自行守护化；否则工具可能只跟踪启动器。服务器必须有 tmux 和 Python 3；缺少时说明限制，不擅自安装。需要 sudo 时使用 sudo=true，不要把密码发到终端或窗格。

长任务启动后，默认调用 show_in_app（kind=task，带 sessionId 和 taskId），让用户可以查看输出；持续跟踪已有普通日志文件时，默认调用 show_in_app（kind=log，带 sessionId 和绝对路径）。用户明确要求不打开时不要展开。面板仅在打开时约每两秒刷新；显示请求已发出不代表用户已看到。任务窗格仅保留有限滚动内容，并非完整持久日志；需要长期保留时明确说明这一限制。旧任务若没有保存输出，不要声称可以找回。

用 read_task 确认任务状态；只有 state=exited 且 exitCode=0 才能报告受管进程成功。任务可能自行脱离或启动其他后台进程，退出码只代表受管进程；不要把启动成功、状态检查命令成功、空输出或未知退出码当成实际任务完成。不得虚构进度百分比。任务启动超时或断线时先检查 gooeshell-ai 会话，不盲目重试。需要停止时使用 stop_task，并确认状态。

查看日志本身用 read_log，携带 nextOffset 和 cursor；不要高频轮询。远程文本使用 read_remote_text，再按 revision 通过 edit_remote_text 或 write_remote_text 操作；冲突时重新读取，不盲目覆盖。

本机与服务器之间使用 transfer_file；服务器之间优先 transfer_between_servers，数据不经过本机，条件不满足时说明，不擅自改为本机中转。需要在界面查看时调用 show_in_app（kind=transfer），之后用 read_transfer 区分传输、校验和最终状态；stop_transfer 只是请求取消，需要再确认结果。`;
