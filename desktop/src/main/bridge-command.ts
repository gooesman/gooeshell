import type {Client,ClientChannel} from 'ssh2';
import iconv from 'iconv-lite';
import type {BridgeCommand,BridgeCommandResult} from '../shared/mcp';

const quote=(value:string)=>"'"+value.replace(/'/g,"'\\''")+"'";
export function executeBridgeCommand(client:Client,request:BridgeCommand,encoding:string,signal:AbortSignal,password?:string):Promise<BridgeCommandResult>{
  if(typeof request.command!=='string'||!request.command||request.command.length>65536||request.command.includes('\0'))throw new Error('命令内容无效');
  if(request.cwd!==undefined&&(typeof request.cwd!=='string'||!request.cwd.startsWith('/')||request.cwd.length>2048||request.cwd.includes('\0')))throw new Error('工作目录必须是远程绝对路径');
  if(!Number.isInteger(request.timeoutMs)||request.timeoutMs<100||request.timeoutMs>60000||typeof request.sudo!=='boolean')throw new Error('命令选项无效');
  if(password!==undefined&&/[\0\r\n]/.test(password))throw new Error('sudo 密码包含不支持的换行字符，请在终端中手动认证');
  signal.throwIfAborted();
  // Redirect inside the privileged shell: a cached/NOPASSWD sudo must never
  // leave an unread password available on the user's command stdin.
  const script=(request.cwd?'cd '+quote(request.cwd)+' && ':'')+'exec /bin/sh -c '+quote(request.command)+' < /dev/null';
  const command=request.sudo?'sudo '+(password===undefined?'-n':'-S -p \'\'')+' -- /bin/sh -c '+quote(script):'/bin/sh -c '+quote(script);
  return new Promise((resolve,reject)=>{
    let stream:ClientChannel|undefined,settled=false,bytes=0,truncated=false,exitCode:number|null=null,exitSignal:string|null=null;
    const stdout:Buffer[]=[],stderr:Buffer[]=[];
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);if(error){stream?.destroy();reject(error);}else resolve({stdout:iconv.decode(Buffer.concat(stdout),encoding),stderr:iconv.decode(Buffer.concat(stderr),encoding),exitCode,signal:exitSignal,truncated});};
    const abort=()=>finish(new Error('MCP 命令已取消；已启动的独立 tmux 任务会继续运行'));
    const timer=setTimeout(()=>finish(new Error('命令执行超时；长任务请放在 tmux 中运行')),request.timeoutMs);
    const append=(chunks:Buffer[],data:Buffer)=>{const take=Math.min(data.length,Math.max(0,65536-bytes));if(take)chunks.push(Buffer.from(data.subarray(0,take)));bytes+=take;if(take<data.length)truncated=true;};
    signal.addEventListener('abort',abort,{once:true});
    try{client.exec(command,(error,channel)=>{
      if(settled){channel?.destroy();return;}if(error){finish(new Error(error.message));return;}stream=channel;
      channel.on('data',(data:Buffer)=>append(stdout,data));channel.stderr.on('data',(data:Buffer)=>append(stderr,data));
      channel.once('error',(error:Error)=>finish(error));channel.once('exit',(code:number,signal?:string)=>{exitCode=Number.isInteger(code)?code:null;exitSignal=signal||null;});channel.once('close',()=>finish());
      channel.end(request.sudo&&password!==undefined?Buffer.from(password+'\n','utf8'):undefined);
    });}catch(error){finish(error instanceof Error?error:new Error('命令启动失败'));}
  });
}
