import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {mcpTools} from './mcp-tools';
import {callBridge} from './bridge-client';

export async function start(file:string){
  if(!file)throw new Error('请从 GooeShell 的 MCP 设置复制接入配置');
  const server=new McpServer({name:'gooeshell',version:require('../../package.json').version});
  for(const [name,tool] of Object.entries(mcpTools)){
    server.registerTool(name,{description:tool.description,inputSchema:tool.schema,annotations:{readOnlyHint:tool.readOnly}},async(args:unknown,extra:{signal:AbortSignal}):Promise<CallToolResult>=>{
      try{
        const value=await callBridge(file,name,args,extra.signal);
        return{content:[{type:'text',text:JSON.stringify(value)}]};
      }catch(error){return{isError:true,content:[{type:'text',text:error instanceof Error&&'code' in error&&error.code==='ENOENT'?'请先打开 GooeShell 并启用 MCP 桥接':error instanceof Error?error.message:'MCP 操作失败'}]};}
    });
  }
  await server.connect(new StdioServerTransport());
}
if(require.main===module)void start(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1;});
