import {useEffect,useState} from 'react';
import {api} from './api';
import type {McpStatus} from '../shared/mcp';

export default function McpSettings({onBusyChange}:{onBusyChange:(busy:boolean)=>void}){
  const [status,setStatus]=useState<McpStatus>(),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  useEffect(()=>{let disposed=false;void api.mcpStatus().then(value=>{if(!disposed)setStatus(value);}).catch(error=>{if(!disposed)setError(String(error));});return()=>{disposed=true;};},[]);
  const change=async()=>{
    if(!status)return;setBusy(true);onBusyChange(true);setError('');setMessage('');
    try{setStatus(await api.setMcpEnabled(!status.enabled));}catch(error){setError(error instanceof Error?error.message:String(error));}
    finally{setBusy(false);onBusyChange(false);}
  };
  const json=status?.config?JSON.stringify({mcpServers:{gooeshell:status.config}},null,2):'';
  const copy=async(codex:boolean)=>{
    if(!status?.config)return;const config=status.config;
    const text=codex?`[mcp_servers.gooeshell]\ncommand = ${JSON.stringify(config.command)}\nargs = ${JSON.stringify(config.args)}\ntool_timeout_sec = 90\n\n[mcp_servers.gooeshell.env]\nELECTRON_RUN_AS_NODE = "1"\n`:json;
    try{await api.writeClipboard(text);setMessage('已复制接入配置');setError('');}catch(error){setError(String(error));}
  };
  return <><h3>AI 与 MCP</h3><div className="settings-row"><div><div className="row-title">启用本机 MCP 桥接</div><div className="row-description">允许本机 AI 客户端使用已保存的 SSH 连接、登录身份和 sudo 密码执行命令。</div></div><button type="button" role="switch" aria-label="启用本机 MCP 桥接" aria-checked={status?.enabled||false} disabled={!status?.available||busy} className={`switch${status?.enabled?' checked':''}`} onClick={()=>void change()}/></div>
    <p className="settings-description">GooeShell 需保持运行。已有 SSH 连接会被复用；新建的桥接连接在后台运行，关闭桥接时释放。普通终端连接会保留，已启动的独立 tmux 任务仍在服务器运行。</p>
    {status?.available===false&&<p className="settings-description">请在桌面程序中启用此功能。</p>}
    {status?.config&&<><div className="form-field"><label htmlFor="mcp-config">客户端配置</label><textarea id="mcp-config" readOnly rows={12} value={json} style={{width:'100%',resize:'vertical',fontFamily:'monospace',fontSize:11}}/></div><div className="field-inline" style={{marginTop:12}}><button type="button" className="button secondary" disabled={busy} onClick={()=>void copy(true)}>复制 Codex 配置</button><button type="button" className="button secondary" disabled={busy} onClick={()=>void copy(false)}>复制通用 JSON 配置</button></div></>}
    <p className="settings-description" style={{marginTop:18}}>可用操作：列出连接、列出会话、连接服务器、运行命令、启动后台任务、读取任务状态。普通命令无需 tmux；后台任务在 gooeshell-ai 会话中保留输出和真实退出状态，可使用保存的 sudo 凭据，密码不会输入窗格。每次命令使用独立 Shell，工作目录需显式指定。认证缺失时请在连接设置中保存凭据，首次服务器指纹仍在 GooeShell 中确认。</p>
    {message&&<p role="status" className="settings-description">{message}</p>}{error&&<div className="form-error" role="alert">{error}</div>}
  </>;
}
