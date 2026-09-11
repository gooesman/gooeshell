import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Cloud, Database, FileCode2, Folder, FolderPlus, MoreHorizontal, Plus, Router, Server, Settings2 } from 'lucide-react';
import type { ConnectionGroup, HostProfile, SessionInfo } from '../shared/types';
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
  onGroupCreate: () => void;
  onGroupEdit: (group: ConnectionGroup) => void;
  onGroupDelete: (group: ConnectionGroup) => void;
  onGroupMove?: (id: string, direction: 'up' | 'down') => void;
  onToggle: () => void;
  onQuickConnect: () => void;
  onSettings: () => void;
  connectShortcut?: string;
  settingsShortcut?: string;
  toggleShortcut?: string;
}

export default function ConnectionSidebar(props: ConnectionSidebarProps) {
  const { profiles, groups, sessions, activeId, closed, collapsed } = props;
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ group: ConnectionGroup; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); } };
    document.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', escape);
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { document.removeEventListener('mousedown', dismiss); window.removeEventListener('keydown', escape); };
  }, [menu]);
  const active = sessions.find(session => session.id === activeId);
  const groupIds = new Set(groups.map(group => group.id));
  const ungrouped = profiles.filter(profile => !profile.groupId || !groupIds.has(profile.groupId));
  const openMenu = (event: React.MouseEvent, group: ConnectionGroup) => {
    event.preventDefault(); event.stopPropagation();
    setMenu({ group, x: Math.min(event.clientX, window.innerWidth - 205), y: Math.max(5, Math.min(event.clientY, window.innerHeight - 215)) });
  };
  const hosts = (items: HostProfile[]) => items.map(profile => {
    const online = sessions.some(session => session.profile.id === profile.id && !closed[session.id]);
    const selected = active?.profile.id === profile.id;
    return <button type="button" key={profile.id} className={`host${selected ? ' active' : ''}`} aria-current={selected ? 'page' : undefined}
      title={`${profile.name}\n${profile.username}@${profile.host}:${profile.port}\n${online ? '点击切换到终端' : '点击连接'} · 右键设置`}
      onClick={() => props.onConnect(profile)} onContextMenu={event => props.onContextMenu(event, profile)}>
      <span className="host-icon"><ConnectionIcon name={profile.icon} /></span>
      <span className="host-copy"><span className="host-name">{profile.name}</span><span className="host-address">{profile.username}@{profile.host}</span></span>
      {online && <span className="host-dot" aria-label="已连接" />}
    </button>;
  });
  return <aside id="server-sidebar" className={`sidebar connection-sidebar${collapsed ? ' collapsed' : ''}`}>
    <div className="brand"><img className="brand-mark" src="./gooeshell-icon.png" alt="" aria-hidden="true" draggable={false} /><span>gooeshell</span><small>PREVIEW</small></div>
    <div className="sidebar-actions"><button type="button" className="button primary" aria-label="快速连接" title={`快速连接${props.connectShortcut ? ` · ${props.connectShortcut}` : ''}`} onClick={props.onQuickConnect}><Plus size={16} /><span className="item-label">快速连接</span></button></div>
    <div className="sidebar-heading connection-heading"><span>我的服务器 <span className="connection-total">{profiles.length}</span></span><button type="button" className="icon-button" aria-label="新建连接分组" title="新建分组" onClick={props.onGroupCreate}><FolderPlus size={15} /></button></div>
    <nav className="hosts" aria-label="已保存的服务器">
      {groups.map(group => {
        const items = profiles.filter(profile => profile.groupId === group.id);
        const isCollapsed = !collapsed && !!collapsedGroups[group.id];
        return <section className="connection-group" key={group.id} aria-label={group.name}>
          <div className="connection-group-heading" onContextMenu={event => openMenu(event, group)}>
            <button type="button" className="connection-group-toggle" aria-expanded={!isCollapsed} aria-controls={`connection-group-${group.id}`} title={group.name}
              onClick={() => setCollapsedGroups(previous => ({ ...previous, [group.id]: !previous[group.id] }))}>
              {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<ConnectionIcon name={group.icon || 'folder'} size={14} /><span>{group.name}</span><small>{items.length}</small>
            </button>
            <button type="button" className="connection-group-more" title={`${group.name} · 分组设置`} aria-label={`${group.name}分组菜单`} onClick={event => openMenu(event, group)}><MoreHorizontal size={15} /></button>
          </div>
          <div id={`connection-group-${group.id}`} hidden={isCollapsed}>
            {hosts(items)}{items.length === 0 && !collapsed && <div className="connection-group-empty">在连接设置中将服务器加入此分组</div>}
          </div>
        </section>;
      })}
      {ungrouped.length > 0 && <section className="connection-group ungrouped" aria-label="未分组">{groups.length > 0 && <div className="connection-ungrouped-label">未分组 <small>{ungrouped.length}</small></div>}{hosts(ungrouped)}</section>}
      {profiles.length === 0 && groups.length === 0 && <div className="sidebar-empty">收藏的服务器会显示在这里。<br />连接设置可以单独保存。</div>}
    </nav>
    <div className="sidebar-bottom"><button type="button" onClick={props.onToggle} aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'} aria-expanded={!collapsed} aria-controls="server-sidebar" title={`${collapsed ? '展开侧边栏' : '折叠侧边栏'}${props.toggleShortcut ? ` · ${props.toggleShortcut}` : ''}`}>{collapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}<span className="item-label">折叠侧栏</span></button><button type="button" onClick={props.onSettings} title={`设置${props.settingsShortcut ? ` · ${props.settingsShortcut}` : ''}`} aria-label="设置"><Settings2 size={17} /><span className="item-label">设置</span>{props.settingsShortcut && <kbd>{props.settingsShortcut}</kbd>}</button></div>
    {menu && <div ref={menuRef} className="context-menu connection-group-menu" role="menu" aria-label="连接分组操作" style={{ left: menu.x, top: menu.y }}>
      <div className="menu-caption">{menu.group.name}</div>
      <button type="button" role="menuitem" onClick={() => { props.onGroupEdit(menu.group); setMenu(null); }}>名称与图标…</button>
      {props.onGroupMove && <><button type="button" role="menuitem" disabled={groups[0]?.id === menu.group.id} onClick={() => { props.onGroupMove?.(menu.group.id, 'up'); setMenu(null); }}>上移</button><button type="button" role="menuitem" disabled={groups.at(-1)?.id === menu.group.id} onClick={() => { props.onGroupMove?.(menu.group.id, 'down'); setMenu(null); }}>下移</button></>}
      <hr /><button type="button" role="menuitem" onClick={() => { props.onGroupDelete(menu.group); setMenu(null); }}>删除分组（保留连接）</button>
    </div>}
  </aside>;
}
