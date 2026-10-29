import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {readFileSync,statSync} from 'node:fs';
import {callBridge} from './bridge-client';
import {mcpTools} from './mcp-tools';

export function cliArguments(argv:string[]){
  const args=[...argv];let file=process.env.GOOESHELL_BRIDGE_FILE||path.join(process.platform==='win32'?(process.env.APPDATA||path.join(os.homedir(),'AppData/Roaming')):process.platform==='darwin'?path.join(os.homedir(),'Library/Application Support'):(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config')),'gooeshell/mcp-bridge.json');
  const option=args.indexOf('--bridge');if(option>=0){if(!args[option+1])throw new Error('--bridge 需要文件路径');file=args[option+1];args.splice(option,2);}
  const watch=args.includes('--watch');if(watch)args.splice(args.indexOf('--watch'),1);
  if(args.length>2)throw new Error('参数使用一个 JSON 对象传入；请查看 --help');
  const name=args[0]?.replace(/-/g,'_');
  let json=args[1];
  if(json?.startsWith('@')){const file=json.slice(1);if(statSync(file).size>256*1024)throw new Error('参数文件不能超过 256 KiB');json=readFileSync(file,'utf8').replace(/^\uFEFF/,'');}
  const input=json?JSON.parse(json):{};
  if(watch&&!['read_task','read_log','read_transfer'].includes(name))throw new Error('--watch 仅用于 read-task、read-log 或 read-transfer');
  return{file,name,input,watch};
}
export async function cli(argv:string[],signal:AbortSignal,write:(value:string)=>void=console.log):Promise<number>{
  if(!argv.length||argv.includes('--help')){write('GooeShell CLI — 复用运行中的桌面连接，不接收密码\n用法：gooeshell-cli [--bridge 文件] 操作 [JSON参数] [--watch]\n'+Object.entries(mcpTools).map(([name,tool])=>`  ${name.replace(/_/g,'-')}  ${tool.description}`).join('\n')+'\n--watch 每秒读取一次，输出 NDJSON；Ctrl+C 只停止读取，停止后台任务使用 stop-task。');return 0;}
  const {file,name,input,watch}=cliArguments(argv);
  let value:any;
  do{
    value=await callBridge(file,name,input,signal);write(JSON.stringify(value));
    if(!watch||value.state==='exited'||['completed','failed','cancelled'].includes(value.state))break;
    if(name==='read_log')input.offset=value.nextOffset;
    await delay(1000,undefined,{signal});
  }while(!signal.aborted);
  if(name==='run_command'||name==='read_task')return value.exitCode===null?2:Math.min(255,Math.max(0,value.exitCode));
  return ['failed','cancelled'].includes(value.state)?1:0;
}
if(require.main===module){const controller=new AbortController();process.once('SIGINT',()=>controller.abort());void cli(process.argv.slice(2),controller.signal).then(code=>{process.exitCode=code;},error=>{if(controller.signal.aborted)process.exitCode=130;else{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}});}
