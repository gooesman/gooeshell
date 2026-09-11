import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import useConnections from '../../src/renderer/useConnections';
import ConnectionAuthDialog from '../../src/renderer/ConnectionAuthDialog';
import type { CredentialUpdate, HostProfile, SessionInfo } from '../../src/shared/types';
import '../../src/renderer/styles.css';

const messages: Array<{ message: string; error?: boolean }> = [];
function Fixture() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [tabs, setTabs] = useState<string[] | undefined>(undefined);
  const [activeId, setActiveId] = useState('');
  const [closed, setClosed] = useState<Record<string, string>>({});
  const connection = useConnections({ sessions, setSessions, tabs, setTabs: tabs === undefined ? undefined : update => setTabs(previous => typeof update === 'function' ? update(previous || []) : update), activeId, setActiveId, closed, notify: (message, error) => messages.push({ message, error }), sudoSubmit: false });
  useEffect(() => {
    (window as any).connectionHarness = {
      state: { sessions, tabs, activeId, closed, pending: connection.pending, hasUntargetedPending: connection.hasUntargetedPending, prompt: connection.authPrompt, authBusy: connection.authBusy, authError: connection.authError, profiles: connection.profiles, history: connection.history, catalog: connection.catalog, messages },
      reset: (state: { sessions: SessionInfo[]; tabs?: string[]; activeId: string; closed: Record<string, string> }) => {
        setSessions(state.sessions); setTabs(state.tabs); setActiveId(state.activeId); setClosed(state.closed); connection.setAuthPrompt(null); messages.length = 0;
      },
      refresh: connection.refresh,
      direct: (profile: HostProfile, newTab?: boolean, targetTabId?: string) => connection.direct(profile, newTab, targetTabId),
      establish: connection.establish,
      reconnect: (id: string) => connection.reconnect(sessions.find(session => session.id === id)!),
      close: connection.close,
      cancel: connection.cancel,
      sudo: (id: string) => connection.sudo(sessions.find(session => session.id === id)!),
      submitAuth: (credentials: CredentialUpdate) => connection.submitAuth(credentials),
      save: connection.save,
      setActiveId,
      setTabs,
      setClosed,
    };
  });
  return <><output id="connections-state" data-session-count={sessions.length} data-active={activeId} />
    {connection.authPrompt && <ConnectionAuthDialog profile={connection.authPrompt.profile} mode={connection.authPrompt.mode} busy={connection.authBusy} error={connection.authError}
      onSubmit={connection.submitAuth} onCancel={() => void connection.cancel(connection.authPrompt?.tabId)} onClose={() => connection.setAuthPrompt(null)} />}
  </>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>);
