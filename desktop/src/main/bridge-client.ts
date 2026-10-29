import {promises as fs} from 'node:fs';
import {parseMcpCall} from './mcp-tools';

/** Shared transport for MCP and CLI. Re-read on every call after a GUI restart. */
export async function callBridge(file:string,name:string,args:unknown,signal:AbortSignal):Promise<unknown>{
  const call=parseMcpCall(name,args);
  let descriptor:any;
  try{descriptor=JSON.parse(await fs.readFile(file,'utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('请先打开 GooeShell 并启用 MCP 桥接');throw error;}
  if(descriptor.enabled!==true||!Number.isInteger(descriptor.port)||descriptor.port<1||descriptor.port>65535||!/^[a-f0-9]{64}$/.test(descriptor.token))throw new Error('请先打开 GooeShell 并启用 MCP 桥接');
  const response=await fetch(`http://127.0.0.1:${descriptor.port}/call`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+descriptor.token},body:JSON.stringify({tool:call.name,arguments:call.args}),signal:AbortSignal.any([signal,AbortSignal.timeout(90000)])}).catch(error=>{
    if(error instanceof TypeError&&error.message==='fetch failed')throw new Error(`无法连接 GooeShell MCP 桥接（本机端口 ${descriptor.port}）。请确认 GooeShell 正在运行，并在“设置 → AI 与 MCP”检查桥接状态；升级后安装目录变化时，请重新复制客户端配置。`,{cause:error});
    throw error;
  });
  const result=await response.json() as {value?:unknown;error?:string};
  if(!response.ok)throw new Error(result.error||'桥接操作失败');
  return result.value;
}
