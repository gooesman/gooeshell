import {app,BrowserWindow,dialog,ipcMain,shell,session,clipboard,safeStorage} from 'electron';
import path from 'node:path';
import os from 'node:os';
import {promises as fs} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {Store,cleanProfile} from './store';
import {CredentialStore} from './credential-store';
import {CommandStore} from './command-store';
import {connectionIdentity} from '../shared/connections';
import {availableFontFamilies,bundledFontFamilies} from '../shared/fonts';
import {readLocalText,readLocalTextFile,readLocalTextRevision,writeLocalTextFile,renameLocalPath} from './local-files';
import {systemFontCatalog} from './font-catalog';
import type {AppEvent,CredentialUpdate,FileListing,HostProfile} from '../shared/types';
let win:BrowserWindow;let worker:Worker;let store:Store;let credentials:CredentialStore;let commands:CommandStore;let shuttingDown=false;let workerAvailable=false;
// Electron scopes this lock to userData. Different test/portable data directories
// stay independent, while two copies using the same catalog cannot lose writes.
app.setName('gooeshell');
const primaryInstance=app.requestSingleInstanceLock();
let activateWhenReady=false;
function activateWindow(){
 if(!win||win.isDestroyed()){activateWhenReady=true;return;}
 activateWhenReady=false;
 if(win.isMinimized())win.restore();
 if(!win.isVisible())win.show();
 win.focus();
}
if(!primaryInstance)app.quit();
else app.on('second-instance',activateWindow);
const sessionProfiles=new Map<string,HostProfile>();
const closedSessions=new Set<string>();
const connectAttempts=new Map<string,{cancelled:boolean;started:boolean;profileId:string}>();
let editorState={dirty:false,busy:false};let discardEditorApproved=false;
function confirmEditorClose():boolean{
 if(editorState.busy){dialog.showMessageBoxSync(win,{type:'info',title:'文件操作尚未完成',message:'请等待文件操作完成后再关闭。',buttons:['继续等待']});return false;}
 return dialog.showMessageBoxSync(win,{type:'question',title:'未保存的修改',message:'编辑器中有未保存的修改。',detail:'关闭后将丢弃这些修改。可以返回编辑器保存，或另存到本地。',buttons:['返回编辑器','放弃修改并关闭'],defaultId:0,cancelId:0,noLink:true})===1;
}
function shutdown(){if(shuttingDown)return;shuttingDown=true;credentials?.clearMemory();sessionProfiles.clear();if(worker)worker.postMessage({method:'shutdown',args:[]});setTimeout(()=>{void worker?.terminate();app.exit(0);},300);}
const pending=new Map<string,{resolve:(v:any)=>void,reject:(e:Error)=>void}>();
function remote(method:string,...args:unknown[]):Promise<any>{return new Promise((resolve,reject)=>{if(!workerAvailable){reject(new Error('连接服务暂不可用，请重新启动应用。'));return;}const id=randomUUID();pending.set(id,{resolve,reject});try{worker.postMessage({id,method,args});}catch(error){pending.delete(id);reject(error);}});}
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
if(primaryInstance)app.whenReady().then(async()=>{
 void systemFontCatalog().catch(()=>{});
 app.setName('gooeshell');if(process.platform==='win32')app.setAppUserModelId('com.gooesman.gooeshell');store=new Store(app.getPath('userData'));
 commands=new CommandStore(app.getPath('userData'));
 credentials=new CredentialStore(app.getPath('userData'),{
  // Linux's synchronous API exposes the selected backend, so reject its plaintext fallback.
  available:async()=>process.platform==='linux'?safeStorage.isEncryptionAvailable()&&['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(safeStorage.getSelectedStorageBackend()):safeStorage.isAsyncEncryptionAvailable(),
  encrypt:async text=>process.platform==='linux'?safeStorage.encryptString(text):safeStorage.encryptStringAsync(text),
  decrypt:async bytes=>process.platform==='linux'?safeStorage.decryptString(bytes):(await safeStorage.decryptStringAsync(bytes)).result,
 });
 const sendEvent=(event:AppEvent)=>{if(win&&!win.isDestroyed())win.webContents.send('gooeshell:event',event);};
 const trackClosed=(id:string)=>{sessionProfiles.delete(id);closedSessions.add(id);if(closedSessions.size>1000)closedSessions.delete(closedSessions.values().next().value!);};
 const hostQuestions=new Set<string>();
 let restarts:number[]=[];
 const startWorker=()=>{
  const current=new Worker(path.join(__dirname,'worker.js'),{workerData:{knownHostsFile:path.join(app.getPath('userData'),'known-hosts.json')}});
  worker=current;workerAvailable=true;let failed=false;
  const handleFailure=(error:Error)=>{
   if(failed||shuttingDown||worker!==current)return;failed=true;workerAvailable=false;
   for(const value of pending.values())value.reject(error);pending.clear();
   for(const requestId of hostQuestions)sendEvent({type:'hostKeyCancelled',requestId});hostQuestions.clear();
   for(const id of [...sessionProfiles.keys()]){trackClosed(id);sendEvent({type:'sessionClosed',sessionId:id,message:'连接服务意外停止，请重新连接。'});}
   restarts=restarts.filter(time=>Date.now()-time<60000);
   if(restarts.length<3){restarts.push(Date.now());try{startWorker();sendEvent({type:'notice',message:'连接服务已恢复，请在断开的终端中重新连接。'});}catch{sendEvent({type:'notice',message:'连接服务无法恢复，请重新启动应用。'});}}
   else sendEvent({type:'notice',message:'连接服务多次意外停止，请重新启动应用。'});
  };
  current.on('message',message=>{if(worker!==current||failed)return;if(message.event){if(message.event.type==='sessionClosed')trackClosed(message.event.sessionId);if(message.event.type==='hostKey')hostQuestions.add(message.event.requestId);if(message.event.type==='hostKeyCancelled')hostQuestions.delete(message.event.requestId);sendEvent(message.event as AppEvent);return;}const waiting=pending.get(message.id);if(waiting){pending.delete(message.id);message.error?waiting.reject(new Error(message.error)):waiting.resolve(message.value);}});
  current.on('error',handleFailure);current.on('exit',code=>handleFailure(new Error('连接服务已退出（'+code+'）')));
 };
 startWorker();
 const windowIcon=app.isPackaged?path.join(process.resourcesPath,'icon.png'):path.join(app.getAppPath(),'assets','icon.png');
 const initialTheme=(await store.settings()).theme;
 win=new BrowserWindow({icon:windowIcon,width:1460,height:940,minWidth:960,minHeight:640,frame:false,backgroundColor:initialTheme==='light'?'#ffffff':'#0b0b0b',show:false,title:'gooeshell',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:false}});
 win.on('close',event=>{discardEditorApproved=false;if(editorState.dirty||editorState.busy){if(!confirmEditorClose()){event.preventDefault();return;}discardEditorApproved=true;}});
 win.webContents.on('will-prevent-unload',event=>{if(discardEditorApproved||confirmEditorClose()){discardEditorApproved=false;event.preventDefault();}});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate',(event,url)=>{if(url!==win.webContents.getURL())event.preventDefault();});
 session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 const trusted=(event:Electron.IpcMainEvent|Electron.IpcMainInvokeEvent)=>event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame;
 ipcMain.handle('gooeshell:call',async(event,method,args:unknown[])=>{
  if(!trusted(event)||!Array.isArray(args))throw new Error('调用来源无效');
  if(remoteMethods.has(method)){const result=await remote(method,...args);if(method==='confirmHostKey')hostQuestions.delete(args[0] as string);return result;}
  const value:any=args[0];
  switch(method){
   case 'initial':return{profiles:await store.profiles(),connections:await store.connections(),groups:await store.groups(),settings:await store.settings(),connectionHistory:await store.history(),hostKeyPreferences:await store.hostKeyPreferences(),localHome:os.homedir(),version:app.getVersion()};
   case 'connections':return{profiles:await store.profiles(),connections:await store.connections(),history:await store.history(),groups:await store.groups()};
   case 'commandLibrary':return commands.library();
   case 'saveCommandGroup':return commands.saveGroup(value);
   case 'deleteCommandGroup':return commands.deleteGroup(value);
   case 'saveCommand':return commands.saveCommand(value);
   case 'deleteCommand':return commands.deleteCommand(value);
   case 'sendCommand':{
    if(!value||typeof value.sessionId!=='string')throw new Error('命令发送请求无效');
    const profile=sessionProfiles.get(value.sessionId);if(!profile)throw new Error('此 SSH 会话已断开，请先连接服务器');
    const effectiveConnectionId=async()=>{
     const saved=(await store.connections()).find(candidate=>candidate.id===profile.id);
     return saved&&connectionIdentity(saved)!==connectionIdentity(profile)?'live:'+value.sessionId:profile.id;
    };
    const command=await commands.commandForSend(value,await effectiveConnectionId());
    // A saved connection can be retargeted while its previous device is still
    // connected. Its commands now require the same explicit borrowing as any
    // other connection, even though the saved record retained its ID.
    if(value.expectedConnectionId&&value.expectedConnectionId!==await effectiveConnectionId()&&!value.allowOtherConnection)throw new Error('此命令属于其他连接，请确认目标终端后再借用');
    if(sessionProfiles.get(value.sessionId)!==profile)throw new Error('此 SSH 会话已断开，请先连接服务器');
    return remote('terminalCommandInput',value.sessionId,command.command,value.mode,value.bracketedPaste);
   }
   case 'saveConnection':{
    const profile=await store.resolveConnection(cleanProfile(value.profile));
    if(value.credentials&&value.credentials.remember!=='never')await credentials.prepare(profile,value.credentials);
    const saved=await store.saveConnection(profile,value.favorite===true);
    try{if(value.credentials)await credentials.save(saved,value.credentials);else await credentials.invalidate(saved);}
    catch(error){throw new Error('连接属性已保存，但密码设置未能保存：'+(error instanceof Error?error.message:'请检查系统加密存储后重试。'));}
    return saved;
   }
   case 'saveProfile':{await store.saveProfile(value);await credentials.invalidate(cleanProfile(value));return;}
   case 'deleteProfile':return store.deleteProfile(value);
   case 'deleteConnection':{
    for(const [id,attempt] of connectAttempts)if(attempt.profileId===value){attempt.cancelled=true;if(attempt.started)await remote('cancelConnect',id);}
    await credentials.forget(value);return store.deleteConnection(value);
   }
   case 'deleteHistory':return store.deleteHistory(value);
   case 'saveGroup':return store.saveGroup(value);
   case 'deleteGroup':return store.deleteGroup(value);
   case 'credentialStatus':{let profile:HostProfile;try{profile=cleanProfile(value);}catch{return credentials.emptyStatus();}return credentials.status(await store.resolveConnection(profile));}
   case 'saveCredentials':{
    const profile=await store.resolveConnection(cleanProfile(value.profile));const saved=(await store.connections()).find(candidate=>candidate.id===profile.id);
    if(saved&&connectionIdentity(saved)!==connectionIdentity(profile))throw new Error('CONNECTION_IDENTITY_CHANGED: 此连接的地址或身份已变更，请重新打开连接属性后设置密码。');
    await credentials.save(profile,value.credentials);return credentials.status(profile);
   }
   case 'forgetCredentials':return credentials.forget(value);
   case 'sendSudoPassword':{
    if(!value||typeof value.sessionId!=='string'||typeof value.submit!=='boolean')throw new Error('密码输入请求无效');
    const profile=sessionProfiles.get(value.sessionId);if(!profile)throw new Error('此 SSH 会话已断开，请先连接服务器');
    const saved=await credentials.get(profile);const password=saved.sudoUsesLogin?saved.password:saved.sudoPassword;
    if(!password)throw new Error('SUDO_PASSWORD_REQUIRED: 此连接尚未记住 sudo 密码，请在连接属性中设置。');
    if(/[\x00-\x1f\x7f]/.test(password))throw new Error('密码包含终端控制字符，无法使用快捷输入。');
    if(sessionProfiles.get(value.sessionId)!==profile)throw new Error('此 SSH 会话已断开，请先连接服务器');
    return remote('terminalSecretInput',value.sessionId,password+(value.submit?'\r':''));
   }
   case 'cancelConnect':{const attempt=connectAttempts.get(value);if(attempt){attempt.cancelled=true;if(attempt.started)await remote('cancelConnect',value);}return;}
   case 'connectionHistory':return store.history();
   case 'clearConnectionHistory':return store.clearHistory();
   case 'setHostKeyPreference':return store.setHostKeyPreference(value);
   case 'saveSettings':return store.saveSettings(value);
   case 'connect':{
    const startedAt=credentials.connectClock();
    const suppliedProfile=cleanProfile(value?.profile);
    const attemptId=value?.attemptId??randomUUID();
    if(typeof attemptId!=='string'||!attemptId||attemptId.length>255)throw new Error('连接请求编号无效');
    if(attemptId&&connectAttempts.has(attemptId))throw new Error('此连接正在建立，请稍候');
    const attempt={cancelled:false,started:false,profileId:suppliedProfile.id};if(attemptId)connectAttempts.set(attemptId,attempt);
    try{
     let profile=await store.resolveConnection(suppliedProfile);
     const catalog=await store.connections();const savedProfile=catalog.find(candidate=>candidate.id===profile.id);
     // A still-open old tab must not reuse a saved ID that now points at another device.
     if(savedProfile&&connectionIdentity(savedProfile)!==connectionIdentity(profile))profile=await store.resolveConnection({...profile,id:randomUUID(),groupId:undefined});
     attempt.profileId=profile.id;
     const profileWasKnown=catalog.some(candidate=>candidate.id===profile.id);
     if(attempt.cancelled)throw new Error('CONNECTION_CANCELLED: 已取消连接');
     if(value.credentials?.remember==='never')await credentials.save(profile,value.credentials);
     const preparedCredentials=await credentials.prepareConnect(profile,value.credentials);
     const prepared=preparedCredentials.secrets;
     if(attempt.cancelled)throw new Error('CONNECTION_CANCELLED: 已取消连接');
     const password=value.password??prepared.password;const passphrase=value.passphrase??prepared.passphrase;
     for(const secret of [password,passphrase])if(secret!==undefined&&(typeof secret!=='string'||secret.length>16384||secret.includes('\0')))throw new Error('密码内容无效或过长');
     if(profile.auth==='password'&&password===undefined)throw new Error('AUTH_REQUIRED: 请输入此连接的登录密码。');
     const skipHostKeyVerification=(await store.hostKeyPreferences()).some(preference=>preference.host===profile.host.toLowerCase()&&preference.port===profile.port&&preference.skipVerification);
     const effectiveProfile=skipHostKeyVerification?{...profile,rememberHost:false}:profile;
     if(attempt.cancelled)throw new Error('CONNECTION_CANCELLED: 已取消连接');
     attempt.started=true;
     const connected=await remote('connect',{profile:effectiveProfile,password,passphrase,skipHostKeyVerification,attemptId});
     if(attempt.cancelled){await remote('disconnect',connected.id);throw new Error('CONNECTION_CANCELLED: 已取消连接');}
     if(closedSessions.has(connected.id))throw new Error('服务器在连接完成前关闭了终端，请重新连接。');
     sessionProfiles.set(connected.id,profile);
     if(value.credentials){
      try{const latest=(await store.connections()).find(candidate=>candidate.id===profile.id);if(!latest||connectionIdentity(latest)===connectionIdentity(profile))await credentials.saveIfUnchanged(profile,{...value.credentials,password,passphrase} as CredentialUpdate,preparedCredentials.revision,()=>!attempt.cancelled&&!shuttingDown&&!closedSessions.has(connected.id),startedAt);}
      catch{if(win&&!win.isDestroyed())win.webContents.send('gooeshell:event',{type:'notice',message:'服务器已连接，但密码保存失败。请在连接属性中检查密码保存设置。'});}
     }
     if(attempt.cancelled){await remote('disconnect',connected.id);throw new Error('CONNECTION_CANCELLED: 已取消连接');}
     try{await store.recordConnection(profile,true,profileWasKnown);}
     catch{if(win&&!win.isDestroyed())win.webContents.send('gooeshell:event',{type:'notice',message:'服务器已连接，但连接历史未能保存。'});}
     if(attempt.cancelled){await remote('disconnect',connected.id);throw new Error('CONNECTION_CANCELLED: 已取消连接');}
     if(closedSessions.has(connected.id))throw new Error('服务器在连接完成前关闭了终端，请重新连接。');
     return{...connected,profile};
    }finally{if(attemptId&&connectAttempts.get(attemptId)===attempt)connectAttempts.delete(attemptId);}
   }
   case 'localList':return localList(value||os.homedir());
   case 'chooseFiles':{const result=await dialog.showOpenDialog(win,{title:value?.title,properties:value?.directory?['openDirectory']:value?.multiple?['openFile','multiSelections']:['openFile']});return result.canceled?[]:result.filePaths;}
   case 'showInFolder':shell.showItemInFolder(localPath(value));return;
   case 'readFile':return value.side==='local'?readLocalText(value.path):remote('readFile',value);
   case 'readTextFile':return value.side==='local'?readLocalTextFile(value):remote('readTextFile',value);
   case 'writeTextFile':return value.side==='local'?writeLocalTextFile(value):remote('writeTextFile',value);
   case 'saveTextCopy':{
    if(!value||typeof value.name!=='string'||typeof value.text!=='string')throw new Error('文件内容无效');
    const name=path.basename(value.name).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')||'未命名.txt';
    const choice=await dialog.showSaveDialog(win,{title:'另存到本地',defaultPath:path.join(app.getPath('downloads'),name),properties:['showOverwriteConfirmation','createDirectory']});
    if(choice.canceled||!choice.filePath)return null;
    let expectedRevision='missing';
    try{expectedRevision=await readLocalTextRevision(choice.filePath);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await writeLocalTextFile({path:choice.filePath,text:value.text,encoding:value.encoding,bom:value.bom,expectedRevision});
    return choice.filePath;
   }
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
 ipcMain.on('gooeshell:editor-state',(event,state)=>{if(trusted(event)&&typeof state?.dirty==='boolean'&&typeof state?.busy==='boolean')editorState={dirty:state.dirty,busy:state.busy};});
 const dev=process.env.GOOESHELL_DEV_URL;
 if(dev){if(!/^http:\/\/127\.0\.0\.1:5173\/?$/.test(dev))throw new Error('Invalid development URL');await win.loadURL(dev);}else await win.loadFile(path.join(__dirname,'../../dist/index.html'));
 win.show();
 if(activateWhenReady)activateWindow();
});
if(primaryInstance){
 app.on('window-all-closed',shutdown);
 app.on('before-quit',event=>{if(shuttingDown)return;event.preventDefault();if(win&&!win.isDestroyed())win.close();else shutdown();});
}
