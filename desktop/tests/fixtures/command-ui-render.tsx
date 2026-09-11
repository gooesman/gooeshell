import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import CommandSidebar from '../../src/renderer/CommandSidebar';
import { api } from '../../src/renderer/api';
import type { CommandLibrary, HostProfile, SessionInfo } from '../../src/shared/types';
import '../../src/renderer/styles.css';
import '../../src/renderer/workspace.css';

const profiles: HostProfile[] = [
  { id: 'one', name: '开发服务器', host: 'dev.example.test', port: 22, username: 'developer', auth: 'password', rememberHost: true, encoding: 'utf8' },
  { id: 'two', name: '测试设备', host: '192.0.2.5', port: 22, username: 'root', auth: 'password', rememberHost: false, encoding: 'utf8' },
];
const actions: Array<{ type: string; value?: unknown }> = [];
function Fixture() {
  const [library, setLibrary] = useState<CommandLibrary>({ groups: [], commands: [] });
  const [session, setSession] = useState<SessionInfo>({ id: 'transport-one', tabId: 'tab-one', profile: profiles[0] });
  const [connected, setConnected] = useState(true);
  const [scopeConnectionId, setScopeConnectionId] = useState<string>();
  const [instance, setInstance] = useState(0);
  const refresh = async () => { setLibrary(await api.commandLibrary()); };
  useEffect(() => {
    void refresh();
    (window as any).commandFixture = { actions, setConnected, setScopeConnectionId,
      switchSession: (id: string) => setSession({ id: `transport-${id}`, tabId: `tab-${id}`, profile: profiles.find(profile => profile.id === id)! }),
      setTheme: (theme: string) => { document.documentElement.dataset.theme = theme; },
      replaceCommand: async (id: string, text: string) => { const current = await api.commandLibrary(); await api.saveCommand({ ...current.commands.find(command => command.id === id)!, command: text }); await refresh(); },
      reload: async () => { await refresh(); setInstance(value => value + 1); },
    };
  }, []);
  return <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
    <main style={{ flex: 1, minWidth: 0, padding: 25 }}><h2 style={{ fontSize: 16 }}>gooeshell</h2><p style={{ color: 'var(--text-muted)' }}>当前终端 · {session.profile.name}</p><div style={{ background: 'var(--surface-sunken)', borderRadius: 12, height: '70vh', padding: 20, fontFamily: 'Consolas, monospace' }}>developer@dev:~$</div></main>
    <CommandSidebar key={instance} library={library} connections={profiles} activeSession={session} scopeConnectionId={scopeConnectionId} connected={connected} onRefresh={refresh}
      onSend={async (command, mode, borrowed) => { actions.push({ type: 'send', value: { command, mode, borrowed, sessionId: session.id } }); }}
      onClose={() => actions.push({ type: 'close' })} onModalChange={open => actions.push({ type: 'modal', value: open })} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
