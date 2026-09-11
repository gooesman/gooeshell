import type { MouseEvent } from 'react';
import { Clock3, ArrowUpRight } from 'lucide-react';
import { ConnectionIcon } from './ConnectionSidebar';
import type { ConnectionHistoryEntry, HostProfile } from '../shared/types';

export default function ConnectionHome({ history, showHistory, connectShortcut, onCreate, onSettings, onPick, onContextMenu }: {
  history: ConnectionHistoryEntry[]; showHistory: boolean; connectShortcut: string;
  onCreate: () => void; onSettings: () => void; onPick: (profile: HostProfile) => void; onContextMenu: (event:MouseEvent, profile:HostProfile) => void;
}) {
  return <div className={`connection-home${showHistory && history.length ? ' with-history' : ''}`}>
    <div className="home-intro">
      <img className="home-icon" src="./gooeshell-icon.png" alt="gooeshell" draggable={false} />
      <h1>连接，开始工作。</h1>
      <p>选择已保存的服务器，或打开一个快速连接。</p>
      <div className="empty-actions"><button className="button primary" onClick={onCreate}>+ 快速连接</button><button className="button secondary" onClick={onSettings}>字体与快捷键</button></div>
      <span className="home-shortcut">{connectShortcut} 快速连接 · F11 全屏</span>
    </div>
    {showHistory && history.length > 0 && <section className="recent-connections" aria-label="最近连接">
      <div className="recent-heading"><span><Clock3 size={15} />最近连接</span><span>点击重新连接</span></div>
      <div className="recent-list">{history.map(({profile, connectedAt}) => <button className="recent-connection" key={profile.id} onClick={() => onPick(profile)} onContextMenu={event => onContextMenu(event,profile)}>
        <ConnectionIcon name={profile.icon} size={18} /><span className="recent-copy"><strong>{profile.name}</strong><span>{profile.username}@{profile.host}:{profile.port}</span></span>
        <time dateTime={new Date(connectedAt).toISOString()}>{new Date(connectedAt).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}</time><ArrowUpRight size={15} />
      </button>)}</div>
    </section>}
  </div>;
}
