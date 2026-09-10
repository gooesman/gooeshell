import {app,BrowserWindow,dialog,ipcMain,shell,session,clipboard} from 'electron';
import path from 'node:path';
import os from 'node:os';
import {promises as fs} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {Store,cleanProfile} from './store';
import {availableFontFamilies,bundledFontFamilies} from '../shared/fonts';
import {readLocalText,renameLocalPath} from './local-files';
import {systemFontCatalog} from './font-catalog';
import type {AppEvent,FileListing,RemoteRequest} from '../shared/types';
let win:BrowserWindow;let worker:Worker;let store:Store;let shuttingDown=false;
const pending=new Map<string,{resolve:(v:any)=>void,reject:(e:Error)=>void}>();
function remote(method:string,...args:unknown[]):Promise<any>{return new Promise((resolve,reject)=>{const id=randomUUID();pending.set(id,{resolve,reject});worker.postMessage({id,method,args});});}
function localPath(value:unknown):string{if(typeof value!=='string'||!value||value.includes('\0'))throw new Error('文件路径无效');return path.resolve(value);}
async function localList(directory:string):Promise<FileListing>{
 const actual=localPath(directory);const entries=await fs.readdir(actual,{withFileTypes:true});
 const result=await Promise.all(entries.map(async e=>{try{const p=path.join(actual,e.name);const s=await fs.lstat(p);return{name:e.name,path:p,type:s.isDirectory()?'directory' as const:s.isSymbolicLink()?'symlink' as const:'file' as const,size:s.size,modified:s.mtimeMs,mode:s.mode};}catch{return null;}}));
 return {path:actual,entries:result.filter((x):x is NonNullable<typeof x>=>x!==null).sort((a,b)=>Number(b.type==='directory')-Number(a.type==='directory')||a.name.localeCompare(b.name,'zh-CN'))};
}
async function fonts():Promise<string[]>{
 const known=[...bundledFontFamilies];
 if(process.platform!=='win32')return availableFontFamilies((await systemFontCatalog()).map(font=>font.family));
 return new Promise(resolve=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families.Name | ConvertTo-Json -Compress"],{windowsHide:true,timeout:10000,maxBuffer:1024*1024},(err,out)=>{try{const data=JSON.parse(out);resolve(availableFontFamilies(Array.isArray(data)?data:typeof data==='string'?[data]:[]));}catch{resolve(known);}}));
}
const remoteMethods=new Set(['disconnect','confirmHostKey','remoteList','transfer','cancelTransfer','chmod','runFile']);
app.whenReady().then(async()=>{
 void systemFontCatalog().catch(()=>{});
 app.setName('gooeshell');if(process.platform==='win32')app.setAppUserModelId('com.gooesman.gooeshell');store=new Store(app.getPath('userData'));
 worker=new Worker(path.join(__dirname,'worker.js'),{workerData:{knownHostsFile:path.join(app.getPath('userData'),'known-hosts.json')}});
 worker.on('message',message=>{if(message.event){if(win&&!win.isDestroyed())win.webContents.send('gooeshell:event',message.event as AppEvent);return;}const waiting=pending.get(message.id);if(waiting){pending.delete(message.id);message.error?waiting.reject(new Error(message.error)):waiting.resolve(message.value);}});
 worker.on('error',error=>{for(const value of pending.values())value.reject(error);pending.clear();if(win&&!win.isDestroyed())win.webContents.send('gooeshell:event',{type:'notice',message:'连接服务已停止：'+error.message});});
 const windowIcon=app.isPackaged?path.join(process.resourcesPath,'icon.png'):path.join(app.getAppPath(),'assets','icon.png');
 const initialTheme=(await store.settings()).theme;
 win=new BrowserWindow({icon:windowIcon,width:1460,height:940,minWidth:960,minHeight:640,frame:false,backgroundColor:initialTheme==='light'?'#ffffff':'#0b0b0b',show:false,title:'gooeshell',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:false}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate',(event,url)=>{if(url!==win.webContents.getURL())event.preventDefault();});
 session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 const trusted=(event:Electron.IpcMainEvent|Electron.IpcMainInvokeEvent)=>event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame;
 ipcMain.handle('gooeshell:call',async(event,method,args:unknown[])=>{
  if(!trusted(event)||!Array.isArray(args))throw new Error('调用来源无效');
  if(remoteMethods.has(method))return remote(method,...args);
  const value:any=args[0];
  switch(method){
   case 'initial':return{profiles:await store.profiles(),settings:await store.settings(),connectionHistory:await store.history(),hostKeyPreferences:await store.hostKeyPreferences(),localHome:os.homedir(),version:app.getVersion()};
   case 'saveProfile':return store.saveProfile(value);
   case 'deleteProfile':return store.deleteProfile(value);
   case 'connectionHistory':return store.history();
   case 'clearConnectionHistory':return store.clearHistory();
   case 'setHostKeyPreference':return store.setHostKeyPreference(value);
   case 'saveSettings':return store.saveSettings(value);
   case 'connect':{
    const profile=cleanProfile(value.profile);
    const skipHostKeyVerification=(await store.hostKeyPreferences()).some(preference=>preference.host===profile.host.toLowerCase()&&preference.port===profile.port&&preference.skipVerification);
    const effectiveProfile=skipHostKeyVerification?{...profile,rememberHost:false}:profile;
    const connected=await remote('connect',{...value,profile:effectiveProfile,skipHostKeyVerification});
    try{await store.recordConnection(profile);}
    catch{if(win&&!win.isDestroyed())win.webContents.send('gooeshell:event',{type:'notice',message:'服务器已连接，但连接历史未能保存。'});}
    return{...connected,profile};
   }
   case 'localList':return localList(value||os.homedir());
   case 'chooseFiles':{const result=await dialog.showOpenDialog(win,{title:value?.title,properties:value?.directory?['openDirectory']:value?.multiple?['openFile','multiSelections']:['openFile']});return result.canceled?[]:result.filePaths;}
   case 'showInFolder':shell.showItemInFolder(localPath(value));return;
   case 'readFile':return value.side==='local'?readLocalText(value.path):remote('readFile',value);
   case 'writeFile':{if(typeof value.text!=='string'||Buffer.byteLength(value.text)>2*1024*1024)throw new Error('编辑文件限2MB');if(value.side==='remote')return remote('writeFile',value);const p=localPath(value.path);const s=await fs.lstat(p);if(!s.isFile())throw new Error('只编辑普通文件');await fs.writeFile(p,value.text,'utf8');return;}
   case 'mkdir':return value.side==='local'?fs.mkdir(localPath(value.path)):remote('mkdir',value);
   case 'rename':return value.side==='local'?renameLocalPath(value.path,value.destination):remote('rename',value);
   case 'fonts':return fonts();
   case 'fontCatalog':return systemFontCatalog();
   case 'readClipboard':return clipboard.readText();
   case 'writeClipboard':if(typeof value!=='string'||value.length>16*1024*1024)throw new Error('复制内容过大');clipboard.writeText(value);return;
   case 'backgroundData':{if(!value)return'';const p=localPath(value);const ext=path.extname(p).toLowerCase();const mime:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};if(!mime[ext])throw new Error('背景支持PNG/JPEG/WebP图片');if((await fs.stat(p)).size>12*1024*1024)throw new Error('请选择小于12MB的背景图片');return`data:${mime[ext]};base64,${(await fs.readFile(p)).toString('base64')}`;}
   case 'fullscreen':win.setFullScreen(!win.isFullScreen());return;
   default:throw new Error('不支持的操作');
  }
 });
 ipcMain.on('gooeshell:terminal',(event,method,args)=>{if(!trusted(event)||!['terminalInput','terminalBinaryInput','terminalResize','terminalAck'].includes(method)||!Array.isArray(args))return;worker.postMessage({method,args});});
 ipcMain.on('gooeshell:window',(event,action)=>{if(!trusted(event))return;if(action==='minimize')win.minimize();if(action==='maximize')win.isMaximized()?win.unmaximize():win.maximize();if(action==='close')win.close();});
 const dev=process.env.GOOESHELL_DEV_URL;
 if(dev){if(!/^http:\/\/127\.0\.0\.1:5173\/?$/.test(dev))throw new Error('Invalid development URL');await win.loadURL(dev);}else await win.loadFile(path.join(__dirname,'../../dist/index.html'));
 win.show();
});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{if(shuttingDown)return;shuttingDown=true;event.preventDefault();if(worker)worker.postMessage({method:'shutdown',args:[]});setTimeout(()=>{worker?.terminate();app.exit(0);},300);});
