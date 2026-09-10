import type {DesktopApi,AppEvent,FileListing,HostProfile,AppSettings,ConnectionHistoryEntry,HostKeyPreference} from '../shared/types';
import {defaultSettings} from '../shared/defaults';
import {bundledFontFamilies} from '../shared/fonts';
import {previewFontCatalog} from './preview-font-catalog';
export const isPreview=!window.gooeshell;
const listeners=new Set<(event:AppEvent)=>void>();
const emit=(event:AppEvent)=>listeners.forEach(fn=>fn(event));
let previewSettings=structuredClone(defaultSettings);
let previewProfiles:HostProfile[]=[{id:'preview',name:'开发服务器 · 演示',host:'dev.example.com',port:22,username:'developer',auth:'password',rememberHost:true,encoding:'utf8'}];
let previewHostPreferences:HostKeyPreference[]=[];
let previewHistory:ConnectionHistoryEntry[]=[{profile:previewProfiles[0],connectedAt:Date.now()-3600000}];
const previewListing=(p:string,local:boolean):FileListing=>({path:p,entries:(local?[
 ['项目文件','directory',0],['Downloads','directory',0],['deploy.sh','file',1248],['README.md','file',2870]
]:[['app','directory',0],['logs','directory',0],['backups','directory',0],['deploy.sh','file',1248],['nginx.conf','file',2910],['README.md','file',2870]]).map(([name,type,size])=>({name:String(name),path:p.replace(/[\\/]$/,'')+(local?'\\':'/')+name,type:type as 'directory'|'file',size:Number(size),modified:1789027200000,mode:type==='directory'?0o40755:0o100644,owner:'developer',group:'developer'}))});
const unavailable=async()=>{throw new Error('这是浏览器界面预览；请在 gooeshell 桌面程序中进行真实连接和文件操作。');};
const preview:DesktopApi={
 initial:async()=>({profiles:previewProfiles,connectionHistory:previewHistory,hostKeyPreferences:previewHostPreferences,settings:previewSettings,localHome:'C:\\Users\\developer',version:'界面演示 · 不会连接服务器'}),
 setHostKeyPreference:async p=>{previewHostPreferences=[...previewHostPreferences.filter(entry=>entry.host.toLowerCase()!==p.host.toLowerCase()||entry.port!==p.port),...(p.skipVerification?[p]:[])];},
 connectionHistory:async()=>previewHistory,clearConnectionHistory:async()=>{previewHistory=[];},
 saveProfile:async p=>{previewProfiles=[...previewProfiles.filter(x=>x.id!==p.id),p];},deleteProfile:async id=>{previewProfiles=previewProfiles.filter(x=>x.id!==id);},saveSettings:async s=>{previewSettings=s;},
 connect:async r=>{previewHistory=[{profile:{...r.profile},connectedAt:Date.now()},...previewHistory.filter(entry=>entry.profile.host.toLowerCase()!==r.profile.host.toLowerCase()||entry.profile.port!==r.profile.port||entry.profile.username!==r.profile.username)].slice(0,30);const id='preview-'+Date.now();setTimeout(()=>emit({type:'terminal',sessionId:id,data:btoa('\r\n  gooeshell graphical preview\r\n  No server is connected in this browser preview.\r\n\r\n'),bytes:0}),400);return{id,profile:r.profile};},
 disconnect:async id=>emit({type:'sessionClosed',sessionId:id,message:'已关闭演示会话'}),confirmHostKey:async()=>{},
 localList:async p=>previewListing(p||'C:\\Users\\developer',true),remoteList:async r=>previewListing(r.path==='.'?'/home/developer':r.path,false),
 chooseFiles:async()=>[],showInFolder:unavailable,transfer:unavailable,cancelTransfer:async()=>{},
 readFile:async()=>({text:'# 界面预览\n这里显示文件内容。桌面程序支持真实文件读取和保存。\n',truncated:false}),writeFile:unavailable,chmod:unavailable,runFile:unavailable,mkdir:unavailable,rename:unavailable,
 fonts:async()=>[...bundledFontFamilies,...['Cascadia Code','Consolas','Microsoft YaHei','SimSun'].filter(font=>document.fonts.check(`14px \"${font}\"`))],fontCatalog:previewFontCatalog,backgroundData:async()=>'',
 readClipboard:()=>navigator.clipboard.readText(),writeClipboard:text=>navigator.clipboard.writeText(text),
 fullscreen:async()=>{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();},minimize:()=>{},maximize:()=>{},closeWindow:()=>{},
 terminalInput:()=>{},terminalBinaryInput:()=>{},terminalResize:()=>{},terminalAck:()=>{},pathForFile:()=>'',onEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}
};
export const api:DesktopApi=window.gooeshell||preview;
