import type {DesktopApi,AppEvent,FileListing,HostProfile,AppSettings,ConnectionHistoryEntry,ConnectionGroup,HostKeyPreference,EditableTextFile,CommandLibrary,LoginIdentitySummary} from '../shared/types';
import {defaultSettings} from '../shared/defaults';
import {bundledFontFamilies} from '../shared/fonts';
import {previewFontCatalog} from './preview-font-catalog';
import {createAppEventHub} from './app-event-hub';
export const isPreview=!window.gooeshell;
const listeners=new Set<(event:AppEvent)=>void>();
const emit=(event:AppEvent)=>listeners.forEach(fn=>fn(event));
let previewSettings=structuredClone(defaultSettings);
let previewProfiles:HostProfile[]=[{id:'preview',name:'开发服务器 · 演示',host:'dev.example.com',port:22,username:'developer',auth:'password',rememberHost:true,encoding:'utf8'}];
let previewHostPreferences:HostKeyPreference[]=[];
let previewHistory:ConnectionHistoryEntry[]=[{profile:previewProfiles[0],connectedAt:Date.now()-3600000}];
let previewConnections=[...previewProfiles];
let previewGroups:ConnectionGroup[]=[];
let previewCommands:CommandLibrary={groups:[],commands:[]};
let previewIdentities:LoginIdentitySummary[]=[];
const previewIdentitySummary=(identity:LoginIdentitySummary):LoginIdentitySummary=>({...identity,references:previewConnections.flatMap(profile=>[
 ...(profile.loginIdentityId===identity.id?[{connectionId:profile.id,name:profile.name,host:profile.host,port:profile.port,role:'target' as const}]:[]),
 ...(profile.jumpHost?.loginIdentityId===identity.id?[{connectionId:profile.id,name:profile.name,host:profile.jumpHost.host,port:profile.jumpHost.port,role:'jump' as const}]:[]),
])});
function resolvedPreview(input:HostProfile):HostProfile{
 const profile=structuredClone(input),target=previewIdentities.find(identity=>identity.id===profile.loginIdentityId),jump=previewIdentities.find(identity=>identity.id===profile.jumpHost?.loginIdentityId);
 if(target){profile.username=target.username;profile.auth='password';profile.privateKeyPath='';}
 if(jump&&profile.jumpHost){profile.jumpHost.username=jump.username;profile.jumpHost.auth='password';profile.jumpHost.privateKeyPath='';}
 return profile;
}
const savePreview=(p:HostProfile,favorite:boolean)=>{previewConnections=[...previewConnections.filter(x=>x.id!==p.id),p];previewProfiles=[...previewProfiles.filter(x=>x.id!==p.id),...(favorite?[p]:[])];previewHistory=previewHistory.map(entry=>entry.profile.id===p.id?{...entry,profile:p}:entry);return p;};
const previewListing=(p:string,local:boolean):FileListing=>({path:p,entries:(local?[
 ['项目文件','directory',0],['Downloads','directory',0],['deploy.sh','file',1248],['README.md','file',2870]
]:[['app','directory',0],['logs','directory',0],['backups','directory',0],['deploy.sh','file',1248],['nginx.conf','file',2910],['README.md','file',2870]]).map(([name,type,size])=>({name:String(name),path:p.replace(/[\\/]$/,'')+(local?'\\':'/')+name,type:type as 'directory'|'file',size:Number(size),modified:1789027200000,mode:type==='directory'?0o40755:0o100644,owner:'developer',group:'developer'}))});
const unavailable=async()=>{throw new Error('这是浏览器界面预览；请在 gooeshell 桌面程序中进行真实连接和文件操作。');};
const previewTexts=new Map<string,EditableTextFile>();
let previewRevision=0;
const preview:DesktopApi={
 listLoginIdentities:async()=>({identities:previewIdentities.map(previewIdentitySummary),secureStorageAvailable:false}),
 saveLoginIdentity:async input=>{
  const existing=previewIdentities.find(identity=>identity.id===input.id);
  if(input.id&&!existing)throw new Error('此登录身份已被删除，请重新加载。');
  if(existing&&input.expectedVersion!==existing.version)throw new Error('此登录身份已被修改，请重新加载。');
  if(!input.name.trim()||!input.username.trim())throw new Error('请填写名称和 SSH 用户名。');
  const identity:LoginIdentitySummary={id:existing?.id??crypto.randomUUID(),name:input.name.trim(),username:input.username.trim(),remember:input.remember,version:(existing?.version??0)+1,hasPassword:input.password===undefined?existing?.hasPassword??false:!!input.password,references:[]};
  previewIdentities=[...previewIdentities.filter(item=>item.id!==identity.id),identity];return previewIdentitySummary(identity);
 },
 deleteLoginIdentity:async id=>{const identity=previewIdentities.find(item=>item.id===id);if(identity&&previewIdentitySummary(identity).references.length)throw new Error('此登录身份仍被连接使用，请先修改相关连接。');previewIdentities=previewIdentities.filter(item=>item.id!==id);},
 prepareSshKey:unavailable,generateSshKey:unavailable,pushSshKey:unavailable,cancelSshKeyPush:async()=>{},applyVerifiedSshKey:unavailable,
 commandLibrary:async()=>structuredClone(previewCommands),
 saveCommandGroup:async group=>{previewCommands.groups=[...previewCommands.groups.filter(value=>value.id!==group.id),structuredClone(group)];},
 deleteCommandGroup:async id=>{previewCommands.groups=previewCommands.groups.filter(group=>group.id!==id);previewCommands.commands=previewCommands.commands.filter(command=>command.groupId!==id);},
 saveCommand:async command=>{if(!previewCommands.groups.some(group=>group.id===command.groupId))throw new Error('请先选择命令分组。');previewCommands.commands=[...previewCommands.commands.filter(value=>value.id!==command.id),structuredClone(command)];},
 deleteCommand:async id=>{previewCommands.commands=previewCommands.commands.filter(command=>command.id!==id);},
 sendCommand:async request=>{const command=previewCommands.commands.find(value=>value.id===request.commandId);if(!command||command.command!==request.expectedCommand)throw new Error('命令已变化，请重新加载。');},
 initial:async()=>({profiles:previewProfiles.map(resolvedPreview),connections:previewConnections.map(resolvedPreview),groups:previewGroups,connectionHistory:previewHistory.map(entry=>({...entry,profile:resolvedPreview(entry.profile)})),hostKeyPreferences:previewHostPreferences,settings:previewSettings,localHome:'C:\\Users\\developer',version:'界面演示 · 不会连接服务器'}),
 connections:async()=>({profiles:previewProfiles.map(resolvedPreview),connections:previewConnections.map(resolvedPreview),history:previewHistory.map(entry=>({...entry,profile:resolvedPreview(entry.profile)})),groups:previewGroups}),
 saveConnection:async r=>savePreview(resolvedPreview(r.profile),r.favorite),
 deleteConnection:async id=>{previewConnections=previewConnections.filter(x=>x.id!==id);previewProfiles=previewProfiles.filter(x=>x.id!==id);previewHistory=previewHistory.filter(x=>x.profile.id!==id);},
 deleteHistory:async id=>{previewHistory=previewHistory.filter(x=>x.profile.id!==id);},
 saveGroup:async group=>{previewGroups=[...previewGroups.filter(x=>x.id!==group.id),group].sort((a,b)=>a.order-b.order);},
 deleteGroup:async id=>{previewGroups=previewGroups.filter(x=>x.id!==id);for(const profile of [...previewConnections])if(profile.groupId===id)savePreview({...profile,groupId:undefined},previewProfiles.some(x=>x.id===profile.id));},
 credentialStatus:async profile=>{const empty={remember:'never' as const,hasPassword:false,hasPassphrase:false,hasSudoPassword:false,sudoUsesLogin:true,secureStorageAvailable:false};const status=(id?:string)=>{const identity=previewIdentities.find(item=>item.id===id);return{...empty,...(identity?{remember:identity.remember,hasPassword:identity.hasPassword}:{})};};return {...status(profile.loginIdentityId),...(profile.jumpHost?{jump:status(profile.jumpHost.loginIdentityId)}:{})};},
 saveCredentials:async()=>{},forgetCredentials:async()=>{},forgetJumpCredentials:async()=>{},sendSudoPassword:unavailable,cancelConnect:async()=>{},
 setHostKeyPreference:async p=>{previewHostPreferences=[...previewHostPreferences.filter(entry=>entry.host.toLowerCase()!==p.host.toLowerCase()||entry.port!==p.port),...(p.skipVerification?[p]:[])];},
 connectionHistory:async()=>previewHistory,clearConnectionHistory:async()=>{previewHistory=[];},
 saveProfile:async p=>{previewProfiles=[...previewProfiles.filter(x=>x.id!==p.id),p];},deleteProfile:async id=>{previewProfiles=previewProfiles.filter(x=>x.id!==id);},saveSettings:async s=>{previewSettings=s;},
 connect:async r=>{const profile=resolvedPreview(r.profile);previewHistory=[{profile,connectedAt:Date.now()},...previewHistory.filter(entry=>entry.profile.host.toLowerCase()!==profile.host.toLowerCase()||entry.profile.port!==profile.port||entry.profile.username!==profile.username)].slice(0,30);const id='preview-'+Date.now();setTimeout(()=>emit({type:'terminal',sessionId:id,data:btoa('\r\n  gooeshell graphical preview\r\n  No server is connected in this browser preview.\r\n\r\n'),bytes:0}),400);return{id,profile};},
 disconnect:async id=>emit({type:'sessionClosed',sessionId:id,message:'已关闭演示会话'}),confirmHostKey:async()=>{},
 localList:async p=>previewListing(p||'C:\\Users\\developer',true),remoteList:async r=>previewListing(r.path==='.'?'/home/developer':r.path,false),
 chooseFiles:async()=>[],showInFolder:unavailable,transfer:unavailable,cancelTransfer:async()=>{},
 readFile:async()=>({text:'# 界面预览\n这里显示文件内容。桌面程序支持真实文件读取和保存。\n',truncated:false}),writeFile:unavailable,chmod:unavailable,runFile:unavailable,mkdir:unavailable,rename:unavailable,createFile:unavailable,removeFile:unavailable,terminalCwd:unavailable,
 readTextFile:async r=>{
  const key=r.side+':'+r.path;let file=previewTexts.get(key);
  if(!file){const text=r.path.endsWith('.sh')?'#!/usr/bin/env bash\nset -euo pipefail\n\n# 部署服务 · 编辑器界面演示\nAPP_DIR="/srv/app"\n\ncd "$APP_DIR"\nprintf "Starting deployment...\\n"\n\nfor service in web worker; do\n  echo "Restarting $service"\n  systemctl restart "$service"\ndone\n':'# gooeshell 文本编辑器\n\n这是浏览器演示文档，不会修改真实文件。\n\n支持查找替换、行号、撤销与重做。\n按 Ctrl+S 保存到本次演示会话。\n';file={text,truncated:false,encoding:'utf8',bom:false,lineEnding:'lf',revision:`demo:${++previewRevision}`,size:new TextEncoder().encode(text).length};previewTexts.set(key,file);}
  return {...file};
 },
 writeTextFile:async r=>{const key=r.side+':'+r.path;if(previewTexts.get(key)?.revision!==r.expectedRevision)throw new Error('TEXT_CONFLICT: 演示文件已变化');const revision=`demo:${++previewRevision}`,size=new TextEncoder().encode(r.text).length;previewTexts.set(key,{text:r.text,truncated:false,encoding:r.encoding,bom:r.bom??false,lineEnding:r.text.includes('\r\n')?'crlf':'lf',revision,size});return{revision,size};},
 saveTextCopy:unavailable,editorState:()=>{},
 fonts:async()=>[...bundledFontFamilies,...['Cascadia Code','Consolas','Microsoft YaHei','SimSun'].filter(font=>document.fonts.check(`14px \"${font}\"`))],fontCatalog:previewFontCatalog,backgroundData:async()=>'',
 readClipboard:()=>navigator.clipboard.readText(),writeClipboard:text=>navigator.clipboard.writeText(text),
 fullscreen:async()=>{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();},minimize:()=>{},maximize:()=>{},closeWindow:()=>{},
 terminalInput:()=>{},terminalBinaryInput:()=>{},terminalResize:()=>{},terminalAck:()=>{},pathForFile:()=>'',onEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}
};
const backend=window.gooeshell||preview;
export const api:DesktopApi={...backend,onEvent:createAppEventHub(handler=>backend.onEvent(handler))};
