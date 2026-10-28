import {promises as fs} from 'node:fs';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {mcpTools} from './mcp-tools';

export async function start(file:string){
  if(!file)throw new Error('请从 GooeShell 的 MCP 设置复制接入配置');
  const server=new McpServer({name:'gooeshell',version:require('../../package.json').version});
  for(const [name,tool] of Object.entries(mcpTools)){
    server.registerTool(name,{description:tool.description,inputSchema:tool.schema,annotations:{readOnlyHint:tool.readOnly}},async(args:unknown,extra:{signal:AbortSignal}):Promise<CallToolResult>=>{
      try{
        const descriptor=JSON.parse(await fs.readFile(file,'utf8'));
        if(descriptor.enabled!==true||!Number.isInteger(descriptor.port)||descriptor.port<1||descriptor.port>65535||!/^[a-f0-9]{64}$/.test(descriptor.token))throw new Error('请先打开 GooeShell 并启用 MCP 桥接');
        const response=await fetch(`http://127.0.0.1:${descriptor.port}/call`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+descriptor.token},body:JSON.stringify({tool:name,arguments:args}),signal:AbortSignal.any([extra.signal,AbortSignal.timeout(90000)])}).catch(error=>{
          if(error instanceof TypeError&&error.message==='fetch failed')throw new Error(`无法连接 GooeShell MCP 桥接（本机端口 ${descriptor.port}）。请确认 GooeShell 正在运行，并在“设置 → AI 与 MCP”检查桥接状态；升级后安装目录变化时，请重新复制客户端配置。`,{cause:error});
          throw error;
        });
        const result=await response.json() as {value?:unknown;error?:string};
        if(!response.ok)throw new Error(result.error||'MCP 桥接操作失败');
        return{content:[{type:'text',text:JSON.stringify(result.value)}]};
      }catch(error){return{isError:true,content:[{type:'text',text:error instanceof Error&&'code' in error&&error.code==='ENOENT'?'请先打开 GooeShell 并启用 MCP 桥接':error instanceof Error?error.message:'MCP 操作失败'}]};}
    });
  }
  await server.connect(new StdioServerTransport());
}
if(require.main===module)void start(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1;});
