import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Copy, FolderPlus, Pencil, Play, Plus, Search, Terminal, Trash2, X } from 'lucide-react';
import type { CommandGroup, CommandLibrary, HostProfile, SavedCommand, SessionInfo } from '../shared/types';
import { api } from './api';
import './command-library.css';

export interface CommandSidebarProps {
  library: CommandLibrary;
  connections: HostProfile[];
  activeSession?: SessionInfo;
  scopeConnectionId?: string;
  connected: boolean;
  onRefresh: () => Promise<void>;
  onSend: (command: SavedCommand, mode: 'insert' | 'execute', borrowed: boolean) => Promise<void>;
  onClose: () => void;
  onModalChange?: (open: boolean) => void;
}

type Editor = { type: 'group'; value: CommandGroup; fresh: boolean } | { type: 'command'; value: SavedCommand; fresh: boolean };
type Deletion = { type: 'group'; value: CommandGroup } | { type: 'command'; value: SavedCommand };
type Dispatch = { command: SavedCommand; group: CommandGroup; sourceLabel: string; scopeConnectionId?: string; mode: 'insert' | 'execute'; borrowed: boolean; target: SessionInfo; invalidated: string };
const scopeCurrent = '@current', scopeGlobal = '@global';
const byOrder = <T extends { order: number; name: string }>(a: T, b: T) => a.order - b.order || a.name.localeCompare(b.name);
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const endpoint = (session: SessionInfo) => `${session.profile.username}@${session.profile.host}:${session.profile.port}`;

function CommandModal({ title, children, footer, busy, onClose }: { title: string; children: ReactNode; footer: ReactNode; busy: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => (dialog.current?.querySelector<HTMLElement>('[data-autofocus]') || dialog.current?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled)') || dialog.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus());
    return () => { cancelAnimationFrame(frame); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop command-modal-backdrop"><section ref={dialog} className="modal command-modal" role="dialog" aria-modal="true" aria-label={title}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') || [])].filter(control => control.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    }}>
    <header className="modal-header"><span className="modal-title">{title}</span><button type="button" className="icon-button" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}><X size={17} /></button></header>
    <div className="modal-body command-modal-body">{children}</div>
    <footer className="modal-footer">{footer}</footer>
  </section></div>;
}

export default function CommandSidebar(props: CommandSidebarProps) {
  const { library, connections, activeSession, connected } = props;
  const effectiveConnectionId = props.scopeConnectionId ?? activeSession?.profile.id;
  const [scope, setScope] = useState(scopeCurrent);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<Editor | null>(null);
  const [initialEditor, setInitialEditor] = useState('');
  const [discard, setDiscard] = useState(false);
  const [deletion, setDeletion] = useState<Deletion | null>(null);
  const [dispatch, setDispatch] = useState<Dispatch | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const activeRef = useRef({ session: activeSession, connected, effectiveConnectionId });
  activeRef.current = { session: activeSession, connected, effectiveConnectionId };
  const callback = useRef(props.onModalChange); callback.current = props.onModalChange;
  const modalOpen = !!(editor || deletion || dispatch);
  useEffect(() => { callback.current?.(modalOpen); }, [modalOpen]);
  useEffect(() => () => callback.current?.(false), []);
  useEffect(() => {
    setDispatch(previous => previous && (!connected || previous.target.id !== activeSession?.id || previous.scopeConnectionId !== effectiveConnectionId) ? { ...previous, invalidated: '当前终端已切换、断开或连接属性已变化。请取消此预览，重新选择命令。' } : previous);
  }, [activeSession?.id, connected, effectiveConnectionId]);
  useEffect(() => {
    setDispatch(previous => {
      if (!previous) return previous;
      const command = library.commands.find(item => item.id === previous.command.id);
      const group = library.groups.find(item => item.id === previous.group.id);
      return JSON.stringify(command) !== JSON.stringify(previous.command) || JSON.stringify(group) !== JSON.stringify(previous.group)
        ? { ...previous, invalidated: '命令或分组已发生变化。请取消此预览，重新查看内容与适用范围。' } : previous;
    });
  }, [library]);

  const connectionOptions = useMemo(() => {
    const options = new Map(connections.map(profile => [profile.id, { id: profile.id, name: profile.name, missing: false }]));
    if (activeSession && !options.has(activeSession.profile.id)) options.set(activeSession.profile.id, { id: activeSession.profile.id, name: activeSession.profile.name, missing: false });
    for (const group of library.groups) if (group.connectionId && !options.has(group.connectionId)) options.set(group.connectionId, { id: group.connectionId, name: group.connectionName || '已删除的连接', missing: true });
    return [...options.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [connections, library.groups, activeSession?.profile.id, activeSession?.profile.name]);
  const sourceName = (group: CommandGroup) => group.connectionId ? (connectionOptions.find(option => option.id === group.connectionId)?.name || group.connectionName || '已删除的连接') : '全局';
  const groups = useMemo(() => [...library.groups].sort(byOrder), [library.groups]);
  const commandsByGroup = useMemo(() => {
    const index = new Map<string, SavedCommand[]>();
    for (const command of library.commands) {
      const group = index.get(command.groupId);
      if (group) group.push(command); else index.set(command.groupId, [command]);
    }
    for (const commands of index.values()) commands.sort(byOrder);
    return index;
  }, [library.commands]);
  const availableGroups = useMemo(() => groups.filter(group => scope === scopeCurrent ? !group.connectionId || group.connectionId === effectiveConnectionId : scope === scopeGlobal ? !group.connectionId : group.connectionId === scope), [groups, scope, effectiveConnectionId]);
  const query = search.trim().toLocaleLowerCase();
  const visibleGroups = useMemo(() => availableGroups.flatMap(group => {
    const entries = commandsByGroup.get(group.id) || [];
    const groupMatches = !query || group.name.toLocaleLowerCase().includes(query);
    const commands = groupMatches ? entries : entries.filter(command => `${command.name}\n${command.command}\n${command.description}`.toLocaleLowerCase().includes(query));
    return !groupMatches && !commands.length ? [] : [{ group, commands }];
  }), [availableGroups, commandsByGroup, query]);
  const visibleCount = useMemo(() => visibleGroups.reduce((total, entry) => total + entry.commands.length, 0), [visibleGroups]);
  const selectedConnection = scope === scopeCurrent ? effectiveConnectionId : scope === scopeGlobal ? undefined : scope;
  const selectedOther = !!selectedConnection && selectedConnection !== effectiveConnectionId;

  const openEditor = (value: Editor) => { setError(''); setNotice(''); setDiscard(false); setEditor(value); setInitialEditor(JSON.stringify(value)); };
  const newGroup = () => {
    const connectionId = selectedConnection;
    openEditor({ type: 'group', fresh: true, value: { id: crypto.randomUUID(), name: '', order: Math.max(-1, ...groups.map(group => group.order)) + 1,
      ...(connectionId ? { connectionId, connectionName: connectionOptions.find(option => option.id === connectionId)?.name } : {}) } });
  };
  const newCommand = (group?: CommandGroup) => {
    const target = group || availableGroups[0] || groups.find(item => !item.connectionId);
    if (!target) { setNotice('先创建一个分组，再向其中添加命令。'); newGroup(); return; }
    openEditor({ type: 'command', fresh: true, value: { id: crypto.randomUUID(), groupId: target.id, name: '', command: '', description: '', mode: 'insert', confirmBeforeRun: false,
      order: Math.max(-1, ...(commandsByGroup.get(target.id) || []).map(command => command.order)) + 1 } });
  };
  const closeEditor = () => {
    if (busyRef.current) return;
    if (editor && JSON.stringify(editor) !== initialEditor) { setDiscard(true); return; }
    setEditor(null); setError('');
  };
  const perform = async (action: () => Promise<void>, close?: () => void) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); close?.(); }
    catch (cause) { setError(errorText(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const save = async () => {
    if (!editor) return;
    if (!editor.value.name.trim()) { setError('请填写名称。'); return; }
    if (editor.type === 'command' && (!editor.value.command.trim() || !groups.some(group => group.id === editor.value.groupId))) { setError('请填写命令并选择一个有效分组。'); return; }
    await perform(async () => {
      if (editor.type === 'group') {
        const value = { ...editor.value, name: editor.value.name.trim() };
        if (value.connectionId) value.connectionName = connectionOptions.find(option => option.id === value.connectionId)?.name || value.connectionName;
        else { delete value.connectionId; delete value.connectionName; }
        await api.saveCommandGroup(value);
      } else await api.saveCommand({ ...editor.value, name: editor.value.name.trim(), description: editor.value.description.trim() });
      await props.onRefresh();
    }, () => { setEditor(null); setDiscard(false); });
  };
  const remove = async () => {
    if (!deletion) return;
    await perform(async () => {
      if (deletion.type === 'group') await api.deleteCommandGroup(deletion.value.id);
      else await api.deleteCommand(deletion.value.id);
      await props.onRefresh();
    }, () => setDeletion(null));
  };
  const send = async (command: SavedCommand, mode: 'insert' | 'execute') => {
    const current = activeRef.current;
    if (!current.session || !current.connected || busyRef.current) return;
    const group = library.groups.find(item => item.id === command.groupId);
    if (!group) { setError('此命令的分组已不存在，请刷新后重试。'); return; }
    const borrowed = !!group.connectionId && group.connectionId !== current.effectiveConnectionId;
    setError(''); setNotice('');
    if (borrowed || (mode === 'execute' && command.confirmBeforeRun)) {
      setDispatch({ command: { ...command }, group: { ...group }, sourceLabel: `${sourceName(group)} / ${group.name}`, scopeConnectionId: current.effectiveConnectionId, mode, borrowed, target: structuredClone(current.session), invalidated: '' }); return;
    }
    await perform(() => props.onSend(command, mode, false));
  };
  const confirmSend = async () => {
    if (!dispatch || dispatch.invalidated) return;
    const current = activeRef.current;
    if (!current.connected || current.session?.id !== dispatch.target.id || current.effectiveConnectionId !== dispatch.scopeConnectionId) {
      setDispatch({ ...dispatch, invalidated: '当前终端已切换、断开或连接属性已变化。请取消此预览，重新选择命令。' });
      return;
    }
    const latestCommand = library.commands.find(command => command.id === dispatch.command.id);
    const latestGroup = library.groups.find(group => group.id === dispatch.group.id);
    if (JSON.stringify(latestCommand) !== JSON.stringify(dispatch.command) || JSON.stringify(latestGroup) !== JSON.stringify(dispatch.group)) {
      setDispatch({ ...dispatch, invalidated: '命令或分组已发生变化。请取消此预览，重新查看内容与适用范围。' });
      return;
    }
    await perform(() => props.onSend(dispatch.command, dispatch.mode, dispatch.borrowed), () => setDispatch(null));
  };
  const copy = async (command: SavedCommand) => {
    await perform(async () => { await api.writeClipboard(command.command); setNotice(`已复制“${command.name}”。`); });
  };
  const selectScope = (value: string) => { setScope(value); setError(''); setNotice(''); };
  const cancelButton = (onClick: () => void) => <button type="button" className="button secondary" disabled={busy} onClick={onClick}>取消</button>;

  return <aside id="command-sidebar" className="command-sidebar" aria-label="命令库" onKeyDown={event => event.stopPropagation()}>
    <header className="command-sidebar-header"><span><Terminal size={17} />命令库</span><div><button type="button" className="icon-button" title="新建分组" aria-label="新建命令分组" onClick={newGroup}><FolderPlus size={16} /></button><button type="button" className="icon-button" title="新建命令" aria-label="新建命令" onClick={() => newCommand()}><Plus size={17} /></button><button type="button" className="icon-button" title="收起命令库" aria-label="收起命令库" onClick={props.onClose}><ChevronRight size={17} /></button></div></header>
    <div className="command-sidebar-filters">
      <label className="sr-only" htmlFor="command-scope">命令显示范围</label><select id="command-scope" value={scope} onChange={event => selectScope(event.target.value)}>
        <option value={scopeCurrent}>当前连接与全局</option><option value={scopeGlobal}>仅全局</option>
        {connectionOptions.length > 0 && <optgroup label="按连接查看与借用">{connectionOptions.map(option => <option key={option.id} value={option.id}>{option.name}{option.missing ? '（连接已删除）' : ''}</option>)}</optgroup>}
      </select>
      <div className="command-search"><Search size={15} /><input aria-label="搜索命令" placeholder="搜索名称或命令内容" value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="icon-button" type="button" aria-label="清除命令搜索" onClick={() => setSearch('')}><X size={13} /></button>}</div>
      {selectedOther && <p className="command-scope-hint">正在查看其他连接的命令。填入或运行前会核对当前终端。</p>}
    </div>
    <div className="command-groups">
      {visibleGroups.map(({ group, commands }) => {
        const isCollapsed = !query && !!collapsed[group.id];
        const borrowed = !!group.connectionId && group.connectionId !== effectiveConnectionId;
        return <section className="command-group" key={group.id} aria-label={`${group.name}命令分组`}>
          <div className="command-group-header"><button type="button" className="command-group-toggle" aria-expanded={!isCollapsed} aria-controls={`command-group-${group.id}`} onClick={() => setCollapsed(previous => ({ ...previous, [group.id]: !previous[group.id] }))}>
            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<span title={group.name}>{group.name}</span><small>{commands.length}</small>
          </button><div className="command-group-tools"><button type="button" className="icon-button" aria-label={`向${group.name}添加命令`} title="添加命令" onClick={() => newCommand(group)}><Plus size={14} /></button><button type="button" className="icon-button" aria-label={`编辑${group.name}分组`} title="编辑分组" onClick={() => openEditor({ type: 'group', value: { ...group }, fresh: false })}><Pencil size={13} /></button><button type="button" className="icon-button" aria-label={`删除${group.name}分组`} title="删除分组" onClick={() => { setError(''); setDeletion({ type: 'group', value: group }); }}><Trash2 size={13} /></button></div></div>
          <div id={`command-group-${group.id}`} hidden={isCollapsed}>
            <div className="command-group-scope">{group.connectionId ? `连接 · ${sourceName(group)}` : '全局可用'}{borrowed && <span>借用</span>}</div>
            {commands.map(command => <article className="command-card" key={command.id}>
              <div className="command-card-heading"><button type="button" className="command-card-name" title={`编辑“${command.name}”`} onClick={() => openEditor({ type: 'command', value: { ...command }, fresh: false })}>{command.name}</button><div><button type="button" className="icon-button" aria-label={`复制${command.name}`} title="复制命令" onClick={() => void copy(command)}><Copy size={13} /></button><button type="button" className="icon-button" aria-label={`删除${command.name}`} title="删除命令" onClick={() => { setError(''); setDeletion({ type: 'command', value: command }); }}><Trash2 size={13} /></button></div></div>
              {command.description && <p className="command-description">{command.description}</p>}
              <pre className="command-card-code" title={command.command}>{command.command}</pre>
              <div className="command-card-actions"><span>{command.mode === 'execute' ? '默认运行' : '默认填入'}{command.confirmBeforeRun ? ' · 运行前确认' : ''}</span><button type="button" className={`button command-action${command.mode === 'insert' ? ' preferred' : ''}`} disabled={!connected || !activeSession || busy} title={connected ? '填入当前终端，不追加回车' : '连接服务器后可填入'} aria-label={`填入${command.name}`} onClick={() => void send(command, 'insert')}>填入</button><button type="button" className={`button command-action${command.mode === 'execute' ? ' preferred' : ''}`} disabled={!connected || !activeSession || busy} title={connected ? '发送到当前终端并回车' : '连接服务器后可运行'} aria-label={`运行${command.name}`} onClick={() => void send(command, 'execute')}><Play size={11} />运行</button></div>
            </article>)}
            {!commands.length && <button type="button" className="command-group-empty" onClick={() => newCommand(group)}>添加第一条命令</button>}
          </div>
        </section>;
      })}
      {!visibleGroups.length && <div className="command-empty"><Terminal size={27} strokeWidth={1.3} /><strong>{query ? '没有匹配的命令' : '把常用命令放在这里'}</strong><p>{query ? '试试其他名称或命令片段。' : '按用途分组，可共享给所有终端，也可只属于一个连接。'}</p>{!query && <button type="button" className="button secondary" onClick={newGroup}><FolderPlus size={15} />新建分组</button>}</div>}
    </div>
    {(error && !modalOpen) && <div className="command-feedback form-error" role="alert">{error}</div>}
    {notice && !modalOpen && <div className="command-feedback" role="status">{notice}</div>}
    <footer className="command-sidebar-footer"><span>{visibleCount} 条命令</span><span title={activeSession ? endpoint(activeSession) : undefined}>{connected && activeSession ? `目标 · ${activeSession.profile.name}` : '未连接 · 可编辑与复制'}</span></footer>

    {editor && <CommandModal title={editor.type === 'group' ? editor.fresh ? '新建命令分组' : '编辑命令分组' : editor.fresh ? '新建命令' : '编辑命令'} busy={busy} onClose={closeEditor} footer={<>{cancelButton(closeEditor)}<button type="button" className="button primary" disabled={busy || discard} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></>}>
      <fieldset disabled={busy || discard} className="command-editor-fields">
        <label className="form-field"><span>名称</span><input data-autofocus id="command-editor-name" maxLength={100} value={editor.value.name} onChange={event => setEditor({ ...editor, value: { ...editor.value, name: event.target.value } } as Editor)} placeholder={editor.type === 'group' ? '例如：部署与维护' : '例如：查看磁盘空间'} /></label>
        {editor.type === 'group' ? <label className="form-field"><span>适用范围</span><select id="command-group-owner" value={editor.value.connectionId || ''} onChange={event => setEditor({ ...editor, value: { ...editor.value, connectionId: event.target.value || undefined, connectionName: connectionOptions.find(option => option.id === event.target.value)?.name } })}><option value="">全局 · 所有连接可用</option>{connectionOptions.map(option => <option key={option.id} value={option.id}>{option.name}{option.missing ? '（连接已删除）' : ''}</option>)}</select><small>按连接保存的命令在关闭标签、重新连接后仍然保留。更改范围会作用于此分组内所有命令。</small></label> : <>
          <label className="form-field"><span>分组</span><select id="command-editor-group" value={editor.value.groupId} onChange={event => setEditor({ ...editor, value: { ...editor.value, groupId: event.target.value } })}>{groups.map(group => <option key={group.id} value={group.id}>{group.name} · {sourceName(group)}</option>)}</select></label>
          <label className="form-field"><span>命令</span><textarea id="command-editor-text" rows={7} spellCheck={false} value={editor.value.command} onChange={event => setEditor({ ...editor, value: { ...editor.value, command: event.target.value } })} placeholder="df -h" /><small>支持多行。填入不追加回车，运行会在当前终端发送命令并回车。</small></label>
          <label className="form-field"><span>说明 <small>可选</small></span><input id="command-editor-description" maxLength={2000} value={editor.value.description} onChange={event => setEditor({ ...editor, value: { ...editor.value, description: event.target.value } })} placeholder="描述用途或执行条件" /></label>
          <div className="command-editor-options"><label className="form-field"><span>常用操作</span><select id="command-editor-mode" value={editor.value.mode} onChange={event => setEditor({ ...editor, value: { ...editor.value, mode: event.target.value as 'insert' | 'execute' } })}><option value="insert">填入终端</option><option value="execute">运行命令</option></select></label><label className="command-confirm-option"><input id="command-editor-confirm" type="checkbox" checked={editor.value.confirmBeforeRun} onChange={event => setEditor({ ...editor, value: { ...editor.value, confirmBeforeRun: event.target.checked } })} /><span>运行前预览确认</span></label></div>
        </>}
      </fieldset>
      {error && <div className="form-error" role="alert">{error}</div>}
      {discard && <div className="command-discard" role="alert"><strong>放弃未保存的修改？</strong><div><button type="button" className="button secondary" data-autofocus onClick={() => setDiscard(false)}>继续编辑</button><button type="button" className="button secondary" onClick={() => { setEditor(null); setDiscard(false); setError(''); }}>放弃修改</button></div></div>}
    </CommandModal>}

    {deletion && <CommandModal title={deletion.type === 'group' ? '删除命令分组' : '删除命令'} busy={busy} onClose={() => { if (!busy) { setDeletion(null); setError(''); } }} footer={<>{cancelButton(() => { setDeletion(null); setError(''); })}<button type="button" className="button danger" disabled={busy} onClick={() => void remove()}>{busy ? '正在删除…' : '确认删除'}</button></>}>
      <p>确定删除“{deletion.value.name}”？{deletion.type === 'group' ? `此分组中的 ${commandsByGroup.get(deletion.value.id)?.length || 0} 条命令也会删除。` : ''}</p><p className="command-help">不会执行命令或影响正在运行的终端。</p>{error && <div className="form-error" role="alert">{error}</div>}
    </CommandModal>}

    {dispatch && <CommandModal title={dispatch.borrowed ? '借用其他连接的命令' : '运行前确认'} busy={busy} onClose={() => { if (!busy) { setDispatch(null); setError(''); } }} footer={<>{cancelButton(() => { setDispatch(null); setError(''); })}<button type="button" className="button primary" disabled={busy || !!dispatch.invalidated || !connected || activeSession?.id !== dispatch.target.id} onClick={() => void confirmSend()}>{busy ? '发送中…' : dispatch.mode === 'execute' ? '确认运行' : '确认填入'}</button></>}>
      <dl className="command-target"><div><dt>来源</dt><dd>{dispatch.sourceLabel} / {dispatch.command.name}</dd></div><div><dt>目标终端</dt><dd><strong>{dispatch.target.profile.name}</strong><span>{endpoint(dispatch.target)}</span></dd></div></dl>
      <pre className="command-preview" tabIndex={0}>{dispatch.command.command}</pre><p className="command-help">{dispatch.mode === 'execute' ? '将以上完整内容发送到这个终端并回车。' : '将以上完整内容填入这个终端，不追加回车。'}</p>
      {dispatch.invalidated && <div className="form-error" role="alert">{dispatch.invalidated}</div>}{error && <div className="form-error" role="alert">{error}</div>}
    </CommandModal>}
  </aside>;
}
