import {app,BrowserWindow,dialog,ipcMain,shell,session,clipboard,safeStorage} from 'electron';
import path from 'node:path';
import os from 'node:os';
import {promises as fs} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {Store,cleanProfile} from './store';
import {CredentialStore,type CredentialCipher} from './credential-store';
import {IdentityStore} from './identity-store';
import {resolveLoginIdentities,resolveIdentityMetadata,connectionCredentialUpdate} from './identity-resolver';
import {LocalKeyStore} from './local-keys';
import {CommandStore} from './command-store';
import {cleanJumpProfile,jumpCredentialProfile} from './jump-profile';
import {connectionIdentity,connectionConfigurationIdentity} from '../shared/connections';
import {availableFontFamilies,bundledFontFamilies} from '../shared/fonts';
import {readLocalText,readLocalTextFile,readLocalTextRevision,writeLocalTextFile,renameLocalPath} from './local-files';
import {createLocalFile,createLocalDirectory,removeLocalFile} from './file-mutations';
import {listLocalDirectory} from './local-directory';
import {systemFontCatalog} from './font-catalog';
import {configureApplicationMenu} from './application-menu';
import type {AppEvent,CredentialStatus,CredentialUpdate,FileListing,HostProfile,JumpHostProfile} from '../shared/types';
let win:BrowserWindow;let worker:Worker;let store:Store;let credentials:CredentialStore;let identities:IdentityStore;let localKeys:LocalKeyStore;let commands:CommandStore;let shuttingDown=false;let workerAvailable=false;
let identityWrites:Promise<unknown>=Promise.resolve();
function identityMutation<T>(operation:()=>Promise<T>):Promise<T>{const next=identityWrites.catch(()=>{}).then(operation);identityWrites=next;return next;}
const sessionLoginPasswords=new Map<string,string>();
const keyAttempts=new Map<string,{cancelled:boolean;started:boolean;profileId:string}>();
const verifiedKeys=new Map<string,{profile:HostProfile;keyId:string;expires:number;wasKnown:boolean;identityVersion?:number;jumpIdentityVersion?:number}>();
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
function jumpUpdate(profile:HostProfile,update?:CredentialUpdate):CredentialUpdate|undefined{
 if(update?.jump===undefined)return;
 if(!profile.jumpHost||!update.jump||typeof update.jump!=='object')throw new Error('跳板机密码设置无效');
 const value=update.jump;
 return{remember:value.remember,sudoUsesLogin:true,...(value.password!==undefined?{password:value.password}:{}),...(value.passphrase!==undefined?{passphrase:value.passphrase}:{}),...(value.updateSharedIdentity===true?{updateSharedIdentity:true}:{})};
}
async function assertJumpIdentity(jump:JumpHostProfile){
 const expected=connectionConfigurationIdentity(jumpCredentialProfile(jump));
 if((await store.connections()).some(profile=>profile.jumpHost?.id===jump.id&&connectionConfigurationIdentity(jumpCredentialProfile(profile.jumpHost))!==expected))throw new Error('JUMP_PROFILE_CHANGED: 此跳板机的地址或账号与已保存设置不同，请新建一份跳板机设置后重试。');
}
async function connectionCredentialStatus(input:HostProfile):Promise<CredentialStatus>{
 let profile:HostProfile|undefined;
 try{profile=cleanProfile(input);}catch{}
 if(profile)profile=(await resolveLoginIdentities(identities,await store.resolveConnection(profile),{targetPassword:false,jumpPassword:false})).profile;
 const localStatus=async(profile:HostProfile)=>{try{return await credentials.status(profile);}catch(error){if(!profile.loginIdentityId||!/CREDENTIAL_(STORAGE_UNAVAILABLE|DECRYPT_FAILED)/.test(String(error)))throw error;return{...await credentials.emptyStatus(),remember:'persistent' as const,sudoUsesLogin:false};}};
 const status=profile?await localStatus(profile):await credentials.emptyStatus();
 const library=await identities.list();
 const overlay=(status:CredentialStatus,id?:string)=>{if(!id)return;const identity=library.identities.find(item=>item.id===id);if(!identity)throw new Error('LOGIN_IDENTITY_NOT_FOUND: 所选登录身份已不存在，请重新选择。');if(status.sudoUsesLogin)status.remember=identity.remember;status.hasPassword=identity.hasPassword;status.hasPassphrase=false;if(status.sudoUsesLogin)status.hasSudoPassword=identity.hasPassword;};
 overlay(status,profile?.loginIdentityId);
 if(input?.jumpHost){
  let jump:JumpHostProfile|undefined;try{jump=profile?.jumpHost??cleanJumpProfile(input.jumpHost);}catch{}
  status.jump=jump?await localStatus(jumpCredentialProfile(jump)):await credentials.emptyStatus();
  overlay(status.jump,jump?.loginIdentityId);
 }
 return status;
}
async function resolvedHistory(){const history=await store.history();const profiles=await resolveIdentityMetadata(identities,history.map(entry=>entry.profile));return history.map((entry,index)=>({...entry,profile:profiles[index]}));}
async function prepareAuthentication(input:HostProfile,update?:CredentialUpdate,overrides:{password?:string;passphrase?:string;jumpPassword?:string;jumpPassphrase?:string}={}){
 const resolved=await resolveLoginIdentities(identities,await store.resolveConnection(cleanProfile(input)),{targetPassword:overrides.password===undefined&&update?.password===undefined,jumpPassword:overrides.jumpPassword===undefined&&update?.jump?.password===undefined});
 const profile=resolved.profile,jump=profile.jumpHost&&jumpCredentialProfile(profile.jumpHost);
 if(profile.jumpHost)await assertJumpIdentity(profile.jumpHost);
 let targetUpdate=connectionCredentialUpdate(profile,update),hopUpdate=jump?connectionCredentialUpdate(jump,jumpUpdate(profile,update)):undefined;
 const prepareLocal=async(profile:HostProfile,update:CredentialUpdate|undefined)=>{
  try{return{prepared:await credentials.prepareConnect(profile,update),unavailable:false};}
  catch(error){if(!profile.loginIdentityId||!/CREDENTIAL_(STORAGE_UNAVAILABLE|DECRYPT_FAILED)/.test(String(error)))throw error;return{prepared:await credentials.prepareConnect(profile,{remember:'never',sudoUsesLogin:false}),unavailable:true};}
 };
 const targetLocal=await prepareLocal(profile,targetUpdate),jumpLocal=jump?await prepareLocal(jump,hopUpdate):undefined;
 if(targetLocal.unavailable)targetUpdate=undefined;if(jumpLocal?.unavailable)hopUpdate=undefined;
 const preparedCredentials=targetLocal.prepared,preparedJump=jumpLocal?.prepared;
 const password=overrides.password??(resolved.target?update?.password??resolved.target.password:preparedCredentials.secrets.password);
 const passphrase=overrides.passphrase??preparedCredentials.secrets.passphrase;
 const jumpPassword=overrides.jumpPassword??(resolved.jump?update?.jump?.password??resolved.jump.password:preparedJump?.secrets.password);
 const jumpPassphrase=overrides.jumpPassphrase??preparedJump?.secrets.passphrase;
 for(const secret of [password,passphrase,jumpPassword,jumpPassphrase])if(secret!==undefined&&(typeof secret!=='string'||secret.length>16384||secret.includes('\0')))throw new Error('密码内容无效或过长');
 if(profile.auth==='password'&&!password)throw new Error('AUTH_REQUIRED: 请输入此连接的登录密码。');
 if(profile.jumpHost?.auth==='password'&&!jumpPassword)throw new Error('JUMP_AUTH_REQUIRED: 请输入跳板机的登录密码。');
 return{...resolved,jumpProfile:jump,targetUpdate,hopUpdate,preparedCredentials,preparedJump,password,passphrase,jumpPassword,jumpPassphrase};
}
let editorState={dirty:false,busy:false};let discardEditorApproved=false;
function confirmEditorClose():boolean{
 if(editorState.busy){dialog.showMessageBoxSync(win,{type:'info',title:'文件操作尚未完成',message:'请等待文件操作完成后再关闭。',buttons:['继续等待']});return false;}
 return dialog.showMessageBoxSync(win,{type:'question',title:'未保存的修改',message:'编辑器中有未保存的修改。',detail:'关闭后将丢弃这些修改。可以返回编辑器保存，或另存到本地。',buttons:['返回编辑器','放弃修改并关闭'],defaultId:0,cancelId:0,noLink:true})===1;
}
function shutdown(){if(shuttingDown)return;shuttingDown=true;credentials?.clearMemory();identities?.clearMemory();localKeys?.clear();sessionLoginPasswords.clear();verifiedKeys.clear();sessionProfiles.clear();if(worker)worker.postMessage({method:'shutdown',args:[]});setTimeout(()=>{void worker?.terminate();app.exit(0);},300);}
const pending=new Map<string,{resolve:(v:any)=>void,reject:(e:Error)=>void}>();
function remote(method:string,...args:unknown[]):Promise<any>{return new Promise((resolve,reject)=>{if(!workerAvailable){reject(new Error('连接服务暂不可用，请重新启动应用。'));return;}const id=randomUUID();pending.set(id,{resolve,reject});try{worker.postMessage({id,method,args});}catch(error){pending.delete(id);reject(error);}});}
function localPath(value:unknown):string{if(typeof value!=='string'||!value||value.includes('\0'))throw new Error('文件路径无效');return path.resolve(value);}
async function localList(directory:string):Promise<FileListing>{
 return listLocalDirectory(localPath(directory));
}
async function fonts():Promise<string[]>{
 const known=[...bundledFontFamilies];
 if(process.platform!=='win32')return availableFontFamilies((await systemFontCatalog()).map(font=>font.family));
 return new Promise(resolve=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families.Name | ConvertTo-Json -Compress"],{windowsHide:true,timeout:10000,maxBuffer:1024*1024},(err,out)=>{try{const data=JSON.parse(out);resolve(availableFontFamilies(Array.isArray(data)?data:typeof data==='string'?[data]:[]));}catch{resolve(known);}}));
}
const remoteMethods=new Set(['disconnect','confirmHostKey','remoteList','terminalCwd','transfer','cancelTransfer','chmod','runFile']);
if(primaryInstance)app.whenReady().then(async()=>{
 configureApplicationMenu();
 void systemFontCatalog().catch(()=>{});
 app.setName('gooeshell');if(process.platform==='win32')app.setAppUserModelId('com.gooesman.gooeshell');store=new Store(app.getPath('userData'));
 commands=new CommandStore(app.getPath('userData'));
 const credentialCipher:CredentialCipher={
  // Linux's synchronous API exposes the selected backend, so reject its plaintext fallback.
  available:async()=>process.platform==='linux'?safeStorage.isEncryptionAvailable()&&['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(safeStorage.getSelectedStorageBackend()):safeStorage.isAsyncEncryptionAvailable(),
  encrypt:async text=>process.platform==='linux'?safeStorage.encryptString(text):safeStorage.encryptStringAsync(text),
  decrypt:async bytes=>process.platform==='linux'?safeStorage.decryptString(bytes):(await safeStorage.decryptStringAsync(bytes)).result,
 };
 credentials=new CredentialStore(app.getPath('userData'),credentialCipher);
 identities=new IdentityStore(app.getPath('userData'),credentialCipher);
 localKeys=new LocalKeyStore(path.join(app.getPath('userData'),'keys'));
 const sendEvent=(event:AppEvent)=>{if(win&&!win.isDestroyed())win.webContents.send('gooeshell:event',event);};
 const trackClosed=(id:string)=>{sessionProfiles.delete(id);sessionLoginPasswords.delete(id);closedSessions.add(id);if(closedSessions.size>1000)closedSessions.delete(closedSessions.values().next().value!);};
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
   case 'initial':return{profiles:await resolveIdentityMetadata(identities,await store.profiles()),connections:await resolveIdentityMetadata(identities,await store.connections()),groups:await store.groups(),settings:await store.settings(),connectionHistory:await resolvedHistory(),hostKeyPreferences:await store.hostKeyPreferences(),localHome:os.homedir(),version:app.getVersion()};
   case 'connections':return{profiles:await resolveIdentityMetadata(identities,await store.profiles()),connections:await resolveIdentityMetadata(identities,await store.connections()),history:await resolvedHistory(),groups:await store.groups()};
   case 'listLoginIdentities':return identities.list(await store.connections());
   case 'saveLoginIdentity':return identityMutation(async()=>identities.save(value,await store.connections()));
   case 'deleteLoginIdentity':return identityMutation(async()=>identities.delete(value,await store.connections()));
   case 'prepareSshKey':return localKeys.prepare(value);
   case 'generateSshKey':return localKeys.generate(value);
   case 'cancelSshKeyPush':{const attempt=keyAttempts.get(value);if(attempt){attempt.cancelled=true;if(attempt.started)await remote('cancelSshKeyPush',value);}return;}
   case 'pushSshKey':{
    if(!value||typeof value.attemptId!=='string'||!value.attemptId||value.attemptId.length>255)throw new Error('密钥推送请求编号无效');
    if(keyAttempts.has(value.attemptId))throw new Error('此密钥正在推送，请稍候');
    const attempt={cancelled:false,started:false,profileId:value.profile?.id};keyAttempts.set(value.attemptId,attempt);
    try{
     const authentication=await prepareAuthentication(value.profile,value.credentials);
     const {profile,password,passphrase,jumpPassword,jumpPassphrase}=authentication;
     attempt.profileId=profile.id;
     const key=localKeys.resolve(value.keyId),preferences=await store.hostKeyPreferences();
     const wasKnown=(await store.connections()).some(candidate=>candidate.id===profile.id);
     const skipped=(candidate:{host:string;port:number})=>preferences.some(preference=>preference.host===candidate.host.toLowerCase()&&preference.port===candidate.port&&preference.skipVerification);
     if(attempt.cancelled)throw new Error('CONNECTION_CANCELLED: 已取消密钥推送');
     attempt.started=true;
     const result=await remote('pushSshKey',{profile,password,passphrase,jumpPassword,jumpPassphrase,key,attemptId:value.attemptId,skipHostKeyVerification:skipped(profile),skipJumpHostKeyVerification:profile.jumpHost?skipped(profile.jumpHost):false});
     if(attempt.cancelled||shuttingDown)throw new Error('CONNECTION_CANCELLED: 已取消密钥推送');
     if(result.verified&&key.privateKeyPath){
      for(const [id,item] of verifiedKeys)if(item.expires<=Date.now())verifiedKeys.delete(id);
      if(verifiedKeys.size>=100)verifiedKeys.delete(verifiedKeys.keys().next().value!);
      const verificationId=randomUUID();verifiedKeys.set(verificationId,{profile,keyId:value.keyId,expires:Date.now()+10*60_000,wasKnown,identityVersion:authentication.target?.version,jumpIdentityVersion:authentication.jump?.version});
      return{...result,verificationId};
     }
     return result;
    }finally{if(keyAttempts.get(value.attemptId)===attempt)keyAttempts.delete(value.attemptId);}
   }
   case 'applyVerifiedSshKey':return identityMutation(async()=>{
    const verified=verifiedKeys.get(value?.verificationId);
    if(!verified||verified.expires<=Date.now())throw new Error('SSH_KEY_VERIFICATION_EXPIRED: 密钥验证已过期，请重新推送并验证。');
    const key=localKeys.resolve(verified.keyId);if(!key.privateKeyPath)throw new Error('没有可用于登录的本机私钥');
    const checkedKey=await localKeys.prepare({path:key.privateKeyPath,passphrase:key.passphrase});
    if(!checkedKey.privateKeyPath||checkedKey.publicKey!==key.publicKey)throw new Error('SSH_KEY_CHANGED: 私钥文件已变化，请重新推送并验证。');
    const saved=(await store.connections()).find(candidate=>candidate.id===verified.profile.id);
    if((verified.wasKnown&&!saved)||(saved&&connectionConfigurationIdentity(saved)!==connectionConfigurationIdentity(verified.profile)))throw new Error('CONNECTION_IDENTITY_CHANGED: 此连接已修改或删除，请重新验证密钥。');
    const current=await resolveLoginIdentities(identities,saved??verified.profile,{targetPassword:false,jumpPassword:false});
    if(connectionIdentity(current.profile)!==connectionIdentity(verified.profile)||current.target?.version!==verified.identityVersion||current.jump?.version!==verified.jumpIdentityVersion)throw new Error('CONNECTION_IDENTITY_CHANGED: 登录身份已修改，请重新验证密钥。');
    const previous=await credentials.get(verified.profile);
    const profile:HostProfile={...current.profile,loginIdentityId:undefined,auth:'key',privateKeyPath:key.privateKeyPath};
    const update:CredentialUpdate={remember:previous.remember==='never'&&key.passphrase?'session':previous.remember,sudoUsesLogin:previous.sudoUsesLogin,password:'',passphrase:key.passphrase??'',sudoPassword:previous.sudoPassword??''};
    if(previous.sudoUsesLogin){
     const login=verified.profile.loginIdentityId?(await identities.snapshot(verified.profile.loginIdentityId)).password:previous.password;
     if(login){update.sudoUsesLogin=false;update.sudoPassword=login;if(update.remember==='never')update.remember='session';}
    }
    await credentials.prepare(profile,update);
    const favorite=(await store.profiles()).some(candidate=>candidate.id===profile.id);
    const result=await store.saveConnection(profile,favorite);
    verifiedKeys.delete(value.verificationId);
    try{await credentials.save(result,update);}catch{throw new Error('连接已切换为私钥，但私钥口令未能保存。请在连接属性中重新设置。');}
    return result;
   });
   case 'commandLibrary':return commands.library();
   case 'saveCommandGroup':return commands.saveGroup(value);
   case 'deleteCommandGroup':return commands.deleteGroup(value);
   case 'saveCommand':return commands.saveCommand(value);
   case 'deleteCommand':return commands.deleteCommand(value);
   case 'sendCommand':{
    if(!value||typeof value.sessionId!=='string')throw new Error('命令发送请求无效');
    const profile=sessionProfiles.get(value.sessionId);if(!profile)throw new Error('此 SSH 会话已断开，请先连接服务器');
    const effectiveConnectionId=async()=>{
     const saved=(await resolveIdentityMetadata(identities,await store.connections())).find(candidate=>candidate.id===profile.id);
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
   case 'saveConnection':return identityMutation(async()=>{
    const profile=(await resolveLoginIdentities(identities,await store.resolveConnection(cleanProfile(value.profile)),{targetPassword:false,jumpPassword:false})).profile;
    const update=connectionCredentialUpdate(profile,value.credentials);
    const jump=profile.jumpHost&&jumpCredentialProfile(profile.jumpHost),jumpCredentials=jump&&connectionCredentialUpdate(jump,jumpUpdate(profile,value.credentials));
    if(profile.jumpHost)await assertJumpIdentity(profile.jumpHost);
    if(update)await credentials.prepare(profile,update);
    if(jump&&jumpCredentials)await credentials.prepare(jump,jumpCredentials);
    const saved=await store.saveConnection(profile,value.favorite===true);
    try{
     if(update)await credentials.save(saved,update);else await credentials.invalidate(saved);
     if(jump&&jumpCredentials)await credentials.save(jump,jumpCredentials);
    }
    catch(error){throw new Error('连接属性已保存，但密码设置未能保存：'+(error instanceof Error?error.message:'请检查系统加密存储后重试。'));}
    return saved;
   });
   case 'saveProfile':return identityMutation(async()=>{const profile=(await resolveLoginIdentities(identities,cleanProfile(value),{targetPassword:false,jumpPassword:false})).profile;await store.saveProfile(profile);await credentials.invalidate(profile);});
   case 'deleteProfile':return store.deleteProfile(value);
   case 'deleteConnection':return identityMutation(async()=>{
    for(const [id,attempt] of connectAttempts)if(attempt.profileId===value){attempt.cancelled=true;if(attempt.started)await remote('cancelConnect',id);}
    for(const [id,attempt] of keyAttempts)if(attempt.profileId===value){attempt.cancelled=true;if(attempt.started)await remote('cancelSshKeyPush',id);}
    for(const [id,verified] of verifiedKeys)if(verified.profile.id===value)verifiedKeys.delete(id);
    await credentials.forget(value);return store.deleteConnection(value);
   });
   case 'deleteHistory':return store.deleteHistory(value);
   case 'saveGroup':return store.saveGroup(value);
   case 'deleteGroup':return store.deleteGroup(value);
   case 'credentialStatus':return connectionCredentialStatus(value);
   case 'saveCredentials':return identityMutation(async()=>{
    const profile=(await resolveLoginIdentities(identities,await store.resolveConnection(cleanProfile(value.profile)),{targetPassword:false,jumpPassword:false})).profile;const saved=(await store.connections()).find(candidate=>candidate.id===profile.id);
    if(saved&&connectionConfigurationIdentity(saved)!==connectionConfigurationIdentity(profile))throw new Error('CONNECTION_IDENTITY_CHANGED: 此连接的地址或身份已变更，请重新打开连接属性后设置密码。');
    const update=connectionCredentialUpdate(profile,value.credentials)!;
    const jump=profile.jumpHost&&jumpCredentialProfile(profile.jumpHost),jumpCredentials=jump&&connectionCredentialUpdate(jump,jumpUpdate(profile,value.credentials));
    if(profile.jumpHost)await assertJumpIdentity(profile.jumpHost);
    await credentials.prepare(profile,update);
    if(jump&&jumpCredentials)await credentials.prepare(jump,jumpCredentials);
    await credentials.save(profile,update);
    if(jump&&jumpCredentials)await credentials.save(jump,jumpCredentials);
    return connectionCredentialStatus(profile);
   });
   case 'forgetCredentials':return credentials.forget(value);
   case 'forgetJumpCredentials':return credentials.forget(jumpCredentialProfile(cleanJumpProfile(value)).id);
   case 'sendSudoPassword':{
    if(!value||typeof value.sessionId!=='string'||typeof value.submit!=='boolean')throw new Error('密码输入请求无效');
    const profile=sessionProfiles.get(value.sessionId);if(!profile)throw new Error('此 SSH 会话已断开，请先连接服务器');
    const saved=await credentials.get(profile);const password=saved.sudoUsesLogin?(profile.loginIdentityId?sessionLoginPasswords.get(value.sessionId):saved.password):saved.sudoPassword;
    if(!password)throw new Error('SUDO_PASSWORD_REQUIRED: 此连接尚未记住 sudo 密码，请在连接属性中设置。');
    if(/[\x00-\x1f\x7f]/.test(password))throw new Error('密码包含终端控制字符，无法使用快捷输入。');
    if(sessionProfiles.get(value.sessionId)!==profile)throw new Error('此 SSH 会话已断开，请先连接服务器');
    return remote('terminalSecretInput',value.sessionId,password+(value.submit?'\r':''));
   }
   case 'cancelConnect':{const attempt=connectAttempts.get(value);if(attempt){attempt.cancelled=true;if(attempt.started)await remote('cancelConnect',value);}return;}
   case 'connectionHistory':return resolvedHistory();
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
     if(savedProfile&&connectionConfigurationIdentity(savedProfile)!==connectionConfigurationIdentity(profile))profile=await store.resolveConnection({...profile,id:randomUUID(),groupId:undefined});
     attempt.profileId=profile.id;
     const profileWasKnown=catalog.some(candidate=>candidate.id===profile.id);
     if(attempt.cancelled)throw new Error('CONNECTION_CANCELLED: 已取消连接');
     const normalized=(await resolveLoginIdentities(identities,profile,{targetPassword:false,jumpPassword:false})).profile;
     if(value.credentials?.remember==='never')await credentials.save(normalized,connectionCredentialUpdate(normalized,value.credentials)!);
     const normalizedJump=normalized.jumpHost&&jumpCredentialProfile(normalized.jumpHost),normalizedJumpUpdate=jumpUpdate(normalized,value.credentials);
     if(normalizedJump&&normalizedJumpUpdate?.remember==='never')await credentials.save(normalizedJump,connectionCredentialUpdate(normalizedJump,normalizedJumpUpdate)!);
     const authentication=await prepareAuthentication(profile,value.credentials,{password:value.password,passphrase:value.passphrase});
     profile=authentication.profile;
     attempt.profileId=profile.id;
     const {jumpProfile:jump,hopUpdate:jumpCredentials,targetUpdate,preparedCredentials,preparedJump,password,passphrase,jumpPassword,jumpPassphrase}=authentication;
     if(attempt.cancelled)throw new Error('CONNECTION_CANCELLED: 已取消连接');
     const preferences=await store.hostKeyPreferences();
     const skipHostKeyVerification=preferences.some(preference=>preference.host===profile.host.toLowerCase()&&preference.port===profile.port&&preference.skipVerification);
     const skipJumpHostKeyVerification=!!jump&&preferences.some(preference=>preference.host===jump.host.toLowerCase()&&preference.port===jump.port&&preference.skipVerification);
     const effectiveProfile={...profile,...(skipHostKeyVerification?{rememberHost:false}:{}),...(profile.jumpHost&&skipJumpHostKeyVerification?{jumpHost:{...profile.jumpHost,rememberHost:false}}:{})};
     if(attempt.cancelled)throw new Error('CONNECTION_CANCELLED: 已取消连接');
     attempt.started=true;
     const connected=await remote('connect',{profile:effectiveProfile,password,passphrase,skipHostKeyVerification,attemptId,jumpPassword,jumpPassphrase,skipJumpHostKeyVerification});
     if(attempt.cancelled){await remote('disconnect',connected.id);throw new Error('CONNECTION_CANCELLED: 已取消连接');}
     if(closedSessions.has(connected.id))throw new Error('服务器在连接完成前关闭了终端，请重新连接。');
     sessionProfiles.set(connected.id,profile);
     if(profile.loginIdentityId&&password)sessionLoginPasswords.set(connected.id,password);
     if(value.credentials){
      try{
       await identityMutation(async()=>{
       const latest=(await store.connections()).find(candidate=>candidate.id===profile.id);
       if((!profileWasKnown&&!latest)||(latest&&connectionConfigurationIdentity(latest)===connectionConfigurationIdentity(profile))){
        const canCommit=()=>!attempt.cancelled&&!shuttingDown&&!closedSessions.has(connected.id);
        if(targetUpdate){const committedUpdate=connectionCredentialUpdate(profile,{...targetUpdate,password,passphrase})!;await credentials.saveIfUnchanged(profile,committedUpdate,preparedCredentials.revision,canCommit,startedAt);}
        if(authentication.target&&value.credentials.updateSharedIdentity===true)await identities.updatePasswordIfUnchanged(authentication.target,password,canCommit);
        if(jump&&jumpCredentials&&preparedJump){
         await assertJumpIdentity(profile.jumpHost!);
         await credentials.saveIfUnchanged(jump,connectionCredentialUpdate(jump,{...jumpCredentials,password:jumpPassword,passphrase:jumpPassphrase})!,preparedJump.revision,canCommit,startedAt);
         if(authentication.jump&&value.credentials.jump?.updateSharedIdentity===true)await identities.updatePasswordIfUnchanged(authentication.jump,jumpPassword,canCommit);
        }
       }
       });
      }
      catch{if(win&&!win.isDestroyed())win.webContents.send('gooeshell:event',{type:'notice',message:'服务器已连接，但密码保存失败。请在连接属性中检查密码保存设置。'});}
     }
     if(attempt.cancelled){await remote('disconnect',connected.id);throw new Error('CONNECTION_CANCELLED: 已取消连接');}
     try{await identityMutation(async()=>{const current=(await resolveLoginIdentities(identities,profile,{targetPassword:false,jumpPassword:false})).profile;await store.recordConnection(current,true,profileWasKnown);});}
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
   case 'mkdir':return value.side==='local'?createLocalDirectory(value.path):remote('mkdir',value);
   case 'createFile':return value.side==='local'?createLocalFile(value.path):remote('createFile',value);
   case 'removeFile':return value.side==='local'?removeLocalFile(value.path,value.recursive):remote('removeFile',value);
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
