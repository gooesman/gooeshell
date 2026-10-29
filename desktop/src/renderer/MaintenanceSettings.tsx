import React,{useEffect,useState} from 'react';
import {api} from './api';
import type {UpdateRelease} from '../shared/update';
import type {AppSettings} from '../shared/types';

const message=(error:unknown)=>(error instanceof Error?error.message:String(error)).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'');
export default function MaintenanceSettings({onBusyChange,onImported}:{onBusyChange:(busy:boolean)=>void;onImported:(settings?:AppSettings)=>Promise<void>}){
 const [release,setRelease]=useState<UpdateRelease|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [progress,setProgress]=useState<{received:number;total:number}|null>(null),[downloaded,setDownloaded]=useState<{file:string;canInstall:boolean}|null>(null);
 const [secret,setSecret]=useState(false),[exportPassword,setExportPassword]=useState(''),[exportConfirm,setExportConfirm]=useState('');
 const [selected,setSelected]=useState(false),[importPassword,setImportPassword]=useState(''),[applySettings,setApplySettings]=useState(false),[applyHostPreferences,setApplyHostPreferences]=useState(false);
 const [preview,setPreview]=useState<{connections:number;groups:number;identities:number;commands:number;hasSecrets:boolean;skipVerificationHosts:{host:string;port:number}[]}|null>(null);
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
  <p className="settings-description">备份连接、分组、登录身份、命令、界面设置及指纹偏好；使用备份密码加密。可选包含长期保存的登录、跳板机及 sudo 密码。SSH 私钥文件、临时密码、服务器指纹和最近连接记录不包含在备份中；换设备后可能需要重新选择私钥文件。</p>
  <label><input type="checkbox" checked={secret} disabled={busy} onChange={e=>setSecret(e.target.checked)}/> 包含长期保存的密码和私钥口令</label>
  <div className="form-field" style={{marginTop:12}}><label htmlFor="backup-export-password">设置备份密码（至少 8 个字符）</label><input id="backup-export-password" type="password" autoComplete="new-password" value={exportPassword} disabled={busy} onChange={e=>setExportPassword(e.target.value)}/></div>
  <div className="form-field"><label htmlFor="backup-export-confirm">再次输入备份密码</label><input id="backup-export-confirm" type="password" autoComplete="new-password" value={exportConfirm} disabled={busy} onChange={e=>setExportConfirm(e.target.value)}/></div>
  <button className="button secondary" disabled={busy} onClick={()=>void perform(async()=>{if(exportPassword!==exportConfirm)throw new Error('两次输入的备份密码不一致');const file=await api.exportConfig({passphrase:exportPassword,includeSecrets:secret});if(file){setExportPassword('');setExportConfirm('');setNotice('加密备份已导出。');}})}>导出配置</button>
  <h3 style={{marginTop:24}}>导入配置</h3>
  <p className="settings-description">导入会合并连接和命令，不覆盖已有连接或同标识的已有登录身份；界面设置仅在勾选后应用。请保存好当前设置后再导入。</p>
  <button className="button secondary" disabled={busy} onClick={()=>void perform(async()=>{setPreview(null);setApplySettings(false);setApplyHostPreferences(false);setImportPassword('');setSelected(await api.chooseConfig());})}>选择备份文件</button>{selected&&<span className="settings-description"> 已选择备份</span>}
  {selected&&<><div className="form-field" style={{marginTop:12}}><label htmlFor="backup-import-password">备份密码</label><input id="backup-import-password" type="password" autoComplete="current-password" value={importPassword} disabled={busy} onChange={e=>{setImportPassword(e.target.value);setPreview(null);}}/></div><button className="button secondary" disabled={busy} onClick={()=>void perform(async()=>{setPreview(await api.previewConfig(importPassword));setImportPassword('');})}>验证并预览</button></>}
  {preview&&<><p className="settings-description">{preview.connections} 个连接、{preview.groups} 个连接分组、{preview.identities} 个登录身份、{preview.commands} 条命令；{preview.hasSecrets?'包含已保存密码':'不含密码'}。</p><label><input type="checkbox" disabled={busy} checked={applySettings} onChange={e=>setApplySettings(e.target.checked)}/> 应用备份中的界面及快捷键设置</label>{preview.skipVerificationHosts.length>0&&<div style={{marginTop:10}}><label><input type="checkbox" disabled={busy} checked={applyHostPreferences} onChange={e=>setApplyHostPreferences(e.target.checked)}/> 导入 {preview.skipVerificationHosts.length} 个地址的跳过指纹验证设置</label><p className="settings-description">勾选后，这些地址的 SSH 主机身份不会经过指纹验证。</p><details><summary>查看地址</summary><div style={{maxHeight:140,overflow:"auto"}}>{preview.skipVerificationHosts.map(item=><div key={`${item.host}:${item.port}`}>{item.host}:{item.port}</div>)}</div></details></div>}<div style={{marginTop:12}}><button className="button primary" disabled={busy} onClick={()=>void perform(async()=>{setPreview(null);setSelected(false);let result;try{result=await api.importConfig({applySettings,applyHostPreferences});}catch(error){await onImported();throw error;}const initial=await api.initial();await onImported(applySettings?initial.settings:undefined);setNotice(`导入完成：新增 ${result.added} 个连接，跳过 ${result.skipped} 个已有连接。`);})}>合并导入</button></div></>}
  {notice&&<p className="settings-description" role="status">{notice}</p>}{error&&<div className="form-error" role="alert">{error}</div>}
 </>;
}
