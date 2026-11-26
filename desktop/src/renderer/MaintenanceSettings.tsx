import React,{useEffect,useState} from 'react';
import {api} from './api';
import type {UpdateRelease} from '../shared/update';
import type {AppSettings} from '../shared/types';

import BackupScope,{emptySelection} from './BackupScope';
import {hasSelection,ordinarySelection,type BackupCatalog,type BackupSelection,type SettingSection} from '../shared/backup';

const message=(error:unknown)=>(error instanceof Error?error.message:String(error)).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'');
export default function MaintenanceSettings({onBusyChange,onImported}:{onBusyChange:(busy:boolean)=>void;onImported:(settings?:AppSettings, sections?:SettingSection[])=>Promise<void>}){
 const [release,setRelease]=useState<UpdateRelease|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [progress,setProgress]=useState<{received:number;total:number}|null>(null),[downloaded,setDownloaded]=useState<{file:string;canInstall:boolean}|null>(null);
 const [exportPassword,setExportPassword]=useState(''),[exportConfirm,setExportConfirm]=useState('');
 const [selected,setSelected]=useState(false),[importPassword,setImportPassword]=useState('');
 const [catalog,setCatalog]=useState<BackupCatalog|null>(null),[preview,setPreview]=useState<BackupCatalog|null>(null);
 const [exportScope,setExportScope]=useState<BackupSelection>(emptySelection),[importScope,setImportScope]=useState<BackupSelection>(emptySelection);
 const [revision,setRevision]=useState(0);
 useEffect(()=>{
   let active=true;
   api.backupContents().then(data=>{if(active){setCatalog(data);setExportScope(ordinarySelection(data));}})
     .catch(error=>{if(active)setError(message(error));});
   return ()=>{active=false;};
 },[revision]);
 useEffect(()=>api.onEvent(event=>{if(event.type==='updateProgress')setProgress({received:event.received,total:event.total});}),[]);
 useEffect(()=>()=>{void api.discardConfigPreview();},[]);
 useEffect(()=>{onBusyChange(busy);return()=>onBusyChange(false);},[busy,onBusyChange]);
 const perform=async(fn:()=>Promise<void>)=>{setError('');setNotice('');setBusy(true);try{await fn();}catch(error){setError(message(error));}finally{setProgress(null);setBusy(false);}};
 return <>
  <h3>检查更新</h3>
  <p className="settings-description">从官方 GitHub 获取正式版并校验下载文件。Windows 可确认退出后更新；macOS 和 Linux 请使用下载的更新包安装。</p>
  <button className="button secondary" disabled={busy} onClick={()=>void perform(async()=>{setDownloaded(null);setRelease(await api.checkUpdate());})}>检查更新</button>
  {release&&<div className="settings-description" aria-live="polite">{release.newer?`发现新版本 ${release.version}`:`当前已是最新版本（${release.version}）`}{release.newer&&release.assets.length===0&&'；该平台暂无可用更新包。'}</div>}
  {release?.newer&&release.assets.map(asset=><button key={asset.name} className="button secondary" disabled={busy} style={{margin:'8px 8px 0 0'}} onClick={()=>void perform(async()=>{setDownloaded(null);setProgress({received:0,total:asset.size});const file=await api.downloadUpdate(asset.name);if(file){setDownloaded(file);setNotice('更新包下载并校验完成。');}})}>下载 {asset.name}</button>)}
  {busy&&progress&&<div className="settings-description">下载中 {Math.floor(progress.received/progress.total*100)}% <button className="text-button" onClick={()=>void api.cancelUpdate()}>取消下载</button></div>}
  {downloaded&&<div className="settings-description">{downloaded.canInstall&&<button className="button primary" disabled={busy} onClick={()=>void perform(async()=>{if(await api.installUpdate())setNotice('正在关闭；如取消退出，可再次尝试安装。');})}>安装并重启</button>} <button className="text-button" onClick={()=>void api.showInFolder(downloaded.file)}>在文件夹中显示更新包</button></div>}
  <h3 style={{marginTop:28}}>配置备份</h3>
  <p className="settings-description">选择要导出的内容，并设置备份密码。SSH 私钥和背景图片仅保存路径。</p>
  {catalog&&<BackupScope catalog={catalog} value={exportScope} onChange={setExportScope} disabled={busy}/>}
  <div className="form-field" style={{marginTop:12}}><label htmlFor="backup-export-password">设置备份密码（至少 8 个字符）</label><input id="backup-export-password" type="password" autoComplete="new-password" value={exportPassword} disabled={busy} onChange={e=>setExportPassword(e.target.value)}/></div>
  <div className="form-field"><label htmlFor="backup-export-confirm">再次输入备份密码</label><input id="backup-export-confirm" type="password" autoComplete="new-password" value={exportConfirm} disabled={busy} onChange={e=>setExportConfirm(e.target.value)}/></div>
  <button className="button secondary" disabled={busy||!catalog||!hasSelection(exportScope)} onClick={()=>void perform(async()=>{if(exportPassword!==exportConfirm)throw new Error('两次输入的备份密码不一致');const file=await api.exportConfig({passphrase:exportPassword,selection:exportScope});if(file){setExportPassword('');setExportConfirm('');setNotice('加密备份已导出。');}})}>导出配置</button>
  <h3 style={{marginTop:24}}>导入配置</h3>
  <p className="settings-description">选择备份文件，输入密码后可挑选要恢复的内容。连接、身份和命令将与本机记录合并。</p>
  <button className="button secondary" disabled={busy} onClick={()=>void perform(async()=>{setPreview(null);setImportScope(emptySelection);setImportPassword('');setSelected(await api.chooseConfig());})}>选择备份文件</button>{selected&&<span className="settings-description"> 已选择备份</span>}
  {selected&&<><div className="form-field" style={{marginTop:12}}><label htmlFor="backup-import-password">备份密码</label><input id="backup-import-password" type="password" autoComplete="current-password" value={importPassword} disabled={busy} onChange={e=>{setImportPassword(e.target.value);setPreview(null);}}/></div><button className="button secondary" disabled={busy} onClick={()=>void perform(async()=>{const data=await api.previewConfig(importPassword);setPreview(data);setImportScope({...ordinarySelection(data),settings:[]});setImportPassword('');})}>验证并预览</button></>}
  {preview&&<><BackupScope catalog={preview} value={importScope} onChange={setImportScope} restore disabled={busy}/>
    <button className="button primary" disabled={busy||!hasSelection(importScope)} onClick={()=>void perform(async()=>{
      setPreview(null);setSelected(false);
      try {
        const result=await api.importConfig(importScope);
        const settings=importScope.settings.length?(await api.initial()).settings:undefined;
        await onImported(settings,importScope.settings);
        const summary=[];
        if(importScope.connectionIds.length)summary.push(`新增 ${result.added} 个连接，跳过 ${result.skipped} 个已有连接`);
        if(importScope.groupIds.length)summary.push(`${result.groups} 个连接分组`);
        if(importScope.identityIds.length)summary.push(`${result.identities} 个登录身份`);
        if(importScope.commands)summary.push(`${result.commands} 条命令`);
        if(importScope.settings.length)summary.push(`${importScope.settings.length} 类设置`);
        if(importScope.hostPreferences)summary.push(`${preview.hosts.length} 个地址的指纹偏好`);
        setNotice('导入完成：'+summary.join('，')+'。');
      } catch(error){await onImported();throw error;}
      finally {setCatalog(null);setRevision(previous=>previous+1);}
    })}>合并导入</button></>}
  {notice&&<p className="settings-description" role="status">{notice}</p>}{error&&<div className="form-error" role="alert">{error}</div>}
 </>;
}
