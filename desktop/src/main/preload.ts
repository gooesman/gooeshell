import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi, AppEvent } from '../shared/types';
const call = (method:string,...args:unknown[]) => ipcRenderer.invoke('gooeshell:call',method,args);
const api: DesktopApi = {
  initial:()=>call('initial'),saveProfile:p=>call('saveProfile',p),deleteProfile:id=>call('deleteProfile',id),
  connections:()=>call('connections'),saveConnection:r=>call('saveConnection',r),deleteConnection:id=>call('deleteConnection',id),deleteHistory:id=>call('deleteHistory',id),
  saveGroup:g=>call('saveGroup',g),deleteGroup:id=>call('deleteGroup',id),
  credentialStatus:p=>call('credentialStatus',p),saveCredentials:r=>call('saveCredentials',r),forgetCredentials:id=>call('forgetCredentials',id),
  sendSudoPassword:r=>call('sendSudoPassword',r),cancelConnect:id=>call('cancelConnect',id),
  connectionHistory:()=>call('connectionHistory'),clearConnectionHistory:()=>call('clearConnectionHistory'),
  setHostKeyPreference:p=>call('setHostKeyPreference',p),
  saveSettings:s=>call('saveSettings',s),connect:r=>call('connect',r),disconnect:id=>call('disconnect',id),
  confirmHostKey:(id,d)=>call('confirmHostKey',id,d),localList:p=>call('localList',p),remoteList:r=>call('remoteList',r),
  chooseFiles:o=>call('chooseFiles',o),showInFolder:p=>call('showInFolder',p),transfer:r=>call('transfer',r),
  cancelTransfer:id=>call('cancelTransfer',id),readFile:r=>call('readFile',r),writeFile:r=>call('writeFile',r),
  readTextFile:r=>call('readTextFile',r),writeTextFile:r=>call('writeTextFile',r),saveTextCopy:r=>call('saveTextCopy',r),
  editorState:state=>ipcRenderer.send('gooeshell:editor-state',state),
  chmod:r=>call('chmod',r),runFile:r=>call('runFile',r),mkdir:r=>call('mkdir',r),rename:r=>call('rename',r),
  fonts:()=>call('fonts'),backgroundData:p=>call('backgroundData',p),fullscreen:()=>call('fullscreen'),
  fontCatalog:()=>call('fontCatalog'),
  readClipboard:()=>call('readClipboard'),writeClipboard:text=>call('writeClipboard',text),
  minimize:()=>ipcRenderer.send('gooeshell:window','minimize'),maximize:()=>ipcRenderer.send('gooeshell:window','maximize'),closeWindow:()=>ipcRenderer.send('gooeshell:window','close'),
  terminalInput:(id,data)=>ipcRenderer.send('gooeshell:terminal','terminalInput',[id,data]),
  terminalBinaryInput:(id,data)=>ipcRenderer.send('gooeshell:terminal','terminalBinaryInput',[id,data]),
  terminalResize:(id,cols,rows)=>ipcRenderer.send('gooeshell:terminal','terminalResize',[id,cols,rows]),
  terminalAck:(id,bytes)=>ipcRenderer.send('gooeshell:terminal','terminalAck',[id,bytes]),
  pathForFile:file=>webUtils.getPathForFile(file),
  onEvent:handler=>{ const listener=(_event:unknown,data:AppEvent)=>handler(data); ipcRenderer.on('gooeshell:event',listener);return()=>ipcRenderer.removeListener('gooeshell:event',listener);}
};
contextBridge.exposeInMainWorld('gooeshell',api);
