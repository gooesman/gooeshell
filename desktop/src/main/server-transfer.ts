import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import type {Client,ClientChannel} from 'ssh2';
import type {ServerTransferRequest,TransferInfo} from '../shared/types';
import {quote} from './bridge-command';

export interface TransferEndpoint {client:Client;host:string;port:number;username:string;fingerprint:string;}
class RemoteAgent {
  system='';
  private stream?:ClientChannel;
  private pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private ended=false;
  private closing?:Promise<void>;
  private closed!:()=>void;
  private closePromise=new Promise<void>(resolve=>{this.closed=resolve;});
  private constructor(private progress:(event:any)=>void){}
  static async open(endpoint:TransferEndpoint,progress:(event:any)=>void,signal:AbortSignal){
    signal.throwIfAborted();
    const agent=new RemoteAgent(progress),code=await fs.readFile(path.join(__dirname,'server-transfer-agent.py'));
    const command='python3 -u -c '+quote('import base64;exec(compile(base64.b64decode('+JSON.stringify(code.toString('base64'))+'),"<gooeshell-transfer>","exec"))');
    await new Promise<void>((resolve,reject)=>endpoint.client.exec(command,(error,stream)=>{
      if(error){reject(error);return;}
      agent.stream=stream;let pending='',errors='';const decoder=new StringDecoder('utf8');
      stream.on('data',(data:Buffer)=>{
        pending+=decoder.write(data);
        if(pending.length>256*1024){agent.fail(new Error('远端控制响应过大'));void agent.close();return;}
        let newline:number;
        while((newline=pending.indexOf('\n'))>=0){
          const line=pending.slice(0,newline);pending=pending.slice(newline+1);
          if(!line.startsWith('GOOESHELL_REMOTE '))continue;
          try{
            const value=JSON.parse(line.slice(17));
            if(value.event){agent.progress(value.event);continue;}
            const call=agent.pending.get(value.id);if(!call)continue;
            clearTimeout(call.timer);agent.pending.delete(value.id);
            value.error?call.reject(new Error(value.error)):call.resolve(value.value);
          }catch(error){agent.fail(error instanceof Error?error:new Error('远端响应无效'));}
        }
      });
      stream.stderr.on('data',(data:Buffer)=>{errors=(errors+data.toString('utf8')).slice(-4096);});
      stream.on('error',(error:Error)=>agent.fail(error));
      stream.once('close',()=>{agent.ended=true;agent.fail(new Error(errors||'远端传输控制连接已关闭'));agent.closed();});
      resolve();
    }));
    const abort=()=>{void agent.close(true);};
    signal.addEventListener('abort',abort,{once:true});
    void agent.closePromise.then(()=>signal.removeEventListener('abort',abort));
    if(signal.aborted){await agent.close(true);signal.throwIfAborted();}
    try{agent.system=(await agent.call('tools',{},15000)).system;return agent;}catch(error){await agent.close();throw error;}
  }
  private fail(error:Error){for(const call of this.pending.values()){clearTimeout(call.timer);call.reject(error);}this.pending.clear();}
  call(op:string,args:Record<string,unknown>={},timeoutMs=24*60*60*1000):Promise<any>{
    if(this.ended||this.closing)return Promise.reject(new Error('远端传输控制已关闭'));
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('远端传输操作超时'));void this.close(true);},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      this.stream!.write(JSON.stringify({...args,op,id})+'\n');
    });
  }
  close(cancel=false):Promise<void>{
    if(this.closing)return this.closing;
    this.closing=(async()=>{
      if(!this.ended){if(cancel)this.stream?.signal('TERM');this.stream?.end();}
      const timer=setTimeout(()=>this.stream?.destroy(),5000);
      try{await this.closePromise;}finally{clearTimeout(timer);}
    })();return this.closing;
  }
}

/** Local channels carry only control/progress/digests; rsync data never enters Node. */
export async function performServerTransfer(source:TransferEndpoint,target:TransferEndpoint,request:ServerTransferRequest,info:TransferInfo,signal:AbortSignal,emit:()=>void){
  let a:RemoteAgent|undefined,b:RemoteAgent|undefined,completed=false,commitStarted=false;
  const progress=(side:'source'|'target')=>(event:any)=>{
    if(event.stage==='transfer'){
      info.state='transferring';info.done=Math.max(info.done,Math.min(info.total,event.done));info.bytesPerSecond=event.bytesPerSecond;
    }else if(event.stage==='hash'&&side==='target'){
      info.state='checking';info.bytesPerSecond=undefined;info.verification={done:event.done,total:event.total,method:'sha256',stage:'final'};
    }
    emit();
  };
  try{
    a=await RemoteAgent.open(source,progress('source'),signal);
    b=await RemoteAgent.open(target,progress('target'),signal);
    const snapshot=await a.call('inspect',{path:request.source},60000);
    info.total=snapshot.total;info.state='checking';emit();
    const prepared=await b.call('prepare',{destinationDir:request.destinationDir,name:path.posix.basename(snapshot.path),identity:{source:[source.fingerprint,source.username,snapshot.path],target:[target.fingerprint,target.username,request.destinationDir]},snapshot:snapshot.digest,total:snapshot.total,directory:snapshot.directory,...(a.system===b.system?{forbidSource:snapshot.path}:{})},60000);
    info.destination=prepared.destination;emit();
    const failures:string[]=[];
    let initiator:RemoteAgent|undefined,recipient:RemoteAgent|undefined,pair:Record<string,unknown>|undefined;
    const choices=request.route==='push'?[false]:request.route==='pull'?[true]:[false,true];
    for(const pull of choices){
      const from=pull?b:a,to=pull?a:b,remote=pull?source:target;
      try{
        await from.call('probe',{host:remote.host,port:remote.port,fingerprint:remote.fingerprint},12000);
        const key=await from.call('key');
        await to.call('authorize',{taskId:info.id,publicKey:key.publicKey,readOnly:pull,root:pull?path.posix.dirname(snapshot.path):prepared.stage});
        const candidate={host:remote.host,port:remote.port,username:remote.username,pull,resume:prepared.resume,localPath:pull?prepared.payload+(snapshot.directory?'/':''):snapshot.path+(snapshot.directory?'/':''),remotePath:pull?path.posix.basename(snapshot.path)+(snapshot.directory?'/':''):'payload'+(snapshot.directory?'/':'')};
        // A dry-run verifies authentication/remote rsync before sending payload.
        await from.call('transfer',{...candidate,dryRun:true},30000);
        initiator=from;recipient=to;pair=candidate;info.route=pull?'pull':'push';break;
      }catch(error){
        signal.throwIfAborted();
        await to.call('revoke');
        failures.push((pull?'反向拉取':'直推')+'：'+(error instanceof Error?error.message:String(error)));
      }
    }
    if(!initiator||!recipient||!pair)throw new Error('服务器之间未建立可验证的 SSH 传输路径；未使用本机中转。'+failures.join('；'));
    info.state='transferring';info.verification=undefined;emit();
    await initiator.call('transfer',pair);
    await recipient.call('revoke');
    signal.throwIfAborted();
    info.state='checking';info.bytesPerSecond=undefined;info.done=info.total;info.verification={done:0,total:info.total,method:'sha256',stage:'final'};emit();
    const [left,right]=await Promise.all([a.call('hash',{path:snapshot.path,snapshot:snapshot.digest}),b.call('hash',{path:prepared.payload})]);
    if(left.digest!==right.digest||left.total!==right.total||left.count!==right.count)throw new Error('两端 SHA-256 或目录清单不一致，未提交目标；保留断点供重试');
    if((await a.call('inspect',{path:snapshot.path})).digest!==snapshot.digest)throw new Error('源文件在校验期间发生变化，未提交目标');
    commitStarted=true;await b.call('commit');await Promise.all([a.call('finish'),b.call('finish')]);info.verification=undefined;completed=true;
  }catch(error){
    if(commitStarted)throw new Error('目标提交状态尚未确认，请先检查目标目录后再试。'+(error instanceof Error?error.message:String(error)));
    throw error;
  }finally{await Promise.all([a?.close(signal.aborted||!completed),b?.close(signal.aborted||!completed)]);}
}
