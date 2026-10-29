import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {Client} from 'ssh2';
import type {BridgeTaskStart,BridgeTaskRead,BridgeTaskResult} from '../shared/mcp';
import {bridgeScript,executeBridgeChannel,quote} from './bridge-command';

const sessionName='gooeshell-ai';
const taskIdPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function taskLaunch(command:BridgeTaskStart,taskId:string,password?:string):string{
  if(!taskIdPattern.test(taskId)||typeof command.sudo!=='boolean')throw new Error('后台任务参数无效');
  if(password!==undefined&&/[\0\r\n]/.test(password))throw new Error('sudo 密码包含不支持的换行字符');
  const script=bridgeScript(command),name='task-'+taskId.slice(0,8);
  // FD 3 is an owner-only FIFO, never a terminal. Close it before executing the
  // user command, including when sudo has cached credentials or NOPASSWD.
  const execute=command.sudo?'exec sudo '+(password===undefined?'-n':"-S -p ''")+' -- /bin/sh -c '+quote(script)+' <&3 3<&-':'exec /bin/sh -c '+quote(script)+' 3<&-';
  const grouped='python3 -c '+quote("import os,sys;os.setsid();os.execl('/bin/sh','sh','-c',sys.argv[1])")+' '+quote(execute);
  const runner='exec 3< "$1/input"; rm -f -- "$1/input"; rmdir -- "$1"; '+grouped+' & child=$!; exec 3<&-; '+
    'tmux set-option -p -t "$TMUX_PANE" @gooeshell_mcp_pid "$child"; '+
    'interrupted=0; killer=; trap \'interrupted=1; kill -TERM -"$child" 2>/dev/null || :; (sleep 3; kill -KILL -"$child" 2>/dev/null || :) & killer=$!\' HUP INT TERM; '+
    'wait "$child"; status=$?; if [ "$interrupted" = 1 ]; then wait "$child"; status=$?; kill -KILL -"$child" 2>/dev/null || :; [ -z "$killer" ] || kill "$killer" 2>/dev/null || :; fi; '+
    'tmux set-option -p -t "$TMUX_PANE" @gooeshell_mcp_exit_code "$status"; exit "$status"';
  return `set -eu
command -v tmux >/dev/null 2>&1 || { printf '后台任务需要服务器安装 tmux；普通命令可使用 run_command\\n' >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { printf '托管后台任务需要 Python 3\\n' >&2; exit 1; }
umask 077
directory=$(mktemp -d /tmp/gooeshell-task.XXXXXXXXXX)
pane=''
delivered=0
cleanup() { if [ "$delivered" != 1 ]; then if [ -n "$pane" ]; then tmux kill-pane -t "$pane" 2>/dev/null || :; fi; rm -f -- "$directory/input"; rmdir -- "$directory" 2>/dev/null || :; fi; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkfifo "$directory/input"
runner=${quote('/bin/sh -c '+quote(runner)+' gooeshell-task ')}$(printf "'%s'" "$directory")
if tmux has-session -t =${sessionName} 2>/dev/null; then
  location=$(tmux new-window -d -P -F '#{window_id} #{pane_id}' -t ${sessionName}: -n ${name} "$runner")
else
  location=$(tmux new-session -d -P -F '#{window_id} #{pane_id}' -s ${sessionName} -n ${name} -x 160 -y 45 "$runner" 2>/dev/null || tmux new-window -d -P -F '#{window_id} #{pane_id}' -t ${sessionName}: -n ${name} "$runner")
fi
set -- $location
window=$1
pane=$2
tmux set-option -w -t "$window" remain-on-exit on
tmux set-option -w -t "$window" automatic-rename off
tmux set-option -p -t "$pane" @gooeshell_mcp_task ${taskId}
tmux set-option -p -t "$pane" @gooeshell_mcp_exit_code -
tmux set-option -p -t "$pane" @gooeshell_mcp_stop_supported 1
# NOPASSWD sudo may close the pipe without reading; SIGPIPE is harmless here.
cat > "$directory/input" || :
delivered=1
printf 'GOOESHELL_TASK %s %s\\n' "$window" "$pane"
`;
}
export async function stopBridgeTask(client:Client,request:Pick<BridgeTaskRead,'sessionId'|'taskId'>,encoding:string,signal:AbortSignal):Promise<BridgeTaskResult>{
  if(!taskIdPattern.test(request.taskId))throw new Error('后台任务参数无效');
  const command=`set -eu
pane=$(tmux list-panes -a -F '#{@gooeshell_mcp_task} #{pane_id}' | awk '$1 == "${request.taskId}" {print $2; exit}')
[ -n "$pane" ] || { printf '任务窗格不存在\\n' >&2; exit 1; }
[ "$(tmux show-option -p -v -t "$pane" @gooeshell_mcp_stop_supported)" = 1 ] || { printf '旧任务不支持托管停止，请在终端内停止\\n' >&2; exit 1; }
if [ "$(tmux display-message -p -t "$pane" '#{pane_dead}')" != 1 ]; then
  pid=$(tmux display-message -p -t "$pane" '#{pane_pid}')
  kill -TERM "$pid"
fi
`;
  const result=await executeBridgeChannel(client,command,encoding,signal,15000);
  if(result.exitCode!==0)throw new Error(result.stderr.trim()||'停止任务失败');
  for(let attempt=0;attempt<20;attempt++){
    const state=await readBridgeTask(client,{...request,tailLines:200},encoding,signal);
    if(state.state==='exited')return state;
    await delay(250,undefined,{signal});
  }
  throw new Error('已请求停止，但尚未确认进程退出，请继续 read_task 检查');
}
export async function startBridgeTask(client:Client,request:BridgeTaskStart,encoding:string,signal:AbortSignal,password?:string):Promise<BridgeTaskResult>{
  const taskId=randomUUID();
  const result=await executeBridgeChannel(client,taskLaunch(request,taskId,password),encoding,signal,15000,request.sudo&&password!==undefined?Buffer.from(password+'\n','utf8'):undefined);
  if(result.exitCode!==0)throw new Error(result.stderr.trim()||'后台任务未能启动');
  const location=/^GOOESHELL_TASK (@\d+) (%\d+)$/m.exec(result.stdout);
  if(!location)throw new Error('未收到后台任务编号，任务可能已启动；请在 GooeShell 中检查 gooeshell-ai 会话');
  return readBridgeTask(client,{sessionId:request.sessionId,taskId,tailLines:20},encoding,signal);
}
export async function readBridgeTask(client:Client,request:BridgeTaskRead,encoding:string,signal:AbortSignal):Promise<BridgeTaskResult>{
  if(!taskIdPattern.test(request.taskId)||!Number.isInteger(request.tailLines)||request.tailLines<1||request.tailLines>1000)throw new Error('后台任务参数无效');
  const command=`set -eu
pane=$(tmux list-panes -a -F '#{@gooeshell_mcp_task} #{pane_id}' | awk '$1 == "${request.taskId}" {print $2; exit}')
[ -n "$pane" ] || { printf '任务窗格不存在，无法确认退出状态\\n' >&2; exit 1; }
tmux display-message -p -t "$pane" 'GOOESHELL_STATE #{window_id} #{pane_id} #{pane_dead} #{@gooeshell_mcp_exit_code} #{pane_dead_status} #{pane_dead_signal}'
tmux capture-pane -p -J -S -${request.tailLines} -t "$pane"
`;
  const result=await executeBridgeChannel(client,command,encoding,signal,15000);
  if(result.exitCode!==0)throw new Error(result.stderr.trim()||'无法读取后台任务');
  const meta=/^GOOESHELL_STATE (@\d+) (%\d+) ([01]) (-|\d+) (\d*) (\S*)\r?\n/.exec(result.stdout);
  if(!meta)throw new Error('后台任务状态无法识别，不推测执行成功');
  let output=result.stdout.slice(meta[0].length).replace(/[ \t]+$/gm,'').replace(/\n+$/,'');
  // tmux draws its default death notice on the bottom row. Exclude that UI
  // notice and screen padding before taking the requested command-output tail.
  if(meta[3]==='1')output=output.replace(/(?:^|\n)Pane is dead \((?:status|signal) [^\n]*\)$/,'').replace(/\n+$/,'');
  const lines=output.split('\n');
  // PTY EOF can arrive before waitpid: a dead pane without a status is still
  // finishing, not a completed command with a fabricated success code.
  const dead=meta[3]==='1',code=meta[4]!=='-'?Number(meta[4]):dead&&meta[5]?Number(meta[5]):null,signalName=dead&&meta[6]?meta[6]:null,exited=code!==null||signalName!==null;
  return{taskId:request.taskId,sessionName,windowId:meta[1],paneId:meta[2],state:exited?'exited':dead?'finishing':'running',exitCode:code,signal:signalName,output:lines.slice(-request.tailLines).join('\n'),truncated:result.truncated||lines.length>request.tailLines};
}
