import {createServer,type Server,type IncomingMessage,type ServerResponse} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {McpStatus} from '../shared/mcp';
import {parseMcpCall,type McpToolName} from './mcp-tools';

export class McpBridge {
  private server?:Server;
  private token='';
  private port=0;
  private active=new Set<AbortController>();
  private changes:Promise<unknown>=Promise.resolve();
  readonly file:string;
  constructor(directory:string,private readonly config:McpStatus['config'],private readonly call:(name:McpToolName,args:any,signal:AbortSignal)=>Promise<unknown>,private readonly disconnected:()=>Promise<void>){this.file=path.join(directory,'mcp-bridge.json');}
  status():McpStatus{return{available:true,enabled:!!this.server,config:this.config};}
  async load():Promise<void>{
    let enabled=false;
    try{const saved=JSON.parse(await fs.readFile(this.file,'utf8'));if(typeof saved.enabled!=='boolean')throw new Error('MCP 设置无效');enabled=saved.enabled;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(enabled)await this.setEnabled(true);
  }
  setEnabled(enabled:boolean):Promise<McpStatus>{
    const change=this.changes.catch(()=>{}).then(async()=>{
      if(typeof enabled!=='boolean')throw new Error('MCP 开关无效');
      if(enabled&&!this.server){
        const server=createServer((request,response)=>{void this.handle(request,response);});
        this.token=randomBytes(32).toString('hex');
        await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
        this.port=(server.address() as {port:number}).port;this.server=server;
        try{await this.persist(true);}catch(error){await this.close();throw error;}
      }else if(!enabled){await this.close();await this.persist(false);}
      return this.status();
    });
    this.changes=change;return change;
  }
  private async persist(enabled:boolean){
    await fs.mkdir(path.dirname(this.file),{recursive:true});const temporary=this.file+'.'+randomUUID()+'.tmp';
    try{await fs.writeFile(temporary,JSON.stringify({enabled,...(enabled?{port:this.port,token:this.token}:{})}),{mode:0o600});await fs.rename(temporary,this.file);}
    finally{await fs.unlink(temporary).catch(()=>{});}
  }
  private async handle(request:IncomingMessage,response:ServerResponse){
    const reply=(status:number,body:unknown)=>{if(!response.destroyed){response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(body));}};
    if(request.headers.authorization!=='Bearer '+this.token||request.headers.origin||request.headers.host!==`127.0.0.1:${this.port}`){reply(403,{error:'MCP 访问未授权'});return;}
    if(request.method!=='POST'||request.url!=='/call'){reply(404,{error:'不支持的 MCP 路径'});return;}
    if(this.active.size>=8){reply(429,{error:'MCP 操作过多，请稍后重试'});return;}
    const controller=new AbortController();this.active.add(controller);
    const cancel=()=>controller.abort();response.once('close',cancel);
    try{
      const chunks:Buffer[]=[];let bytes=0;
      for await(const chunk of request){bytes+=chunk.length;if(bytes>256*1024)throw new Error('MCP 请求过大');chunks.push(chunk);}
      controller.signal.throwIfAborted();
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));const call=parseMcpCall(body.tool,body.arguments);
      const value=await this.call(call.name,call.args,controller.signal);
      controller.signal.throwIfAborted();reply(200,{value});
    }catch(error){reply(400,{error:error instanceof Error?error.message:'MCP 操作失败'});}
    finally{response.removeListener('close',cancel);this.active.delete(controller);}
  }
  private async close(){
    const server=this.server;this.server=undefined;this.token='';
    for(const controller of this.active)controller.abort();
    if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
    await this.disconnected();
  }
  async stop(){await this.changes.catch(()=>{});await this.close();}
}
