import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import ts from 'typescript';
import {defaultSettings} from '../../src/shared/defaults';

/** Runs the real main IPC handler with an isolated catalog, test cipher, inert window and fake SSH worker. */
export async function identityMainHarness(t:{after:(fn:()=>Promise<void>)=>void}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gooeshell-identity-main-'));
 await fs.writeFile(path.join(root,'settings.json'),JSON.stringify(defaultSettings));
 t.after(async()=>{for(const entry of await fs.readdir(root,{withFileTypes:true})){if(entry.isFile())await fs.unlink(path.join(root,entry.name));}await fs.rmdir(root);});
 let resolveReady!:(value:unknown)=>void,rejectReady!:(error:unknown)=>void;
 const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
 const calls:Array<{method:string;args:any[]}>=[],events:any[]=[],held:Array<{worker:FakeWorker;message:any}>=[];
 let holdConnect=false,worker:FakeWorker,sessionCount=0;
 let holdKeys=false,keyResult:any={installed:true,alreadyPresent:false,verified:true},beforeKeyReply:(()=>void)|undefined,clockOffset=0;
 const heldKeys:Array<{worker:FakeWorker;message:any}>=[];
 class ClockDate extends Date{static now(){return Date.now()+clockOffset;}}
 let handler:(event:any,method:string,args:any[])=>Promise<any>;
 class FakeWorker extends EventEmitter {
  constructor(..._args:any[]){super();worker=this;}
  postMessage(message:any){
   calls.push(message);
   if(!message.id)return;
   if(message.method==='connect'&&holdConnect){held.push({worker:this,message});return;}
   if(message.method==='pushSshKey'&&holdKeys){heldKeys.push({worker:this,message});return;}
   queueMicrotask(()=>{
    if(message.method==='connect')this.emit('message',{id:message.id,value:{id:'session-'+(++sessionCount),profile:message.args[0].profile}});
    else if(message.method==='disconnect'){this.emit('message',{event:{type:'sessionClosed',sessionId:message.args[0],message:'fixture disconnect'}});this.emit('message',{id:message.id});}
    else if(message.method==='cancelConnect'){
     const index=held.findIndex(item=>item.message.args[0].attemptId===message.args[0]);
     if(index>=0){const [item]=held.splice(index,1);item.worker.emit('message',{id:item.message.id,error:'CONNECTION_CANCELLED: 已取消连接'});}
     this.emit('message',{id:message.id});
    }else if(message.method==='pushSshKey'){beforeKeyReply?.();this.emit('message',{id:message.id,value:keyResult});}
    else this.emit('message',{id:message.id,value:undefined});
   });
  }
  async terminate(){return 0;}
 }
 class FakeWindow extends EventEmitter {
  webContents=Object.assign(new EventEmitter(),{mainFrame:{},send:(_channel:string,event:any)=>events.push(event),setWindowOpenHandler:()=>{},getURL:()=>'',isDestroyed:()=>false});
  constructor(..._args:any[]){super();}
  isDestroyed(){return false;}isMinimized(){return false;}isVisible(){return true;}restore(){}show(){}focus(){}close(){}setFullScreen(){}isFullScreen(){return false;}minimize(){}maximize(){}isMaximized(){return false;}unmaximize(){}
  async loadFile(){}async loadURL(){}
 }
 let window:FakeWindow;
 class Window extends FakeWindow{constructor(...args:any[]){super(...args);window=this;}}
 const app=Object.assign(new EventEmitter(),{setName:()=>{},requestSingleInstanceLock:()=>true,quit:()=>{},exit:()=>{},setAppUserModelId:()=>{},getPath:()=>root,getAppPath:()=>path.resolve('.'),getVersion:()=> 'fixture',isPackaged:false,
  whenReady:()=>({then:(fn:()=>Promise<unknown>)=>Promise.resolve().then(fn).catch(rejectReady)}),
 });
 const ipcMain=Object.assign(new EventEmitter(),{handle:(_name:string,fn:typeof handler)=>{handler=fn;resolveReady(undefined);}});
 const key=randomBytes(32),cipher={enabled:true,encrypt:(text:string)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(text,'utf8'),c.final(),c.getAuthTag()]);},decrypt:(bytes:Buffer)=>{const d=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));d.setAuthTag(bytes.subarray(-16));return Buffer.concat([d.update(bytes.subarray(12,-16)),d.final()]).toString('utf8');}};
 const safeStorage={isEncryptionAvailable:()=>cipher.enabled,isAsyncEncryptionAvailable:async()=>cipher.enabled,getSelectedStorageBackend:()=> 'gnome_libsecret',encryptString:cipher.encrypt,decryptString:cipher.decrypt,encryptStringAsync:async(text:string)=>cipher.encrypt(text),decryptStringAsync:async(bytes:Buffer)=>({result:cipher.decrypt(bytes)})};
 const electron={app,BrowserWindow:Window,ipcMain,safeStorage,dialog:{},shell:{},session:{defaultSession:{setPermissionRequestHandler:()=>{}}},clipboard:{}};
 const sourcePath=path.resolve('src/main/main.ts'),requireMain=createRequire(sourcePath),source=await fs.readFile(sourcePath,'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const environment={...process.env};delete environment.GOOESHELL_DEV_URL;
 vm.runInNewContext(code,{exports:{},require:(name:string)=>name==='electron'?electron:name==='node:worker_threads'?{Worker:FakeWorker}:name==='./font-catalog'?{systemFontCatalog:async()=>[]}:name==='./application-menu'?{configureApplicationMenu:()=>{}}:requireMain(name),__dirname:path.dirname(sourcePath),process:{...process,env:environment},Date:ClockDate,Buffer,setTimeout,clearTimeout,structuredClone,console},{filename:'identity-main-fixture.cjs'});
 await ready;
 return{root,calls,events,cipher,
  call:(method:string,value?:unknown)=>handler({sender:window.webContents,senderFrame:window.webContents.mainFrame},method,[value]),
  hold:()=>{holdConnect=true;},release:()=>{holdConnect=false;for(const {worker,message} of held.splice(0))worker.emit('message',{id:message.id,value:{id:'session-'+(++sessionCount),profile:message.args[0].profile}});},
  pending:()=>held.length,worker:()=>worker,
  keys:{hold:()=>{holdKeys=true;},pending:()=>heldKeys.length,result:(value:any)=>{keyResult=value;},beforeReply:(callback?:()=>void)=>{beforeKeyReply=callback;},release:()=>{holdKeys=false;for(const {worker,message} of heldKeys.splice(0)){beforeKeyReply?.();worker.emit('message',{id:message.id,value:keyResult});}}},
  advanceTime:(milliseconds:number)=>{clockOffset+=milliseconds;},
 };
}
export async function waitUntil(predicate:()=>boolean){for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Isolated main fixture timed out');}
