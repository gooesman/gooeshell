import {useEffect,useRef,useState} from 'react';
import {api} from './api';
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
import type {FileListing,ServerTransferRequest,SshSessionInfo} from '../shared/types';
import {parentPath} from '../shared/file-paths';

export default function ServerTransferDialog({sourceSessionId,sources,sessions,close,submit}:{sourceSessionId:string;sources:string[];sessions:SshSessionInfo[];close:()=>void;submit:(requests:ServerTransferRequest[])=>Promise<void>}){
  const targets=sessions.filter(session=>session.id!==sourceSessionId);
  const [target,setTarget]=useState(targets[0]?.id||''),[directory,setDirectory]=useState('.'),[listing,setListing]=useState<FileListing|null>(null),[route,setRoute]=useState<'auto'|'push'|'pull'>('auto');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false);
  const generation=useRef(0),dialog=useRef<HTMLElement>(null),locked=useRef(false);locked.current=busy;
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.querySelector<HTMLElement>('select')?.focus();const keyboard=(event:KeyboardEvent)=>{if([...document.querySelectorAll('[role=dialog]')].at(-1)!==dialog.current)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!locked.current)close();}if(event.key==='Tab'){const controls=[...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1)?.focus();}else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0]?.focus();}}};window.addEventListener('keydown',keyboard);return()=>{window.removeEventListener('keydown',keyboard);if(previous?.isConnected)previous.focus();};},[]);
  const browse=async(id:string,path:string)=>{
    const current=++generation.current;setLoading(true);setError('');
    try{const value=await api.remoteList({sessionId:id,path});if(current===generation.current){setListing(value);setDirectory(value.path);}}
    catch(error){if(current===generation.current){setListing(null);setError(errorText(error));}}
    finally{if(current===generation.current)setLoading(false);}
  };
  useEffect(()=>{setListing(null);if(target)void browse(target,'.');return()=>{generation.current++;};},[target]);
  const available=targets.some(session=>session.id===target)&&sessions.some(session=>session.id===sourceSessionId);
  const footer=<><button className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy||loading||!available||!listing||listing.path!==directory} onClick={async()=>{setBusy(true);setError('');try{await submit(sources.map(source=>({sessionId:sourceSessionId,targetSessionId:target,source,destinationDir:listing!.path,route})));close();}catch(error){setError(errorText(error));}finally{setBusy(false);}}}>开始传输</button></>;
  return <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)close();}}><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-label="传输到其他服务器"><div className="modal-header"><span className="modal-title">传输到其他服务器</span><button className="icon-button" aria-label="关闭" disabled={busy} onClick={close}>×</button></div>
    <div className="modal-body server-transfer-dialog">
      <p className="settings-description">数据直接在两台服务器间传输，不经过本机。自动检测直推与反向拉取；两条路线都不通时停止。</p>
      <div className="form-field"><label htmlFor="server-transfer-target">目标服务器（已连接）</label><select id="server-transfer-target" value={target} disabled={busy} onChange={event=>setTarget(event.target.value)}>{targets.map(session=><option key={session.id} value={session.id}>{session.profile.name} · {session.profile.username}@{session.profile.host}</option>)}</select></div>
      {!targets.length&&<p className="form-note">请先连接目标服务器，再从源文件右键发起传输。</p>}
      <div className="form-field"><label htmlFor="server-transfer-directory">目标目录</label><div className="server-transfer-path"><input id="server-transfer-directory" value={directory} disabled={!target||busy} onChange={event=>setDirectory(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();void browse(target,directory);}}}/><button className="button secondary" disabled={!target||busy||loading} onClick={()=>void browse(target,directory)}>打开</button><button className="button secondary" aria-label="上一级目标目录" disabled={!listing||busy||loading} onClick={()=>void browse(target,parentPath(listing!.path,'remote'))}>↑</button></div></div>
      <div className="server-transfer-directories" aria-label="目标服务器目录">{loading?<span className="muted">读取目录…</span>:listing?.entries.filter(entry=>entry.type==='directory').map(entry=><button type="button" key={entry.path} disabled={busy} onClick={()=>void browse(target,entry.path)}>{entry.name}/</button>)}{listing&&!loading&&!listing.entries.some(entry=>entry.type==='directory')&&<span className="muted">此目录没有子文件夹</span>}</div>
      <div className="form-field"><label htmlFor="server-transfer-route">连接方向</label><select id="server-transfer-route" value={route} disabled={busy} onChange={event=>setRoute(event.target.value as typeof route)}><option value="auto">自动：优先直推，无法连通时尝试反向拉取</option><option value="push">直推：源服务器连接目标服务器</option><option value="pull">反向拉取：目标服务器连接源服务器</option></select></div>
      <ul className="transfer-source-list">{sources.map(source=><li key={source}>{source}</li>)}</ul>
      <p className="form-note">开始后会临时授权两台服务器互连，结束后撤销。保留断点并校验文件完整性，目标有同名项时不覆盖。目前支持 Linux 的普通文件和目录。</p>
      {error&&<div className="form-error" role="alert">{error}</div>}{!available&&targets.length>0&&<div className="form-error">连接已断开，请重新连接后发起传输。</div>}
    </div>
  <div className="modal-footer">{footer}</div></section></div>;
}
