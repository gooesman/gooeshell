import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronLeft, ChevronRight, Cloud, Database, FileCode2, Folder, FolderPlus, GripVertical, ListChecks, Plus, Router, Server, Square, CheckSquare2 } from 'lucide-react';
import type { ConnectionGroup, HostProfile, SessionInfo, MoveConnectionsRequest, MoveConnectionGroupRequest } from '../shared/types';
import { sameConnection } from '../shared/connections';
import { isSshSession } from '../shared/sessions';
import './connection-manager.css';

export const connectionIcons = [
  { id: 'server', name: '服务器', component: Server },
  { id: 'cloud', name: '云服务器', component: Cloud },
  { id: 'database', name: '数据库', component: Database },
  { id: 'router', name: '网络设备', component: Router },
  { id: 'code', name: '开发环境', component: FileCode2 },
  { id: 'folder', name: '文件夹', component: Folder },
] as const;

export function ConnectionIcon({ name, size = 17 }: { name?: string; size?: number }) {
  const Icon = connectionIcons.find(icon => icon.id === name)?.component || Server;
  return <Icon size={size} strokeWidth={1.65} aria-hidden="true" />;
}

export interface ConnectionSidebarProps {
  profiles: HostProfile[];
  groups: ConnectionGroup[];
  sessions: SessionInfo[];
  activeId: string;
  closed: Record<string, string>;
  collapsed: boolean;
  onConnect: (profile: HostProfile) => void;
  onContextMenu: (event: React.MouseEvent, profile: HostProfile) => void;
  onGroupMenuOpen?: () => void;
  onGroupCreate: () => void;
  onGroupEdit: (group: ConnectionGroup) => void;
  onGroupDelete: (group: ConnectionGroup) => void;
  onGroupMove?: (id: string, direction: 'up' | 'down') => void;
  onToggle: () => void;
  onQuickConnect: () => void;
  onMoveConnections: (request: MoveConnectionsRequest) => Promise<void>;
  onMoveConnectionGroup: (request: MoveConnectionGroupRequest) => Promise<void>;
  onBatchDelete: (profiles: HostProfile[]) => void;
  onSettings?: () => void;
  connectShortcut?: string;
  settingsShortcut?: string;
  toggleShortcut?: string;
}

export default function ConnectionSidebar(props: ConnectionSidebarProps) {
  const { profiles, groups, sessions, activeId, closed, collapsed } = props;
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ group: ConnectionGroup; x: number; y: number } | null>(null);
  const [managing, setManaging] = useState(false), [selectedIds, setSelectedIds] = useState<string[]>([]), [moving, setMoving] = useState(false);
  const drag = useRef<{kind:'connections';ids:string[]}|{kind:'group';id:string}|null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); } };
    const close = () => setMenu(null);
    document.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { document.removeEventListener('mousedown', dismiss); window.removeEventListener('keydown', escape); window.removeEventListener('blur', close); window.removeEventListener('resize', close); };
  }, [menu]);
  useEffect(() => { setMenu(null); }, [collapsed]);
  useEffect(() => { const visible=new Set(profiles.map(profile=>profile.id));setSelectedIds(previous=>previous.every(id=>visible.has(id))?previous:previous.filter(id=>visible.has(id))); }, [profiles]);
  const active = sessions.find(session => session.id === activeId);
  const groupIds = new Set(groups.map(group => group.id));
  const ungrouped = profiles.filter(profile => !profile.groupId || !groupIds.has(profile.groupId));
  const orderedProfiles = [...groups.flatMap(group=>profiles.filter(profile=>profile.groupId===group.id)),...ungrouped];
  const selected = profiles.filter(profile => selectedIds.includes(profile.id));
  const moveConnections = (event:React.DragEvent,groupId?:string,beforeId?:string) => {
    if(!managing||drag.current?.kind!=='connections')return;
    event.preventDefault();event.stopPropagation();const ids=drag.current.ids;drag.current=null;setMoving(true);
    void props.onMoveConnections({ids,groupId,beforeId}).finally(()=>setMoving(false));
  };
  const moveGroup = (event:React.DragEvent,group:ConnectionGroup) => {
    if(!managing||drag.current?.kind!=='group')return;
    event.preventDefault();event.stopPropagation();const id=drag.current.id;drag.current=null;if(id===group.id)return;
    const remaining=groups.filter(value=>value.id!==id),index=remaining.findIndex(value=>value.id===group.id);
    const after=event.clientY>event.currentTarget.getBoundingClientRect().top+event.currentTarget.getBoundingClientRect().height/2;
    setMoving(true);void props.onMoveConnectionGroup({id,beforeId:remaining[index+(after?1:0)]?.id}).finally(()=>setMoving(false));
  };
  const openMenu = (event: React.MouseEvent | React.KeyboardEvent, group: ConnectionGroup) => {
    event.preventDefault(); event.stopPropagation();
    props.onGroupMenuOpen?.();
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = 'clientX' in event ? event.clientX : bounds.right;
    const y = 'clientY' in event ? event.clientY : bounds.top;
    setMenu({ group, x: Math.max(5, Math.min(x, window.innerWidth - 205)), y: Math.max(5, Math.min(y, window.innerHeight - 215)) });
  };
  const hosts = (items: HostProfile[]) => items.map(profile => {
    const online = sessions.some(session => isSshSession(session) && sameConnection(session.profile, profile) && !closed[session.id]);
    const selected = !!active && isSshSession(active) && sameConnection(active.profile, profile);
    const checked=selectedIds.includes(profile.id);
    return <button type="button" key={profile.id} className={`host${selected ? ' active' : ''}${managing ? ' managing' : ''}${checked ? ' checked' : ''}`} aria-current={selected ? 'page' : undefined}
      aria-label={`${profile.name}，${profile.username}@${profile.host}:${profile.port}`}
      aria-pressed={managing?checked:undefined} draggable={managing&&!moving}
      title={managing?'点击选择 · 拖动排序或移动到其他分组':`${profile.name}\n${profile.username}@${profile.host}:${profile.port}\n${online ? '点击切换到终端' : '点击连接'} · 右键打开连接设置`}
      onDragStart={event=>{if(!managing)return;const ids=checked?orderedProfiles.filter(item=>selectedIds.includes(item.id)).map(item=>item.id):[profile.id];if(!checked)setSelectedIds(ids);drag.current={kind:'connections',ids};event.dataTransfer.setData('text/plain','gooeshell-connections');event.dataTransfer.effectAllowed='move';}}
      onDragEnd={()=>{drag.current=null;}}
      onDragOver={event=>{if(managing&&drag.current?.kind==='connections')event.preventDefault();}}
      onDrop={event=>{if(drag.current?.kind!=='connections')return;event.preventDefault();event.stopPropagation();const draggedIds=drag.current.ids;if(draggedIds.includes(profile.id)){drag.current=null;return;}const remaining=items.filter(item=>!draggedIds.includes(item.id));const index=remaining.findIndex(item=>item.id===profile.id);const bounds=event.currentTarget.getBoundingClientRect();const after=event.clientY>bounds.top+bounds.height/2;moveConnections(event,profile.groupId,remaining[index+(after?1:0)]?.id);}}
      onClick={() => { setMenu(null); if(managing){setSelectedIds(previous=>checked?previous.filter(id=>id!==profile.id):[...previous,profile.id]);return;} props.onConnect(profile); }} onContextMenu={event => { setMenu(null); if(managing)event.preventDefault();else props.onContextMenu(event, profile); }}>
      {managing && (checked?<CheckSquare2 className="manage-check" size={16}/>:<Square className="manage-check" size={16}/>)}
      {collapsed && <span className="host-icon"><ConnectionIcon name={profile.icon} /></span>}
      <span className="host-copy"><span className="host-name">{profile.name}</span><span className="host-address">{profile.username}@{profile.host}</span></span>
      {online && <span className="host-dot" aria-label="已连接" />}
    </button>;
  });
  return <aside id="server-sidebar" className={`sidebar connection-sidebar${collapsed ? ' collapsed' : ''}`}>
    <div className="brand"><img className="brand-mark" src="./gooeshell-icon.png" alt="" aria-hidden="true" draggable={false} /><span>GooeShell</span></div>
    <div className="sidebar-actions"><button type="button" className="button primary" aria-label="快速连接" title={`快速连接${props.connectShortcut ? ` · ${props.connectShortcut}` : ''}`} onClick={props.onQuickConnect}><Plus size={16} /><span className="item-label">快速连接</span></button></div>
    <div className="sidebar-heading connection-heading"><span>我的服务器 <span className="connection-total">{profiles.length}</span></span><div className="connection-heading-actions"><button type="button" className="icon-button" aria-label={managing?'完成连接管理':'管理连接'} title={managing?'完成管理':'管理、排序与批量删除'} aria-pressed={managing} onClick={()=>{setManaging(value=>!value);setSelectedIds([]);setMenu(null);if(!managing&&collapsed)props.onToggle();}}><ListChecks size={15}/></button><button type="button" className="icon-button" aria-label="新建连接分组" title="新建分组" onClick={props.onGroupCreate}><FolderPlus size={15} /></button></div></div>
    {managing&&!collapsed&&<div className="connection-manage-bar"><button type="button" onClick={()=>setSelectedIds(selected.length===profiles.length?[]:profiles.map(profile=>profile.id))}>{selected.length===profiles.length&&profiles.length?'取消全选':'全选'}</button><span>已选 {selected.length}</span><button type="button" disabled={!selected.length||moving} onClick={()=>props.onBatchDelete(selected)}>删除</button></div>}
    <nav className="hosts" aria-label="已保存的服务器">
      {groups.map(group => {
        const items = profiles.filter(profile => profile.groupId === group.id);
        const isCollapsed = !!collapsedGroups[group.id];
        return <section className="connection-group" key={group.id} aria-label={group.name}>
          <div className="connection-group-heading" onContextMenu={event => {if(managing)event.preventDefault();else openMenu(event, group);}} onDragOver={event=>{if(managing&&drag.current)event.preventDefault();}} onDrop={event=>{if(drag.current?.kind==='group')moveGroup(event,group);else moveConnections(event,group.id);}}>
            {managing&&<span className="group-drag-handle" draggable={!moving} title="拖动分组排序" aria-label={`拖动分组 ${group.name} 排序`} onDragStart={event=>{event.stopPropagation();drag.current={kind:'group',id:group.id};event.dataTransfer.setData('text/plain','gooeshell-group');event.dataTransfer.effectAllowed='move';}} onDragEnd={()=>{drag.current=null;}}><GripVertical size={14}/></span>}
            <button type="button" className="connection-group-toggle" aria-label={`${group.name}，${items.length} 个连接`} aria-expanded={!isCollapsed} aria-controls={`connection-group-${group.id}`} title={`${group.name} · ${items.length} 个连接\n点击${isCollapsed ? '展开' : '收起'} · 右键分组设置`}
              onClick={() => { setMenu(null); setCollapsedGroups(previous => ({ ...previous, [group.id]: !previous[group.id] })); }}
              onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openMenu(event, group); }}>
              {isCollapsed ? <ChevronRight className="connection-group-chevron" size={13} /> : <ChevronDown className="connection-group-chevron" size={13} />}<ConnectionIcon name={group.icon || 'folder'} size={14} /><span>{group.name}</span><small>{items.length}</small>
            </button>
          </div>
          <div id={`connection-group-${group.id}`} hidden={isCollapsed}>
            {hosts(items)}{items.length === 0 && !collapsed && <div className="connection-group-empty">在连接设置中将服务器加入此分组</div>}
          </div>
        </section>;
      })}
      {(ungrouped.length > 0||managing) && <section className="connection-group ungrouped" aria-label="未分组"><div className="connection-ungrouped-label" title={`未分组 · ${ungrouped.length} 个连接`} onDragOver={event=>{if(managing&&drag.current?.kind==='connections')event.preventDefault();}} onDrop={event=>moveConnections(event)}><Folder size={14} aria-hidden="true" /><span>未分组</span><small>{ungrouped.length}</small></div>{hosts(ungrouped)}</section>}
      {profiles.length === 0 && groups.length === 0 && <div className="sidebar-empty" title="收藏的服务器会显示在这里，连接设置可以单独保存。">{collapsed ? '暂无连接' : <>收藏的服务器会显示在这里。<br />连接设置可以单独保存。</>}</div>}
    </nav>
    <div className="sidebar-bottom"><button type="button" onClick={props.onToggle} aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'} aria-expanded={!collapsed} aria-controls="server-sidebar" title={`${collapsed ? '展开侧边栏' : '折叠侧边栏'}${props.toggleShortcut ? ` · ${props.toggleShortcut}` : ''}`}>{collapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}<span className="item-label">折叠侧栏</span></button></div>
    {menu && createPortal(<div ref={menuRef} className="context-menu connection-group-menu" role="menu" aria-label="连接分组操作" style={{ left: menu.x, top: menu.y }}>
      <div className="menu-caption">{menu.group.name}</div>
      <button type="button" role="menuitem" onClick={() => { props.onGroupEdit(menu.group); setMenu(null); }}>名称与图标…</button>
      {props.onGroupMove && <><button type="button" role="menuitem" disabled={groups[0]?.id === menu.group.id} onClick={() => { props.onGroupMove?.(menu.group.id, 'up'); setMenu(null); }}>上移</button><button type="button" role="menuitem" disabled={groups.at(-1)?.id === menu.group.id} onClick={() => { props.onGroupMove?.(menu.group.id, 'down'); setMenu(null); }}>下移</button></>}
      <hr /><button type="button" role="menuitem" onClick={() => { props.onGroupDelete(menu.group); setMenu(null); }}>删除分组（保留连接）</button>
    </div>, document.body)}
  </aside>;
}
