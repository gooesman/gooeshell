import React, { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, Plus, RefreshCw, ArrowUp, FolderOpen, Upload, PanelBottom, Maximize, Settings2, Server, FileText, ChevronDown, ChevronUp, Minus, Square, Sun, Moon, Check, SquareTerminal } from 'lucide-react';
import { api, isPreview } from './api';
import { defaultSettings } from '../shared/defaults';
import { parentPath } from '../shared/file-paths';
import FilePane from './FilePane';
import ConnectionHome from './ConnectionHome';
import ConnectionDialog from './ConnectionDialog';
import ConnectionAuthDialog from './ConnectionAuthDialog';
import ConnectionSidebar, { connectionIcons } from './ConnectionSidebar';
import useConnections from './useConnections';
import CommandSidebar from './CommandSidebar';
import { terminalBackground } from './terminal-theme';
import { sameConnection } from '../shared/connections';
import './workspace.css';
import { FileActionDialog, FileContextMenu, type FileAction, type FileTarget } from './FileActions';
import './file-actions.css';
import SettingsDialog from './SettingsDialog';
import KeyPushDialog from './KeyPushDialog';
import type { EditorTarget } from './TextEditorDialog';
const TextEditorDialog = lazy(() => import('./TextEditorDialog'));
import TerminalView, { keyChord, mouseChord, type TerminalCommandSender } from './TerminalView';
import type { AppEvent, AppSettings, CommandLibrary, SavedCommand, ConnectionGroup, CredentialUpdate, HostKeyPreference, FileEntry, FileListing, HostProfile, SessionInfo, TransferInfo, TransferRequest } from '../shared/types';

type Side = 'local' | 'remote';
type Elevation = { elevated?: boolean; sudoPassword?: string };
type Toast = { id: number; message: string; error?: boolean };
type SudoTask = { label: string; run: (elevation: Elevation) => Promise<unknown> };
type Context = FileTarget & { x: number; y: number; entry?: FileEntry; entries: FileEntry[] };
type TransferDraft = { sessionId: string; direction: TransferRequest['direction']; sources: string[]; destinationDir: string; connectionName: string };
const activeTransferStates: TransferInfo['state'][] = ['queued', 'checking', 'packing', 'transferring', 'extracting'];
const dragMime = 'application/x-gooeshell-files';
const appIcon = './gooeshell-icon.png';
function sameEndpoint(a: {host:string;port:number}, b: {host:string;port:number}) { return a.host.trim().replace(/^\[|\]$/g, '').toLowerCase() === b.host.trim().replace(/^\[|\]$/g, '').toLowerCase() && a.port === b.port; }
function keyCombo(e: KeyboardEvent | React.KeyboardEvent) { if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return ''; return keyChord('nativeEvent' in e ? e.nativeEvent as KeyboardEvent : e); }
const mouseNames: Record<string, string> = { MouseMiddle: '中键单击', MouseRight: '右键单击', MouseBack: '后退侧键', MouseForward: '前进侧键' };
function shortcutLabel(value: string) { return value.split('+').map(part => mouseNames[part] || ({ Space: '空格', Enter: '回车', Backspace: '退格', Delete: '删除键', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' } as Record<string, string>)[part] || part).join(' + '); }
function bytes(value: number) { if (!Number.isFinite(value) || value < 0) return '—'; if (value < 1024) return `${value} B`; const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024))); return `${(value / 1024 ** unit).toFixed(value / 1024 ** unit < 10 ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`; }
function basename(path: string) { return path.replace(/[\\/]$/, '').split(/[\\/]/).pop() || path; }
function joinPath(base: string, leaf: string, side: Side) { const sep = side === 'local' && base.includes('\\') ? '\\' : '/'; return base.replace(/[\\/]$/, '') + sep + leaf; }
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function transferErrorMessage(message: string) { return /PERMISSION_DENIED|permission denied|权限不足/i.test(message) ? '文件传输权限不足。当前不支持 sudo 文件传输，请选择当前账号有权限的源文件和目标目录后重新传输。' : message; }
function modeText(mode?: number) { if (mode === undefined) return '—'; return [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 0o4, 0o2, 0o1].map((bit, i) => mode & bit ? 'rwx'[i % 3] : '-').join(''); }
function IconButton({ children, title, onClick, disabled, active }: { children: React.ReactNode; title: string; onClick?: () => void; disabled?: boolean; active?: boolean }) { const icons: Record<string, typeof X> = { '×': X, '+': Plus, '↻': RefreshCw, '↑': ArrowUp, '…': FolderOpen, '⇧': Upload, '▥': PanelBottom, '⛶': Maximize, '⚙': Settings2 }; const Icon = typeof children === 'string' ? icons[children] : undefined; return <button type="button" className={`icon-button${active ? ' active' : ''}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>{Icon ? <Icon size={15} strokeWidth={1.7} /> : children}</button>; }
function Modal({ title, children, footer, close, wide, compact, className = '' }: { className?: string; title: string; children: React.ReactNode; footer?: React.ReactNode; close: () => void; wide?: boolean; compact?: boolean }) { const element = useRef<HTMLElement>(null); const closeRef = useRef(close); closeRef.current = close; useEffect(() => { const previous = document.activeElement as HTMLElement | null; const handle = (event: KeyboardEvent) => { const dialogs = document.querySelectorAll('[role="dialog"]'); if (dialogs[dialogs.length - 1] !== element.current) return; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); } if (event.key === 'Tab') { const controls = [...(element.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || [])].filter(control => control.offsetParent !== null); const first = controls[0], last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } } }; window.addEventListener('keydown', handle); if (!element.current?.contains(document.activeElement)) element.current?.querySelector<HTMLElement>('input, button')?.focus(); return () => { window.removeEventListener('keydown', handle); if (previous?.isConnected) previous.focus(); }; }, []); return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}><section ref={element} className={`modal${wide ? ' wide' : ''}${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-header"><span className="modal-title">{title}</span><IconButton title="关闭" onClick={close}>×</IconButton></div>{children}{footer && <div className="modal-footer">{footer}</div>}</section></div>; }

function TransferDialog({ draft, disconnected, close, submit }: { draft: TransferDraft; disconnected: boolean; close: () => void; submit: (mode: 'direct' | 'archive') => void }) {
  const [mode, setMode] = useState<'direct' | 'archive'>('direct');
  const action = draft.direction === 'upload' ? '上传' : '下载';
  return <Modal title={`选择${action}方式`} compact className="transfer-dialog" close={close} footer={<><button className="button secondary" onClick={close}>取消</button><button type="submit" form="transfer-form" className="button primary" disabled={disconnected}>开始{action}</button></>}>
    <form id="transfer-form" className="modal-body" onSubmit={event => { event.preventDefault(); if (!disconnected) submit(mode); }}>
      <div className="file-action-location"><strong>{draft.connectionName}</strong><span>{action} {draft.sources.length} 项到{draft.direction === 'upload' ? '远程' : '本地'}目录</span><span className="dialog-path">{draft.destinationDir}</span></div>
      <ul className="transfer-source-list" aria-label="待传输文件">{draft.sources.map(source => <li key={source} title={source}>{source}</li>)}</ul>
      <fieldset className="transfer-mode-options"><legend>传输方式</legend>
        <label className={`transfer-mode-choice${mode === 'direct' ? ' selected' : ''}`}><input type="radio" name="transfer-mode" value="direct" checked={mode === 'direct'} onChange={() => setMode('direct')} /><span><strong>普通传输</strong><span>按文件原样{action}，支持断点续传。</span></span></label>
        <label className={`transfer-mode-choice${mode === 'archive' ? ' selected' : ''}`}><input type="radio" name="transfer-mode" value="archive" checked={mode === 'archive'} onChange={() => setMode('archive')} /><span><strong>打包压缩传输</strong><span>每个选中项分别压缩，传完自动解压并保留目录结构。适合包含大量小文件的文件夹。</span></span></label>
      </fieldset>
      {mode === 'archive' && <p className="transfer-mode-note">远程服务器需支持 Python 3。目标有同名文件或文件夹时会停止，不覆盖；成功后自动清理临时压缩包，失败后需重新打包传输。</p>}
      {disconnected && <div className="form-error" role="alert">此服务器连接已关闭，请重新连接后发起传输。</div>}
    </form>
  </Modal>;
}

function remainingTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '估算中';
  if (seconds < 1) return '即将传完';
  if (seconds < 60) return `剩余约 ${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `剩余约 ${Math.ceil(seconds / 60)} 分钟`;
  if (seconds < 86400) return `剩余约 ${(seconds / 3600).toFixed(1)} 小时`;
  return `剩余约 ${Math.ceil(seconds / 86400)} 天`;
}
function TransferRow({ transfer, cancel, retry, context, busy }: { transfer: TransferInfo; cancel: () => void; retry: () => void; context: (event: React.MouseEvent) => void; busy: boolean }) {
  const preparing = transfer.state === 'packing' || transfer.state === 'extracting';
  const checking = transfer.state === 'checking';
  const verification = checking ? transfer.verification : undefined;
  const indeterminate = (preparing && !transfer.total) || (checking && (!verification || !(verification.total > 0)));
  const archived = transfer.mode === 'archive';
  const transferring = transfer.state === 'transferring';
  const speed = transfer.bytesPerSecond;
  const validSpeed = speed !== undefined && Number.isFinite(speed) && speed >= 0;
  const eta = validSpeed && speed > 0 && transfer.total > 0 ? remainingTime(Math.max(0, transfer.total - transfer.done) / speed) : '估算中';
  const status = verification ? verification.stage === 'resume' ? '校验已有内容' : '校验文件' : ({ queued: '等待中', checking: '检查文件中', packing: '打包压缩中', transferring: '传输中', extracting: '自动解压中', completed: '已完成', cancelled: '已取消', failed: '失败' })[transfer.state];
  const progressDone = verification?.done ?? transfer.done, progressTotal = verification?.total ?? transfer.total;
  const percent = transfer.state === 'completed' ? 100 : indeterminate ? 0 : progressTotal > 0 ? Math.max(0, Math.min(100, progressDone / progressTotal * 100)) : 0;
  const detail = verification ? `已校验 ${bytes(verification.done)} / ${bytes(verification.total)}` : checking ? '正在检查文件' : archived ? preparing ? transfer.total ? `文件 · ${bytes(transfer.done)} / ${bytes(transfer.total)}` : (transfer.state === 'packing' ? '正在生成压缩包' : '正在恢复文件与目录') : transfer.state === 'transferring' ? `压缩包 · ${bytes(transfer.done)} / ${bytes(transfer.total)}` : transfer.state === 'completed' ? '已传输并自动解压' : transfer.state === 'queued' ? '等待开始' : '任务已停止' : `${bytes(transfer.done)} / ${bytes(transfer.total)}`;
  return <div className="transfer-row" data-transfer-id={transfer.id} tabIndex={0} onContextMenu={context} title={transfer.error || `${archived ? '打包压缩传输 · ' : ''}${transfer.source} → ${transfer.destination}`}>
    <span className="transfer-direction">{transfer.direction === 'upload' ? '↑' : '↓'}</span><span className="transfer-name">{transfer.name}{archived && <span className="transfer-mode-badge">压缩</span>}</span><span className="transfer-detail" title={detail}>{detail}</span>
    <div className="transfer-metrics" title={transferring ? archived ? '速度和剩余时间按压缩包估算，不含打包与解压时间' : '按近期实际传输速度估算剩余时间' : undefined}>{transferring && <><span className="transfer-speed">{validSpeed ? `${bytes(Math.round(speed))}/s` : '测速中'}</span><span className="transfer-eta">{eta}</span></>}{verification && !indeterminate && <span className="transfer-verification-percent">{Math.round(percent)}%</span>}</div>
    <div className={`transfer-progress${indeterminate ? ' indeterminate' : ''}`} role="progressbar" aria-label={`${transfer.name}：${status}${archived && transfer.state === 'transferring' ? '（压缩包）' : ''}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : Math.round(percent)}><span style={{ width: indeterminate ? '40%' : `${percent}%` }} /></div><span className={`transfer-status ${transfer.state}`}>{busy ? '正在停止…' : status}</span>
    {activeTransferStates.includes(transfer.state) ? <IconButton title="取消传输" disabled={busy} onClick={cancel}>×</IconButton> : transfer.state === 'failed' || transfer.state === 'cancelled' ? <IconButton title={archived ? '重新打包传输' : '继续传输'} disabled={busy} onClick={retry}>↻</IconButton> : <span style={{ width: 23 }} />}
  </div>;
}

function PermissionsDialog({ entry, apply, close }: { entry: FileEntry; apply: (mode: number) => Promise<void>; close: () => void }) {
  const [mode, setMode] = useState((entry.mode ?? 0o644) & 0o777); const [octal, setOctal] = useState(((entry.mode ?? 0o644) & 0o777).toString(8).padStart(3, '0')); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return <Modal title="文件权限" compact close={close} footer={<><button className="button secondary" onClick={close}>取消</button><button className="button primary" disabled={busy || !/^[0-7]{3}$/.test(octal)} onClick={async () => { setBusy(true); try { await apply(mode); close(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }}>应用权限</button></>}><div className="modal-body"><div className="dialog-path">{entry.path}</div><table className="permission-table"><thead><tr><th>身份</th><th>读取 r</th><th>写入 w</th><th>执行 x</th></tr></thead><tbody>{[['所有者', 6], ['所属组', 3], ['其他人', 0]].map(([name, shift]) => <tr key={name}><td>{name}</td>{[4, 2, 1].map(bit => { const mask = bit << Number(shift); return <td key={bit}><input aria-label={`${name}${{ 4: '读取', 2: '写入', 1: '执行' }[bit]}`} type="checkbox" checked={!!(mode & mask)} onChange={e => { const next = e.target.checked ? mode | mask : mode & ~mask; setMode(next); setOctal(next.toString(8).padStart(3, '0')); }} /></td>; })}</tr>)}</tbody></table><div className="permission-octal"><span>八进制权限</span><input aria-label="八进制权限" value={octal} maxLength={3} inputMode="numeric" pattern="[0-7]{3}" onChange={e => { setOctal(e.target.value); if (/^[0-7]{3}$/.test(e.target.value)) setMode(parseInt(e.target.value, 8)); }} /><span className="mono">{modeText(mode)}</span></div><p className="settings-description" style={{ marginTop: 14 }}>读取：查看内容；写入：修改内容。执行：运行文件，或进入目录。仅修改此项，不递归修改子目录。已有特殊位会保留，此处不能新增或移除特殊位。</p>{((entry.mode || 0) & 0o7000) !== 0 && <div className="form-note">已有特殊位：{[[0o4000, 'setuid'], [0o2000, 'setgid'], [0o1000, 'sticky']].filter(([bit]) => ((entry.mode || 0) & Number(bit)) !== 0).map(([, name]) => name).join('、')}。保存时会保留。</div>}{error && <div className="form-error">{error}</div>}</div></Modal>;
}

function SudoDialog({ task, close, run }: { task: SudoTask; close: () => void; run: (password: string) => Promise<void> }) { const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); return <Modal title="为本次操作使用 sudo" compact close={() => { if (!busy) close(); }} footer={<><button className="button secondary" disabled={busy} onClick={close}>取消</button><button form="sudo-form" type="submit" className="button primary" disabled={busy}>{busy ? '正在执行…' : '使用 sudo 执行'}</button></>}><form id="sudo-form" className="modal-body" onSubmit={async e => { e.preventDefault(); setBusy(true); try { await run(password); setPassword(''); close(); } catch (e) { setError(errorText(e)); setPassword(''); } finally { setBusy(false); } }}><p className="sudo-description">当前账号权限不足，或你选择了 sudo 运行。提升权限仅用于下面这一次操作。</p><div className="dialog-path">{task.label}</div><div className="form-field" style={{ marginTop: 17 }}><label htmlFor="sudo-password">服务器 sudo 密码</label><input id="sudo-password" type="password" value={password} autoFocus autoComplete="new-password" onChange={e => setPassword(e.target.value)} placeholder="免密 sudo 可留空" /></div><div className="form-note">不会保存密码，不改变终端身份。服务器必须已允许此账号使用 sudo。</div>{error && <div className="form-error" role="alert">{error}</div>}</form></Modal>; }

export default function App() {
  const [hostKeyPreferences, setHostKeyPreferences] = useState<HostKeyPreference[]>([]); const [settings, setSettings] = useState<AppSettings>(defaultSettings); const [sessions, setSessions] = useState<SessionInfo[]>([]); const [tabs, setTabs] = useState<string[]>(() => [crypto.randomUUID()]); const [activeId, setActiveId] = useState(() => tabs[0]); const [closed, setClosed] = useState<Record<string, string>>({}); const [version, setVersion] = useState('');
  const [keyPush, setKeyPush] = useState<{ profile: HostProfile; credentials: CredentialUpdate } | null>(null);
  const [connection, setConnection] = useState<{ profile?: HostProfile; tabId?: string } | null>(null); const [connecting, setConnecting] = useState(false); const [connectionError, setConnectionError] = useState(''); const [settingsOpen, setSettingsOpen] = useState(false); const [settingsPage, setSettingsPage] = useState<string | undefined>(); const [themeSaving, setThemeSaving] = useState(false); const [hostKeys, setHostKeys] = useState<Extract<AppEvent, { type: 'hostKey' }>[]>([]); const hostKey = hostKeys[0] || null;
  const [filesVisible, setFilesVisible] = useState(false); const [filesHeight, setFilesHeight] = useState(330); const [zen, setZen] = useState(false); const [terminalHeaderVisible, setTerminalHeaderVisible] = useState(true); const [sidebarCollapsed, setSidebarCollapsed] = useState(false); const [transfers, setTransfers] = useState<TransferInfo[]>([]); const [queueCollapsed, setQueueCollapsed] = useState(true); const [toasts, setToasts] = useState<Toast[]>([]); const [sudoTask, setSudoTask] = useState<SudoTask | null>(null); const [context, setContext] = useState<Context | null>(null); const [permissions, setPermissions] = useState<(FileTarget & {entry: FileEntry}) | null>(null);
  const [local, setLocal] = useState<FileListing>({ path: '', entries: [] }); const [remote, setRemote] = useState<FileListing>({ path: '', entries: [] }); const [loading, setLoading] = useState<Record<Side, boolean>>({ local: false, remote: false }); const [fileErrors, setFileErrors] = useState<Record<Side, string>>({ local: '', remote: '' }); const [selection, setSelection] = useState<Record<Side, string[]>>({ local: [], remote: [] });
  const [editor, setEditor] = useState<EditorTarget | null>(null); const [operationDialog, setOperationDialog] = useState<FileAction | null>(null); const [commandOutput, setCommandOutput] = useState<{ title: string; text: string } | null>(null); const [initialError, setInitialError] = useState('');
  const [transferDraft, setTransferDraft] = useState<TransferDraft | null>(null);
  const [transferMenu, setTransferMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [busyTransfers, setBusyTransfers] = useState<string[]>([]);
  const transferActionLocks = useRef(new Set<string>());
  const deletedTransfers = useRef(new Set<string>());
  const transfersRef = useRef(transfers); transfersRef.current = transfers;
  const menuTransfer = transferMenu ? transfers.find(transfer => transfer.id === transferMenu.id) : undefined;
  useEffect(() => { setTransferMenu(null); }, [activeId, filesVisible, queueCollapsed]);
  const [following, setFollowing] = useState<Record<string, boolean>>({});
  const [followStatus, setFollowStatus] = useState<Record<string, string>>({});
  const followingRef = useRef(following); followingRef.current = following;
  const [connectionMenu, setConnectionMenu] = useState<{x:number;y:number;profile:HostProfile;source:'sidebar'|'history'|'tab';targetTabId?:string;sessionId?:string}|null>(null);
  const connectionMenuElement = useRef<HTMLDivElement>(null);
  const menuSession = connectionMenu?.sessionId ? sessions.find(session => session.id === connectionMenu.sessionId) : undefined;
  const [commandsVisible, setCommandsVisible] = useState(false);
  const [commandLibrary, setCommandLibrary] = useState<CommandLibrary>({ groups: [], commands: [] });
  const [commandModalOpen, setCommandModalOpen] = useState(false), [commandLoadError, setCommandLoadError] = useState('');
  const commandSenders = useRef(new Map<string, TerminalCommandSender>());
  const registerCommandSender = useCallback((sessionId: string, sender: TerminalCommandSender | null) => { if (sender) commandSenders.current.set(sessionId, sender); else commandSenders.current.delete(sessionId); }, []);
  const refreshCommands = useCallback(async () => { try { const library = await api.commandLibrary(); setCommandLibrary(library); setCommandLoadError(''); } catch (error) { setCommandLoadError(errorText(error)); throw error; } }, []);
  const terminalRegion = useRef<HTMLElement>(null);
  const connectionCancelled = useRef(false);
  const active = sessions.find(session => session.id === activeId); const connected = !!active && !closed[active.id]; const activeRef = useRef(active?.id || ''); const listingsRef = useRef({ local, remote }); const transferRequests = useRef(new Map<string, TransferRequest>()); const remotePaths = useRef(new Map<string, string>()); const loadGeneration = useRef<Record<Side, number>>({ local: 0, remote: 0 }); const nextToast = useRef(0);
  activeRef.current = active?.id || ''; listingsRef.current = { local, remote };
  const notify = useCallback((message: string, error = false) => { const id = ++nextToast.current; setToasts(prev => [...prev.slice(-3), { id, message, error }]); setTimeout(() => setToasts(prev => prev.filter(toast => toast.id !== id)), error ? 10000 : 5000); }, []);
  const removeTransferRow = (id: string) => {
    deletedTransfers.current.add(id);
    transferRequests.current.delete(id);
    setTransfers(previous => previous.filter(transfer => transfer.id !== id));
    setTransferMenu(previous => previous?.id === id ? null : previous);
  };
  const controlTransfer = async (id: string, remove = false) => {
    const transfer = transfersRef.current.find(item => item.id === id);
    if (!transfer || transferActionLocks.current.has(id)) return;
    transferActionLocks.current.add(id); setBusyTransfers(previous => [...previous, id]);
    try {
      // Removing a live row must first stop its transfer. A failed request keeps
      // the row visible so it cannot silently continue in the background.
      if (!remove || activeTransferStates.includes(transfer.state)) await api.cancelTransfer(id);
      if (remove) removeTransferRow(id);
      else if (transfer.state === 'failed') notify('该任务已停止');
    } catch (error) { notify(`无法${remove ? '删除' : '停止'}传输任务：${errorText(error)}`, true); }
    finally { transferActionLocks.current.delete(id); setBusyTransfers(previous => previous.filter(value => value !== id)); }
  };
  const clearFinishedTransfers = () => {
    const finished = new Set(transfersRef.current.filter(transfer => ['completed', 'cancelled'].includes(transfer.state)).map(transfer => transfer.id));
    for (const id of finished) { deletedTransfers.current.add(id); transferRequests.current.delete(id); }
    setTransfers(previous => previous.filter(transfer => !finished.has(transfer.id)));
    setTransferMenu(previous => previous && finished.has(previous.id) ? null : previous);
  };
  const showTransferMenu = (event: React.MouseEvent, id: string) => {
    event.preventDefault(); event.stopPropagation(); setContext(null); setConnectionMenu(null);
    setTransferMenu({id, x: event.clientX, y: event.clientY});
  };
  const manager = useConnections({ sessions, setSessions, tabs, setTabs, activeId, setActiveId, closed, notify, sudoSubmit: settings.sudoPasswordSubmit });
  const { profiles, setProfiles, history, setHistory, groups, setGroups, setCatalog } = manager;
  const openNewTab = useCallback(() => {
    const tabId = crypto.randomUUID();
    setTabs(previous => [...previous, tabId]); setActiveId(tabId);
    setConnectionMenu(null); setContext(null);
  }, []);
  const activeTabId = active?.tabId || active?.id || activeId;
  useEffect(() => {
    if (!tabs.length) { openNewTab(); return; }
    if (!tabs.includes(activeTabId)) {
      const next = tabs.at(-1)!;
      setActiveId(selected => selected === activeId ? sessions.find(session => (session.tabId || session.id) === next)?.id || next : selected);
    }
  }, [tabs, activeTabId, activeId, sessions, openNewTab]);
  const [groupDraft, setGroupDraft] = useState<ConnectionGroup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ group?: ConnectionGroup; profile?: HostProfile } | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false), [catalogError, setCatalogError] = useState('');
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; }, [settings.theme]);
  const toggleTheme = async () => {
    if (themeSaving) return;
    const next: AppSettings = { ...settings, theme: settings.theme === 'dark' ? 'light' : 'dark' };
    setThemeSaving(true);
    try { await api.saveSettings(next); setSettings(next); }
    catch (error) { notify(errorText(error), true); }
    finally { setThemeSaving(false); }
  };
  const doOperation = useCallback(async (label: string, operation: (elevation: Elevation) => Promise<unknown>, allowElevation = true) => { try { await operation({}); } catch (e) { const message = errorText(e); if (allowElevation && /PERMISSION_DENIED|permission denied|权限不足/i.test(message)) setSudoTask({ label, run: operation }); else notify(message, true); } }, [notify]);
  const loadFiles = useCallback(async (side: Side, path: string, elevation: Elevation = {}) => { const sessionId = activeRef.current; if (side === 'remote' && !sessionId) return; const generation = ++loadGeneration.current[side]; setLoading(prev => ({ ...prev, [side]: true })); setFileErrors(prev => ({ ...prev, [side]: '' })); try { const listing = side === 'local' ? await api.localList(path) : await api.remoteList({ sessionId, path: path || '.', ...elevation }); if (generation !== loadGeneration.current[side] || (side === 'remote' && activeRef.current !== sessionId)) return; (side === 'local' ? setLocal : setRemote)(listing); if (side === 'remote') remotePaths.current.set(sessionId, listing.path); setSelection(prev => ({ ...prev, [side]: [] })); } catch (e) { if (generation !== loadGeneration.current[side] || (side === 'remote' && activeRef.current !== sessionId)) return; const message = errorText(e); setFileErrors(prev => ({ ...prev, [side]: message.replace(/^.*?PERMISSION_DENIED:?\s*/, '') })); if (side === 'remote' && /PERMISSION_DENIED|permission denied|权限不足/i.test(message) && !elevation.elevated) { followingRef.current = {...followingRef.current, [sessionId]: false}; setFollowing(followingRef.current); setFollowStatus(previous => ({...previous, [sessionId]: '权限不足，目录跟随已暂停'})); setSudoTask({ label: `读取目录 ${path}`, run: async elevate => { const listing = await api.remoteList({ sessionId, path, ...elevate }); if (activeRef.current === sessionId && generation === loadGeneration.current[side]) { setRemote(listing); remotePaths.current.set(sessionId, listing.path); setFileErrors(prev => ({ ...prev, remote: '' })); } } }); } else if (elevation.elevated) throw e; } finally { if (generation === loadGeneration.current[side]) setLoading(prev => ({ ...prev, [side]: false })); } }, []);
  useEffect(() => { let cancelled = false; api.initial().then(state => { if (cancelled) return; setProfiles(state.profiles); setCatalog(state.connections || state.profiles); setGroups(state.groups || []); setHistory(state.connectionHistory || []); setHostKeyPreferences(state.hostKeyPreferences || []); setSettings({ ...defaultSettings, ...state.settings, shortcuts: { ...defaultSettings.shortcuts, ...state.settings.shortcuts } }); setVersion(state.version); void loadFiles('local', state.localHome); }).catch(e => { if (!cancelled) setInitialError(errorText(e)); }); return () => { cancelled = true; }; }, [loadFiles]);
  useEffect(() => { ++loadGeneration.current.remote; setLoading(prev => ({...prev, remote: false})); setContext(null); setRemote({ path: remotePaths.current.get(activeId) || '', entries: [] }); setSelection(prev => ({ ...prev, remote: [] })); setFileErrors(prev => ({ ...prev, remote: '' })); if (active?.id && !closed[active.id]) void loadFiles('remote', remotePaths.current.get(active.id) || '.'); }, [active?.id, activeId, closed, loadFiles]);
  useEffect(() => api.onEvent(event => { if (event.type === 'hostKey') setHostKeys(current => [...current.filter(question => question.requestId !== event.requestId),event]); if (event.type === 'hostKeyCancelled') setHostKeys(current => current.filter(question => question.requestId !== event.requestId)); if (event.type === 'notice') notify(event.message); if (event.type === 'sessionClosed') { setClosed(prev => ({ ...prev, [event.sessionId]: event.message || '连接已关闭' })); notify(event.message || '服务器连接已关闭'); } if (event.type === 'transfer') { const transfer = event.transfer; if (deletedTransfers.current.has(transfer.id)) return; setTransfers(prev => { const i = prev.findIndex(item => item.id === transfer.id); if (i < 0) return [...prev, transfer]; const next = [...prev]; next[i] = transfer; return next; }); if (transfer.state === 'completed') { transferRequests.current.delete(transfer.id); const side = transfer.direction === 'upload' ? 'remote' : 'local'; if (side === 'local' || transfer.sessionId === activeRef.current) void loadFiles(side, listingsRef.current[side].path); } if (transfer.state === 'failed') notify(`${transfer.name}：${transferErrorMessage(transfer.error || '传输失败')}`, true); } }), [loadFiles, notify]);
  const toggleCommands = useCallback(() => { if (zen) { setZen(false); setCommandsVisible(true); } else setCommandsVisible(value => !value); }, [zen]);
  useEffect(() => { if (commandsVisible) void refreshCommands().catch(() => {}); }, [commandsVisible, refreshCommands]);
  const sendSavedCommand = async (command: SavedCommand, mode: 'insert' | 'execute', borrowed: boolean) => {
    const target = activeRef.current;
    if (!target || closed[target]) throw new Error('请先连接目标终端。');
    const sender = commandSenders.current.get(target); if (!sender) throw new Error('终端正在初始化，请稍后再试。');
    const group = commandLibrary.groups.find(value => value.id === command.groupId);
    if (!group) throw new Error('命令分组已变化，请重新打开命令管理。');
    await sender({commandId:command.id,mode,allowOtherConnection:borrowed,expectedCommand:command.command,expectedGroupId:command.groupId,expectedConnectionId:group.connectionId,expectedConfirmBeforeRun:command.confirmBeforeRun});
    if (isPreview) notify('浏览器演示：命令未发送到真实服务器。');
  };
  const toggleFiles = useCallback(() => { if (zen) { setZen(false); setFilesVisible(true); } else setFilesVisible(value => !value); }, [zen]);
  useEffect(() => {
    const modalOpen = !!(connection || settingsOpen || sudoTask || hostKey || editor || operationDialog || permissions || commandOutput || keyPush || manager.authPrompt || groupDraft || deleteTarget || commandModalOpen);
    const findAction = (combo: string) => { if (!combo) return undefined; const id = Object.entries(settings.shortcuts).find(([, value]) => value && value.toLowerCase() === combo.toLowerCase())?.[0]; return id && ['commands', 'connect', 'settings', 'sidebar', 'terminalHeader', 'previousTab', 'nextTab', 'files', 'fullscreen', 'zen'].includes(id) ? id : undefined; };
    const run = (id: string) => { if (id === 'commands') toggleCommands(); if ((id === 'previousTab' || id === 'nextTab') && tabs.length) { const index = tabs.indexOf(activeTabId); const next = tabs[(index + (id === 'previousTab' ? -1 : 1) + tabs.length) % tabs.length]; setActiveId(sessions.find(session => (session.tabId || session.id) === next)?.id || next); } if (id === 'connect') { setConnectionError(''); setConnection({ tabId: active ? undefined : activeId }); } if (id === 'settings') (setSettingsPage(undefined), setSettingsOpen(true)); if (id === 'sidebar') { if (zen) { setZen(false); setSidebarCollapsed(false); } else setSidebarCollapsed(value => !value); } if (id === 'terminalHeader') setTerminalHeaderVisible(value => !value); if (id === 'files') toggleFiles(); if (id === 'fullscreen') void api.fullscreen().catch(e => notify(errorText(e), true)); if (id === 'zen') setZen(value => !value); };
    const withinTerminal = (target: EventTarget | null) => target instanceof Element && !!target.closest('.terminal-region .xterm');
    const keyboard = (event: KeyboardEvent) => { if (event.isComposing || modalOpen || (event.target instanceof Element && event.target.closest('.terminal-paste-dialog'))) return; const id = findAction(keyCombo(event)); if (!id) return; if (!event.ctrlKey && !event.altKey && !event.metaKey && !/^F\d+$/.test(event.key) && !withinTerminal(event.target)) return; event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) run(id); };
    const mouse = (event: MouseEvent) => { if (modalOpen || !withinTerminal(event.target)) return; const id = findAction(mouseChord(event)); if (!id) return; event.preventDefault(); event.stopImmediatePropagation(); run(id); };
    const suppressMouseDefault = (event: MouseEvent) => { if (withinTerminal(event.target) && findAction(mouseChord(event))) { event.preventDefault(); event.stopImmediatePropagation(); } };
    const region = terminalRegion.current; window.addEventListener('keydown', keyboard, true); region?.addEventListener('mousedown', mouse, true); region?.addEventListener('contextmenu', suppressMouseDefault, true); region?.addEventListener('auxclick', suppressMouseDefault, true);
    return () => { window.removeEventListener('keydown', keyboard, true); region?.removeEventListener('mousedown', mouse, true); region?.removeEventListener('contextmenu', suppressMouseDefault, true); region?.removeEventListener('auxclick', suppressMouseDefault, true); };
  }, [settings.shortcuts, connection, settingsOpen, sudoTask, hostKey, editor, operationDialog, permissions, commandOutput, keyPush, manager.authPrompt, groupDraft, deleteTarget, commandModalOpen, toggleCommands, notify, zen, sessions, tabs, activeTabId, activeId, toggleFiles]);
  useLayoutEffect(() => {
    const menu = connectionMenuElement.current;
    if (!connectionMenu || !menu) return;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(5, Math.min(connectionMenu.x, window.innerWidth - bounds.width - 5))}px`;
    menu.style.top = `${Math.max(5, Math.min(connectionMenu.y, window.innerHeight - bounds.height - 5))}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [connectionMenu]);
  useEffect(() => {
    if (!connectionMenu) return;
    const dismiss = () => setConnectionMenu(null);
    const outside = (event: MouseEvent) => { if (!connectionMenuElement.current?.contains(event.target as Node)) dismiss(); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
      if (event.key === 'Tab') { dismiss(); return; }
      if (event.target instanceof HTMLSelectElement || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const controls = [...(connectionMenuElement.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)') || [])];
      if (!controls.length) return;
      event.preventDefault(); event.stopPropagation();
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + controls.length) % controls.length;
      controls[next].focus();
    };
    window.addEventListener('mousedown', outside); window.addEventListener('blur', dismiss); window.addEventListener('resize', dismiss); window.addEventListener('keydown', keyboard);
    return () => { window.removeEventListener('mousedown', outside); window.removeEventListener('blur', dismiss); window.removeEventListener('resize', dismiss); window.removeEventListener('keydown', keyboard); };
  }, [connectionMenu]);

  useEffect(() => { if (terminalHeaderVisible) return; const frame = requestAnimationFrame(() => { terminalRegion.current?.querySelector<HTMLTextAreaElement>('[data-terminal-session][data-active="true"] .xterm-helper-textarea')?.focus({ preventScroll: true }); }); return () => cancelAnimationFrame(frame); }, [terminalHeaderVisible]);
  useEffect(() => { if (filesVisible) return; setContext(null); const frame = requestAnimationFrame(() => { const activeWrapper = terminalRegion.current?.querySelector<HTMLElement>('[data-terminal-session][data-active="true"]'); activeWrapper?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.focus({ preventScroll: true }); }); return () => cancelAnimationFrame(frame); }, [filesVisible, activeId]);
  const connect = async (profile: HostProfile, credentials: CredentialUpdate, favorite: boolean) => {
    const targetTabId = connection?.tabId;
    connectionCancelled.current = false;
    setConnecting(true); setConnectionError('');
    try { const saved = await manager.save(profile, favorite); if (!connectionCancelled.current && await manager.establish(saved, credentials, targetTabId)) setConnection(null); }
    catch (error) { setConnectionError(errorText(error)); }
    finally { setConnecting(false); }
  };
  const closeSession = async (id: string) => { await manager.close(id); remotePaths.current.delete(id); setFollowing(previous => { const next = {...previous}; delete next[id]; return next; }); setFollowStatus(previous => { const next = {...previous}; delete next[id]; return next; }); };
  const closeTab = (tabId: string) => {
    const session = sessions.find(item => (item.tabId || item.id) === tabId);
    if (session) { void closeSession(session.id); return; }
    void manager.cancel(tabId);
    if (manager.authPrompt?.tabId === tabId) manager.setAuthPrompt(null);
    if (connection?.tabId === tabId) { connectionCancelled.current = true; setConnection(null); }
    const remaining = tabs.filter(id => id !== tabId);
    setTabs(current => current.filter(id => id !== tabId));
    const next = remaining[Math.min(tabs.indexOf(tabId), remaining.length - 1)];
    setActiveId(selected => selected === tabId ? sessions.find(item => (item.tabId || item.id) === next)?.id || next || '' : selected);
  };
  const queueTransfer = async (request: TransferRequest) => { const safeRequest: TransferRequest = { sessionId: request.sessionId, direction: request.direction, source: request.source, destinationDir: request.destinationDir, mode: request.mode || 'direct', resume: request.mode !== 'archive' }; try { const id = await api.transfer(safeRequest); if (!deletedTransfers.current.has(id)) transferRequests.current.set(id, safeRequest); } catch (error) { notify(transferErrorMessage(errorText(error)), true); } };
  const captureTransferTarget = (side: Side, sessionId = activeRef.current): Omit<TransferDraft, 'sources'> | null => {
    const session = sessions.find(item => item.id === sessionId);
    if (!session || closed[sessionId]) { notify('请先连接服务器。', true); return null; }
    const destinationDir = side === 'local' ? listingsRef.current.remote.path : listingsRef.current.local.path;
    if (!destinationDir) { notify('请先选择传输的目标目录。', true); return null; }
    return { sessionId, direction: side === 'local' ? 'upload' : 'download', destinationDir, connectionName: `${session.profile.name} · ${session.profile.username}@${session.profile.host}:${session.profile.port}` };
  };
  const startTransfer = (side: Side, paths: string[], sessionId?: string) => { const target = captureTransferTarget(side, sessionId); if (target && paths.length) setTransferDraft({ ...target, sources: [...paths] }); };
  const chooseUpload = async () => { const target = captureTransferTarget('local'); if (!target) return; try { const paths = await api.chooseFiles({ multiple: true, title: '选择上传文件' }); if (paths.length) setTransferDraft({ ...target, sources: [...paths] }); } catch (error) { notify(errorText(error), true); } };
  const submitTransfer = async (draft: TransferDraft, mode: 'direct' | 'archive') => { setTransferDraft(null); setQueueCollapsed(false); for (const source of draft.sources) await queueTransfer({ sessionId: draft.sessionId, direction: draft.direction, source, destinationDir: draft.destinationDir, mode, resume: mode !== 'archive' }); };
  const retryTransfer = async (transfer: TransferInfo) => { const request = transferRequests.current.get(transfer.id) || { sessionId: transfer.sessionId, direction: transfer.direction, source: transfer.source, destinationDir: parentPath(transfer.destination, transfer.direction === 'upload' ? 'remote' : 'local'), mode: transfer.mode || 'direct', resume: transfer.mode !== 'archive' }; await queueTransfer(request); };
  const receiveDrop = (side: Side, event: React.DragEvent) => { const data = event.dataTransfer.getData(dragMime); if (data) { try { const payload = JSON.parse(data) as { side: Side; paths: string[]; sessionId?: string }; if (payload.side === side) return; if (!['local', 'remote'].includes(payload.side) || !Array.isArray(payload.paths)) return; startTransfer(payload.side, payload.paths, payload.side === 'remote' ? payload.sessionId : undefined); } catch { notify('无法读取拖动的文件。', true); } } else if (side === 'remote') { const paths = Array.from(event.dataTransfer.files).map(file => api.pathForFile(file)).filter(Boolean); if (paths.length) void startTransfer('local', paths); } };
  const fileTarget = (side: Side): FileTarget => ({side, sessionId: side === 'remote' ? activeRef.current : '', basePath: listingsRef.current[side].path, connectionName: active ? `${active.profile.name} · ${active.profile.username}@${active.profile.host}:${active.profile.port}` : ''});
  const fileTargetLive = (target: FileTarget) => target.side === 'local' || (sessions.some(session => session.id === target.sessionId) && !closed[target.sessionId]);
  const refreshTarget = (target: FileTarget) => { if (target.side === 'remote' && activeRef.current !== target.sessionId) return; if (listingsRef.current[target.side].path === target.basePath) void loadFiles(target.side, target.basePath); };
  const navigateFiles = (side: Side, path: string) => { if (side === 'remote') { followingRef.current = {...followingRef.current, [activeRef.current]: false}; setFollowing(followingRef.current); setFollowStatus(previous => ({...previous, [activeRef.current]: ''})); } void loadFiles(side, path); };
  const fileAction = (type: FileAction['type'], target: FileTarget, entries: FileEntry[] = []) => { if (!fileTargetLive(target) || !target.basePath || (['rename','delete'].includes(type) && !entries.length)) return; setContext(null); setOperationDialog({...target, type, entries}); };
  const showFileMenu = (event: React.MouseEvent, side: Side, entry?: FileEntry) => { event.preventDefault(); event.stopPropagation(); const listing = listingsRef.current[side]; const paths = new Set(entry && selection[side].includes(entry.path) ? selection[side] : entry ? [entry.path] : []); setConnectionMenu(null); setTransferMenu(null); setContext({...fileTarget(side), x: event.clientX, y: event.clientY, entry, entries: listing.entries.filter(item => paths.has(item.path))}); };
  const openFile = (side: Side, entry: FileEntry, target = fileTarget(side)) => { if (!fileTargetLive(target)) return; if (entry.type === 'directory') { if (side === 'local' || activeRef.current === target.sessionId) navigateFiles(side, entry.path); return; } setEditor({ side, entry, sessionId: target.sessionId, connectionName: target.connectionName }); };
  const runFile = (entry: FileEntry, executable: boolean, sudo: boolean, target: FileTarget) => { const operation = async (elevation: Elevation) => { const result = await api.runFile({ sessionId: target.sessionId, path: entry.path, ...elevation, makeExecutable: executable }); setCommandOutput({ title: `${entry.name} · 退出码 ${result.exitCode}`, text: result.output || '命令已完成，没有输出。' }); if (executable) refreshTarget(target); }; if (sudo) setSudoTask({ label: `${target.connectionName}\nsudo 运行 ${entry.path}`, run: operation }); else void doOperation(`运行 ${entry.path}`, operation); };
  const toggleFollow = () => { const id = activeRef.current; if (!id || !connected) return; const enabled = !followingRef.current[id]; followingRef.current = {...followingRef.current, [id]: enabled}; setFollowing(followingRef.current); setFollowStatus(previous => ({...previous, [id]: enabled ? '正在获取终端目录…' : ''})); };
  useEffect(() => {
    const sessionId = active?.id;
    if (!sessionId || !connected || !following[sessionId] || !filesVisible || zen) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api.terminalCwd({sessionId});
        if (cancelled || activeRef.current !== sessionId || !followingRef.current[sessionId]) return;
        setFollowStatus(previous => ({...previous, [sessionId]: result.source === 'tmux' ? '跟随 tmux 当前窗格' : '跟随终端目录'}));
        if (result.path !== listingsRef.current.remote.path) await loadFiles('remote', result.path);
      } catch (error) {
        if (cancelled) return;
        followingRef.current = {...followingRef.current, [sessionId]: false}; setFollowing(followingRef.current);
        setFollowStatus(previous => ({...previous, [sessionId]: '目录跟随已暂停'})); notify(errorText(error), true);
      } finally { if (!cancelled) timer = setTimeout(() => void poll(), 2000); }
    };
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [active?.id, connected, following[active?.id || ''], filesVisible, zen, loadFiles, notify]);
  const resizeFiles = (e: React.PointerEvent) => { e.preventDefault(); const startY = e.clientY, startHeight = document.getElementById('file-manager')?.getBoundingClientRect().height || filesHeight; const move = (event: PointerEvent) => setFilesHeight(Math.min(window.innerHeight - 190, Math.max(queueCollapsed ? 260 : 340, startHeight + startY - event.clientY))); const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); document.body.style.cursor = ''; document.body.style.userSelect = ''; }; document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none'; window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); };
  const activeTransfers = transfers.filter(transfer => activeTransferStates.includes(transfer.state));
  const showConnectionMenu = (event: React.MouseEvent, profile: HostProfile, source: 'sidebar' | 'history' | 'tab' = 'sidebar', sessionId?: string) => { event.preventDefault(); event.stopPropagation(); setContext(null); setConnectionMenu({x:event.clientX,y:event.clientY,profile:manager.catalog.find(item => item.id === profile.id) || profile,source,sessionId,targetTabId:!active && event.currentTarget.closest('.connection-home') ? activeId : undefined}); };
  const showConnection = (profile?: HostProfile, targetTabId?: string) => { setConnectionError(''); setConnection({ profile, tabId: targetTabId || (!active && tabs.includes(activeId) ? activeId : undefined) }); };
  return <div className={`app-shell${zen ? ' zen' : ''}${terminalHeaderVisible ? '' : ' terminal-header-hidden'}`}>
    <ConnectionSidebar profiles={profiles} groups={groups} sessions={sessions} activeId={activeId} closed={closed} collapsed={sidebarCollapsed}
      onConnect={profile => void manager.direct(profile)} onContextMenu={showConnectionMenu}
      onGroupMenuOpen={() => { setConnectionMenu(null); setContext(null); }}
      onGroupCreate={() => { setCatalogError(''); setGroupDraft({ id: crypto.randomUUID(), name: '', icon: 'folder', order: Math.max(-1,...groups.map(group => group.order))+1 }); }}
      onGroupEdit={group => { setCatalogError(''); setGroupDraft({ ...group }); }}
      onGroupDelete={group => { setCatalogError(''); setDeleteTarget({ group }); }}
      onGroupMove={(id, direction) => { const ordered = [...groups].sort((a,b) => a.order-b.order); const index = ordered.findIndex(group => group.id === id), next = index + (direction === 'up' ? -1 : 1); if (!ordered[next]) return; [ordered[index],ordered[next]]=[ordered[next],ordered[index]]; void (async () => { for (let i=0;i<ordered.length;i++) await api.saveGroup({...ordered[i],order:i}); await manager.refresh(); })().catch(error => notify(errorText(error),true)); }}
      onToggle={() => setSidebarCollapsed(value => !value)} onQuickConnect={() => showConnection()}
      toggleShortcut={shortcutLabel(settings.shortcuts.sidebar)} connectShortcut={shortcutLabel(settings.shortcuts.connect)} />
    <main className="workspace"><header className="titlebar" aria-label="终端标题栏"><span className="workspace-title">{active?.profile.name || '工作空间'}</span>{active && <span className="breadcrumb">{active.profile.username}@{active.profile.host}:{active.profile.port}</span>}<span className="toolbar-spacer" /><span className={`connection-state ${connected ? 'connected' : connecting ? 'connecting' : ''}`}><i />{isPreview ? '浏览器演示 · 无真实连接' : connected ? '已连接' : connecting ? '连接中' : active ? '已断开' : '就绪'}</span><span className="toolbar-divider" /><button type="button" className={`files-toggle${filesVisible && !zen ? ' active' : ''}${settings.filesToggleIconOnly ? ' icon-only' : ''}`} aria-label={filesVisible && !zen ? '收起文件管理' : '展开文件管理'} aria-expanded={filesVisible && !zen} aria-controls="file-manager" title={`${filesVisible && !zen ? '收起文件管理' : '展开文件管理'} · ${shortcutLabel(settings.shortcuts.files)}${activeTransfers.length ? ` · ${activeTransfers.length} 个传输任务进行中` : ''}`} onClick={toggleFiles}><PanelBottom size={15} strokeWidth={1.7} /><span className="files-toggle-label">{filesVisible && !zen ? '收起文件管理' : '展开文件管理'}</span>{activeTransfers.length > 0 && <span className="files-transfer-count" aria-label={`${activeTransfers.length} 个传输任务进行中`}>{activeTransfers.length}</span>}</button><IconButton title={`${commandsVisible && !zen ? '收起命令管理' : '展开命令管理'} · ${shortcutLabel(settings.shortcuts.commands)}`} active={commandsVisible && !zen} onClick={toggleCommands}><SquareTerminal size={16} /></IconButton><button type="button" className="icon-button theme-toggle" aria-label={settings.theme === 'dark' ? '切换为白色主题' : '切换为黑色主题'} title={settings.theme === 'dark' ? '切换为白色主题' : '切换为黑色主题'} disabled={themeSaving} onClick={() => void toggleTheme()}>{settings.theme === 'dark' ? <Sun size={16} strokeWidth={1.7} /> : <Moon size={16} strokeWidth={1.7} />}</button><IconButton title="设置" onClick={() => (setSettingsPage(undefined), setSettingsOpen(true))}>⚙</IconButton>{!isPreview && <div className="window-controls"><button type="button" title="最小化" aria-label="最小化窗口" onClick={() => api.minimize()}><Minus size={14} strokeWidth={1.3} /></button><button type="button" title="最大化 / 还原" aria-label="最大化或还原窗口" onClick={() => api.maximize()}><Square size={12} strokeWidth={1.2} /></button><button type="button" className="window-close" title="关闭窗口" aria-label="关闭窗口" onClick={() => api.closeWindow()}><X size={16} strokeWidth={1.3} /></button></div>}</header>
    <div className="workspace-body"><div className="workspace-content"><div className="tabbar" role="tablist" aria-label="终端标签">{tabs.map(tabId => {
      const session = sessions.find(item => (item.tabId || item.id) === tabId);
      const selected = activeTabId === tabId;
      return <div role="tab" tabIndex={0} aria-selected={selected} key={tabId} data-workspace-tab={tabId} data-tab-kind={session ? 'terminal' : 'home'} className={`terminal-tab${selected ? ' active' : ''}`} onContextMenu={event => { if (session) showConnectionMenu(event,session.profile,'tab',session.id); }} onClick={() => setActiveId(session?.id || tabId)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActiveId(session?.id || tabId); } }}>
        <span aria-hidden="true" style={{ color: !session || closed[session.id] ? 'var(--text-subtle)' : 'var(--connected)' }}>{session ? '●' : '○'}</span><span>{session?.profile.name || '新标签页'}</span><button className="tab-close" title="关闭标签页" aria-label={`关闭${session?.profile.name || '新标签页'}`} onClick={event => { event.stopPropagation(); closeTab(tabId); }} onKeyDown={event => event.stopPropagation()}>×</button>
      </div>;
    })}<IconButton title="新建标签页" onClick={openNewTab}>+</IconButton></div>
    <section className="terminal-region" ref={terminalRegion}>{sessions.map(session => <div className={`terminal-instance${session.id !== activeId ? ' hidden' : ''}`} key={session.tabId || session.id} data-terminal-session={session.id} data-active={session.id === activeId} style={{background:terminalBackground(settings.theme,settings.terminalPalette)}}><TerminalView session={session} settings={settings} active={session.id === activeId} disconnected={!!closed[session.id]} reconnecting={!!manager.pending[session.tabId || session.id]} reconnectError={manager.reconnectErrors[session.tabId || session.id]} onReconnect={() => void manager.reconnect(session)} onCancelReconnect={() => void manager.cancel(session.tabId || session.id)} onSudoPassword={() => void manager.sudo(session)} onCommandSender={registerCommandSender} onFontSizeChange={size => { const next = { ...settings, fontSize: size }; setSettings(next); void api.saveSettings(next).catch(e => notify(errorText(e), true)); }} /></div>)}{!active && <><ConnectionHome key={activeId} onContextMenu={(event, profile) => showConnectionMenu(event, profile, 'history')} history={history} showHistory={settings.showConnectionHistory} connectShortcut={shortcutLabel(settings.shortcuts.connect)} onCreate={() => showConnection()} onSettings={() => (setSettingsPage(undefined), setSettingsOpen(true))} onPick={profile => void manager.direct(profile, true, activeId)} />{initialError && <div className="form-error">{initialError}</div>}</>}</section><button className="zen-exit" onClick={() => setZen(false)}>退出纯终端 · {shortcutLabel(settings.shortcuts.zen)}</button>
    <><div className="splitter" hidden={!filesVisible} role="separator" aria-label="调整文件管理高度" aria-orientation="horizontal" onPointerDown={resizeFiles} /><section id="file-manager" className="files-area" hidden={!filesVisible} style={{ height: filesHeight }}><div className="files-section-bar"><span>文件管理</span><span className="muted">本地 ⇄ 远程</span><span className="toolbar-spacer" /><button type="button" className="files-collapse" title="收起文件管理" aria-label="收起文件管理" onClick={() => setFilesVisible(false)}><ChevronDown size={14} /><span>收起</span></button></div><div className="dual-files">{(['local', 'remote'] as const).map(side => <FilePane key={side} side={side} sessionId={activeId} listing={side === 'local' ? local : remote} loading={loading[side]} error={fileErrors[side]} selected={selection[side]} connected={side === 'local' || connected} load={path => navigateFiles(side, path)} refresh={() => void loadFiles(side, listingsRef.current[side].path)} select={paths => setSelection(prev => ({ ...prev, [side]: paths }))} context={(event, entry) => showFileMenu(event, side, entry)} following={!!following[activeId]} toggleFollow={toggleFollow} followStatus={followStatus[activeId]} open={entry => openFile(side, entry)} drop={event => receiveDrop(side, event)} chooseFolder={async () => { try { const [path] = await api.chooseFiles({ directory: true, title: '选择本地目录' }); if (path) void loadFiles('local', path); } catch (e) { notify(errorText(e), true); } }} chooseUpload={() => void chooseUpload()} />)}</div><section className={`transfer-area${queueCollapsed ? ' queue-collapsed' : ''}`}><div className="transfer-header"><span>传输队列</span><span className="badge">{activeTransfers.length}</span><span className="muted">{activeTransfers.length ? '传输中' : '空闲'}</span><span className="toolbar-spacer" /><button className="text-button" style={{ fontSize: 10 }} onClick={clearFinishedTransfers}>清除已完成</button><button type="button" className="transfer-toggle" title={queueCollapsed ? '展开传输队列' : '收起传输队列'} aria-label={queueCollapsed ? '展开传输队列' : '收起传输队列'} aria-expanded={!queueCollapsed} aria-controls="transfer-queue-body" onClick={() => setQueueCollapsed(value => !value)}>{queueCollapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}<span>{queueCollapsed ? '展开' : '收起'}</span></button></div><div id="transfer-queue-body" className="transfer-list" hidden={queueCollapsed}>{transfers.length === 0 ? <div className="transfer-empty">拖动文件到另一栏，或右键选择上传 / 下载。传输任务在这里显示。</div> : transfers.map(transfer => <TransferRow key={transfer.id} transfer={transfer} cancel={() => void controlTransfer(transfer.id)} retry={() => void retryTransfer(transfer)} busy={busyTransfers.includes(transfer.id)} context={event => showTransferMenu(event, transfer.id)} />)}</div></section></section></>
    </div><div id="command-library-dock" className="commands-dock" hidden={!commandsVisible}>
      {commandLoadError && <div className="command-load-error" role="alert"><span>{commandLoadError}</span><button className="text-button" onClick={() => void refreshCommands().catch(() => {})}>重新加载</button></div>}
      <CommandSidebar scopeConnectionId={active && manager.catalog.some(profile => profile.id === active.profile.id && !sameConnection(profile,active.profile)) ? '' : undefined} library={commandLibrary} connections={manager.catalog} activeSession={active} connected={connected} onRefresh={refreshCommands} onSend={sendSavedCommand} onClose={() => setCommandsVisible(false)} onModalChange={setCommandModalOpen} />
    </div></div><footer className="statusbar"><span className="status-product">gooeshell</span><span className="status-note">{active ? closed[active.id] || `${active.profile.username}@${active.profile.host}` : isPreview ? '浏览器演示 · 未连接服务器' : '就绪'} </span>{active && <button onClick={() => closed[active.id] ? void manager.reconnect(active) : showConnection(manager.catalog.find(profile => profile.id === active.profile.id) || active.profile)}>{closed[active.id] ? '重新连接' : '连接设置'}</button>}<span className="status-right">{active?.profile.encoding.toUpperCase() || 'UTF-8'}　·　{settings.fontSize}px　·　{version}</span></footer></main>
    {connection && <ConnectionDialog key={`${connection.profile?.id || 'new'}:${connection.profile?.auth || 'password'}:${connection.profile?.privateKeyPath || ''}`} saved={profiles.some(profile => profile.id === connection.profile?.id)} groups={groups} hostKeyPreferences={hostKeyPreferences} profile={connection.profile} busy={connecting} error={connectionError}
      onPushKey={async (profile, credentials, favorite) => { const saved = await manager.save(profile, favorite, credentials); setConnection(previous => ({...previous, profile:saved})); setKeyPush({profile:saved, credentials}); }}
      onManageIdentities={() => { setSettingsPage('identities'); setSettingsOpen(true); }}
      onHostKeyPreference={async preference => { await api.setHostKeyPreference(preference); setHostKeyPreferences(previous => [...previous.filter(item => !sameEndpoint(item, preference)), ...(preference.skipVerification ? [preference] : [])]); }}
      onDelete={connection.profile ? () => { setDeleteTarget({ profile: connection.profile! }); setConnection(null); } : undefined}
      onDuplicate={connection.profile ? () => { void manager.direct(connection.profile!, true); setConnection(null); } : undefined}
      onSave={async (profile,favorite,credentials) => { await manager.save(profile,favorite,credentials); notify('连接设置已保存'); setConnection(null); }}
      onConnect={connect} onClose={() => setConnection(null)} onCancelConnect={() => { connectionCancelled.current = true; void manager.cancel(connection.tabId); }} />}
    {manager.authPrompt && <ConnectionAuthDialog key={`${manager.authPrompt.mode}:${manager.authPrompt.profile.id}:${manager.authPrompt.tabId || ''}`} profile={manager.authPrompt.profile} mode={manager.authPrompt.mode} busy={manager.authBusy} error={manager.authError} onManageIdentities={() => { setSettingsPage('identities'); setSettingsOpen(true); }} onEdit={manager.clearAuthError} onSubmit={manager.submitAuth} onClose={() => manager.setAuthPrompt(null)} onCancel={() => void manager.cancel(manager.authPrompt?.tabId)} />}
    {((!active && manager.pending[activeId]) || manager.hasUntargetedPending) && !connection && !manager.authPrompt && <div className="connection-pending" role="status"><span>正在连接服务器…</span><button className="button small secondary" onClick={() => void manager.cancel(!active && manager.pending[activeId] ? activeId : undefined)}>取消连接</button></div>}
    {groupDraft && <Modal title={groups.some(group => group.id === groupDraft.id) ? '编辑连接分组' : '新建连接分组'} compact close={() => { if (!catalogBusy) setGroupDraft(null); }} footer={<><button className="button secondary" disabled={catalogBusy} onClick={() => setGroupDraft(null)}>取消</button><button className="button primary" form="connection-group-form" type="submit" disabled={catalogBusy || !groupDraft.name.trim()}>保存分组</button></>}><form id="connection-group-form" className="modal-body" onSubmit={async event => { event.preventDefault(); setCatalogBusy(true); setCatalogError(''); try { await api.saveGroup(groupDraft); await manager.refresh(); setGroupDraft(null); } catch (error) { setCatalogError(errorText(error)); } finally { setCatalogBusy(false); } }}><div className="form-field"><label htmlFor="connection-group-name">分组名称</label><input id="connection-group-name" autoFocus maxLength={80} value={groupDraft.name} onChange={event => setGroupDraft({...groupDraft,name:event.target.value})}/></div><div className="form-field" style={{marginTop:18}}><label htmlFor="connection-group-icon">图标</label><select id="connection-group-icon" value={groupDraft.icon} onChange={event => setGroupDraft({...groupDraft,icon:event.target.value as ConnectionGroup['icon']})}>{connectionIcons.map(icon => <option key={icon.id} value={icon.id}>{icon.name}</option>)}</select></div>{catalogError && <div className="form-error" role="alert">{catalogError}</div>}</form></Modal>}
    {deleteTarget && <Modal title={deleteTarget.group ? '删除分组' : '删除连接'} compact close={() => { if (!catalogBusy) setDeleteTarget(null); }} footer={<><button className="button secondary" disabled={catalogBusy} onClick={() => setDeleteTarget(null)}>取消</button><button className="button primary" disabled={catalogBusy} onClick={async () => { setCatalogBusy(true); setCatalogError(''); try { if (deleteTarget.group) await api.deleteGroup(deleteTarget.group.id); else { await manager.cancelProfile(deleteTarget.profile!.id); await api.deleteConnection(deleteTarget.profile!.id); } await manager.refresh(); setDeleteTarget(null); } catch (error) { setCatalogError(errorText(error)); } finally { setCatalogBusy(false); } }}>确认删除</button></>}><div className="modal-body"><p>{deleteTarget.group ? `删除“${deleteTarget.group.name}”后，其中的连接将移到未分组。` : `删除“${deleteTarget.profile?.name}”的连接配置、最近记录与已记住的密码。当前打开的终端会继续运行，专属命令保留在命令管理中。`}</p>{catalogError && <div className="form-error" role="alert">{catalogError}</div>}</div></Modal>}
    {settingsOpen && <SettingsDialog initialTab={settingsPage} onIdentitiesChange={async () => { await manager.refresh(); window.dispatchEvent(new Event('gooeshell:identities-changed')); }} clearHistory={async () => { await api.clearConnectionHistory(); setHistory([]); notify('最近连接已清空'); }} settings={settings} save={async value => { await api.saveSettings(value); setSettings(value); notify('设置已保存'); }} close={() => setSettingsOpen(false)} />}
    {transferDraft && <TransferDialog draft={transferDraft} disconnected={!!closed[transferDraft.sessionId] || !sessions.some(session => session.id === transferDraft.sessionId)} close={() => setTransferDraft(null)} submit={mode => void submitTransfer(transferDraft, mode)} />}
    {editor && <Suspense fallback={<Modal title="文本编辑器" wide close={() => setEditor(null)}><div className="modal-body">正在加载编辑器…</div></Modal>}><TextEditorDialog target={editor} theme={settings.theme} disconnected={editor.side === 'remote' && (!!closed[editor.sessionId] || !sessions.some(session => session.id === editor.sessionId))} onClose={() => setEditor(null)} onSaved={() => { if (editor.side === 'local' || activeRef.current === editor.sessionId) void loadFiles(editor.side, listingsRef.current[editor.side].path); }} /></Suspense>}
    {operationDialog && <FileActionDialog action={operationDialog} close={() => setOperationDialog(null)} done={notify} refresh={refreshTarget} onPermission={(label, run) => setSudoTask({label, run})} />}
    {permissions && <PermissionsDialog entry={permissions.entry} close={() => setPermissions(null)} apply={async mode => { const target = permissions; await doOperation(`修改权限 ${target.entry.path} → ${mode.toString(8)}`, async elevation => { await api.chmod({ sessionId: target.sessionId, path: target.entry.path, ...elevation, mode }); notify('权限已更新'); refreshTarget(target); }); }} />}
    {commandOutput && <Modal title={commandOutput.title} wide close={() => setCommandOutput(null)} footer={<button className="button primary" onClick={() => setCommandOutput(null)}>关闭</button>}><div className="modal-body"><textarea aria-label="命令执行结果" value={commandOutput.text} readOnly spellCheck={false} style={{ fontFamily: 'var(--mono)', height: '40vh', lineHeight: 1.6 }} /></div></Modal>}
    {sudoTask && <SudoDialog task={sudoTask} close={() => setSudoTask(null)} run={async password => { await sudoTask.run({ elevated: true, sudoPassword: password }); notify('操作已提交'); }} />}
    {keyPush && <KeyPushDialog profile={keyPush.profile} credentials={keyPush.credentials} onClose={() => setKeyPush(null)} onApplied={async profile => { await manager.refresh(); setConnection(previous => previous ? {...previous, profile} : {profile}); notify('此连接已改用密钥登录，下次连接生效'); }} />}
    {hostKey && <Modal title={hostKey.role === 'jump' ? (hostKey.previousFingerprint ? '跳板机指纹发生变化' : '确认跳板机身份') : (hostKey.previousFingerprint ? '服务器指纹发生变化' : '确认服务器身份')} compact close={() => { void api.confirmHostKey(hostKey.requestId, 'reject'); setHostKeys(current => current.filter(question => question.requestId !== hostKey.requestId)); }} footer={<><button className="button secondary" onClick={() => { void api.confirmHostKey(hostKey.requestId, 'reject'); setHostKeys(current => current.filter(question => question.requestId !== hostKey.requestId)); }}>取消连接</button><button className="button secondary" onClick={() => { void api.confirmHostKey(hostKey.requestId, 'once'); setHostKeys(current => current.filter(question => question.requestId !== hostKey.requestId)); }}>仅信任本次</button>{hostKey.saveAllowed !== false && <button className="button primary" onClick={() => { void api.confirmHostKey(hostKey.requestId, 'save'); setHostKeys(current => current.filter(question => question.requestId !== hostKey.requestId)); }}>信任并保存</button>}</>}><div className="modal-body"><p className="sudo-description">{hostKey.host}:{hostKey.port}</p><p className="settings-description">{hostKey.role === 'jump' ? '这是跳板机的 SSH 指纹，确认后才会连接目标服务器。' : '请核对目标服务器提供的 SSH 指纹。'}{hostKey.via && <><br />经由：{hostKey.via}</>}</p><div className="trust-fingerprint">{hostKey.fingerprint}</div>{hostKey.previousFingerprint && <><p className="file-operation-warning">此指纹与上次记录不一致。请先确认服务器是否更换过密钥。</p><div className="trust-fingerprint" style={{ color: 'var(--text-muted)' }}>上次：{hostKey.previousFingerprint}</div></>}</div></Modal>}
    {connectionMenu && <div ref={connectionMenuElement} className="context-menu connection-context-menu" role="menu" aria-label="连接操作" style={{left:connectionMenu.x,top:Math.max(5,connectionMenu.y)}} onClick={event => event.stopPropagation()}><div className="menu-caption">{menuSession?.profile.name || connectionMenu.profile.name}</div><div className="connection-menu-endpoint">{(menuSession?.profile || connectionMenu.profile).username}@{(menuSession?.profile || connectionMenu.profile).host}:{(menuSession?.profile || connectionMenu.profile).port}</div>
      {menuSession && !sameConnection(menuSession.profile, connectionMenu.profile) && <div className="connection-menu-note">此终端仍使用原地址；编辑连接设置将打开已保存的新配置。</div>}
      {connectionMenu.source === 'tab' && <><button role="menuitem" disabled={!menuSession} onClick={() => { if (menuSession) { setActiveId(menuSession.id); if (closed[menuSession.id]) void manager.reconnect(menuSession); } setConnectionMenu(null); }}>{menuSession && closed[menuSession.id] ? '重新连接此终端' : '切换到此终端'}</button><button role="menuitem" disabled={!menuSession} onClick={() => { if (menuSession) void manager.duplicate(menuSession); setConnectionMenu(null); }}>新建同名终端</button></>}
      <button role="menuitem" onClick={() => { showConnection(connectionMenu.profile,connectionMenu.targetTabId); setConnectionMenu(null); }}>连接设置…</button>
      {connectionMenu.source === 'history' && <button role="menuitem" onClick={() => { void api.deleteHistory(connectionMenu.profile.id).then(manager.refresh).catch(error => notify(errorText(error),true)); setConnectionMenu(null); }}>删除这条最近记录</button>}
    </div>}
    {transferMenu && menuTransfer && !context && !connectionMenu && <FileContextMenu x={transferMenu.x} y={transferMenu.y} label="传输任务操作" close={() => setTransferMenu(null)}>
      <div className="menu-caption">{menuTransfer.name}</div>
      <button role="menuitem" disabled={busyTransfers.includes(menuTransfer.id) || ['completed', 'cancelled'].includes(menuTransfer.state)} onClick={() => { void controlTransfer(menuTransfer.id); setTransferMenu(null); }}>强制停止</button>
      <button role="menuitem" disabled={busyTransfers.includes(menuTransfer.id)} onClick={() => { void controlTransfer(menuTransfer.id, true); setTransferMenu(null); }}>删除任务</button>
    </FileContextMenu>}
    {context && <FileContextMenu x={context.x} y={context.y} close={() => setContext(null)}>
      <div className="menu-caption">{context.entry?.name || '当前目录'}</div>
      {context.entry && <><button role="menuitem" disabled={!fileTargetLive(context)} onClick={() => { openFile(context.side, context.entry!, context); setContext(null); }}>{context.entry.type === 'directory' ? '打开文件夹' : '编辑文本文件'}</button><button role="menuitem" disabled={!connected} onClick={() => { startTransfer(context.side, context.entries.map(entry => entry.path), context.side === 'remote' ? context.sessionId : undefined); setContext(null); }}>{context.side === 'local' ? '上传到远程目录' : '下载到本地目录'}</button><button role="menuitem" disabled={!fileTargetLive(context) || context.entries.length !== 1} onClick={() => fileAction('rename', context, context.entries)}>重命名</button><button role="menuitem" className="danger" disabled={!fileTargetLive(context)} onClick={() => fileAction('delete', context, context.entries)}>删除{context.entries.length > 1 ? ` ${context.entries.length} 项` : ''}…</button><hr/></>}
      <button role="menuitem" disabled={!fileTargetLive(context)} onClick={() => fileAction('createFile', context)}>新建文件</button><button role="menuitem" disabled={!fileTargetLive(context)} onClick={() => fileAction('mkdir', context)}>新建文件夹</button><button role="menuitem" disabled={!fileTargetLive(context)} onClick={() => { refreshTarget(context); setContext(null); }}>刷新目录</button>
      <button role="menuitem" onClick={() => { void api.writeClipboard(context.entry?.path || context.basePath).catch(error => notify(errorText(error), true)); setContext(null); }}>复制路径</button>
      {context.side === 'local' && <button role="menuitem" onClick={() => { void api.showInFolder(context.entry?.path || context.basePath).catch(error => notify(errorText(error), true)); setContext(null); }}>在资源管理器中显示</button>}
      {context.side === 'remote' && <><hr/><button role="menuitemcheckbox" aria-checked={!!following[context.sessionId]} disabled={!connected} onClick={() => { toggleFollow(); setContext(null); }}>{following[context.sessionId] ? '暂停跟随终端目录' : '跟随终端目录'}<span className="menu-end">{following[context.sessionId] ? '✓' : ''}</span></button>{context.entry && <><button role="menuitem" disabled={!fileTargetLive(context)} onClick={() => { setPermissions({...context, entry: context.entry!}); setContext(null); }}>权限与属性<span className="menu-end">rwx</span></button>{context.entry.name.endsWith('.sh') && context.entry.type !== 'directory' && <><hr/><button role="menuitem" disabled={!fileTargetLive(context)} onClick={() => { runFile(context.entry!, false, false, context); setContext(null); }}>运行脚本</button><button role="menuitem" disabled={!fileTargetLive(context)} onClick={() => { runFile(context.entry!, true, false, context); setContext(null); }}>赋予执行权限并运行</button><button role="menuitem" disabled={!fileTargetLive(context)} onClick={() => { runFile(context.entry!, false, true, context); setContext(null); }}>使用 sudo 运行…</button></>}</>}</>}
    </FileContextMenu>}
    <div className="toast-stack" aria-live="polite">{toasts.map(toast => <div key={toast.id} className={`toast${toast.error ? ' error' : ''}`}><button title="关闭提示" onClick={() => setToasts(prev => prev.filter(item => item.id !== toast.id))}>×</button>{toast.message}</div>)}</div>
  </div>;
}
