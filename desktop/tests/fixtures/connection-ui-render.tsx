import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ConnectionDialog from '../../src/renderer/ConnectionDialog';
import ConnectionSidebar from '../../src/renderer/ConnectionSidebar';
import type { HostProfile } from '../../src/shared/types';
import '../../src/renderer/styles.css';
import '../../src/renderer/workspace.css';

const profiles: HostProfile[] = [
  { id: 'one', name: '开发服务器', host: 'dev.example.test', port: 22, username: 'developer', auth: 'password', rememberHost: true, encoding: 'utf8', groupId: 'development', icon: 'code' },
  { id: 'two', name: '测试设备', host: '192.0.2.5', port: 22, username: 'root', auth: 'key', privateKeyPath: '/fixture/key', rememberHost: false, encoding: 'utf8', icon: 'router' },
];
const groups = [{ id: 'development', name: '开发环境', icon: 'folder' as const, order: 0 }];
const actions: Array<{ type: string; value?: unknown }> = [];

function Fixture() {
  const [dialog, setDialog] = useState<{ profile?: HostProfile } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [busy, setBusy] = useState(false);
  const pendingConnect = useRef<(() => void) | null>(null);
  useEffect(() => { (window as any).connectionFixture = { actions, setTheme, holdNextConnect: false }; }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const record = (type: string, value?: unknown) => { actions.push({ type, value }); };
  return <div className="app-shell">
    <ConnectionSidebar profiles={profiles} groups={groups} sessions={[{ id: 'transport-two', tabId: 'tab-one', profile: profiles[0] }]} activeId="transport-two" closed={{}} collapsed={collapsed}
      onConnect={profile => record('activate', profile.id)} onContextMenu={(_event, profile) => record('context', profile.id)}
      onGroupCreate={() => record('createGroup')} onGroupEdit={group => record('editGroup', group.id)} onGroupDelete={group => record('deleteGroup', group.id)}
      onToggle={() => setCollapsed(value => !value)} onQuickConnect={() => setDialog({})} onSettings={() => record('settings')} />
    <main style={{ padding: 30, flex: 1 }}><button type="button" className="button secondary" onClick={() => setDialog({ profile: profiles[0] })}>Edit fixture</button><button type="button" className="button secondary" onClick={() => setDialog({})}>New fixture</button></main>
    {dialog && <ConnectionDialog key={dialog.profile?.id || 'new'} profile={dialog.profile} saved={!!dialog.profile} groups={groups} busy={busy} error="" hostKeyPreferences={[]}
      onSave={async (profile, favorite, credentials) => record('save', { profile, favorite, credentials })}
      onConnect={async (profile, credentials, favorite) => { record('connect', { profile, favorite, credentials }); if ((window as any).connectionFixture.holdNextConnect) { (window as any).connectionFixture.holdNextConnect = false; setBusy(true); await new Promise<void>(resolve => { pendingConnect.current = resolve; }); return; } setDialog(null); }}
      onCancelConnect={() => { record('cancel'); setBusy(false); pendingConnect.current?.(); pendingConnect.current = null; }} onClose={() => setDialog(null)} />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
