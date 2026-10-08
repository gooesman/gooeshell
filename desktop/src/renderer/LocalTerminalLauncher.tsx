import { useId, useState } from 'react';
import { FolderOpen, RotateCcw, SquareTerminal } from 'lucide-react';
import { api } from './api';
import type { CreateLocalSessionRequest, LocalShellInfo } from '../shared/types';
import './local-terminal.css';

export default function LocalTerminalLauncher({ shells, defaultCwd, busy, error, onOpen }: {
  shells: LocalShellInfo[]; defaultCwd: string; busy?: boolean; error?: string;
  onOpen: (request: CreateLocalSessionRequest) => void;
}) {
  const id = useId();
  const [shell, setShell] = useState('');
  const [cwd, setCwd] = useState('');
  const [directoryError, setDirectoryError] = useState('');
  const available = shells.filter(option => option.available);
  const selectedShell = available.find(option => option.id === shell)?.id || available.find(option => option.isDefault)?.id || available[0]?.id || '';
  const chooseDirectory = async () => {
    setDirectoryError('');
    try { const [path] = await api.chooseFiles({ directory: true, title: '选择本地终端启动目录' }); if (path) setCwd(path); }
    catch (cause) { setDirectoryError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <form className="local-terminal-launcher" aria-label="本地终端" onSubmit={event => { event.preventDefault(); if (!busy && selectedShell) onOpen({ shell: selectedShell, ...(cwd.trim() ? { cwd: cwd.trim() } : {}) }); }}>
    <div className="local-terminal-heading"><SquareTerminal size={18} /><strong>本地终端</strong><span>在此电脑运行命令</span></div>
    <label className="local-shell-field" htmlFor={`${id}-shell`}>Shell<select id={`${id}-shell`} aria-label="本地终端 Shell" value={selectedShell} disabled={busy || !available.length} onChange={event => setShell(event.target.value)}>{shells.length ? shells.map(option => <option key={option.id} value={option.id} disabled={!option.available}>{option.name}{!option.available ? '（未安装）' : option.isDefault ? '（默认）' : ''}</option>) : <option value="">正在读取 Shell…</option>}</select></label>
    <label className="local-cwd-field" htmlFor={`${id}-cwd`}>启动目录<span className="local-directory-controls"><input id={`${id}-cwd`} aria-label="本地终端启动目录" value={cwd} disabled={busy} placeholder={defaultCwd || '默认用户目录'} title={cwd || defaultCwd} onChange={event => setCwd(event.target.value)} /><button type="button" className="icon-button" title="选择启动目录" aria-label="选择本地终端启动目录" disabled={busy} onClick={() => void chooseDirectory()}><FolderOpen size={16} /></button><button type="button" className="icon-button" title="使用默认目录" aria-label="使用默认启动目录" disabled={busy || !cwd} onClick={() => setCwd('')}><RotateCcw size={14} /></button></span></label>
    <button type="submit" className="button primary local-terminal-open" disabled={busy || !selectedShell}><SquareTerminal size={15} />{busy ? '正在打开…' : '打开本地终端'}</button>
    {(directoryError || error) && <div className="form-error" role="alert">{directoryError || error}</div>}
  </form>;
}
