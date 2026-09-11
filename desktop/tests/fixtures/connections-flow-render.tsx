import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import useConnections from '../../src/renderer/useConnections';
import ConnectionAuthDialog from '../../src/renderer/ConnectionAuthDialog';
import type { CredentialUpdate, HostProfile, SessionInfo } from '../../src/shared/types';
import '../../src/renderer/styles.css';

const messages: Array<{ message: string; error?: boolean }> = [];
function Fixture() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState('');
  const [closed, setClosed] = useState<Record<string, string>>({});
  const connection = useConnections({ sessions, setSessions, activeId, setActiveId, closed, notify: (message, error) => messages.push({ message, error }), sudoSubmit: false });
  useEffect(() => {
    (window as any).connectionHarness = {
      state: { sessions, activeId, closed, pending: connection.pending, prompt: connection.authPrompt, authBusy: connection.authBusy, authError: connection.authError, profiles: connection.profiles, history: connection.history, catalog: connection.catalog, messages },
      reset: (state: { sessions: SessionInfo[]; activeId: string; closed: Record<string, string> }) => {
        setSessions(state.sessions); setActiveId(state.activeId); setClosed(state.closed); connection.setAuthPrompt(null); messages.length = 0;
      },
      refresh: connection.refresh,
      direct: (profile: HostProfile, newTab?: boolean) => connection.direct(profile, newTab),
      reconnect: (id: string) => connection.reconnect(sessions.find(session => session.id === id)!),
      close: connection.close,
      cancel: connection.cancel,
      sudo: (id: string) => connection.sudo(sessions.find(session => session.id === id)!),
      submitAuth: (credentials: CredentialUpdate) => connection.submitAuth(credentials),
      save: connection.save,
      setActiveId,
      setClosed,
    };
  });
  return <><output id="connections-state" data-session-count={sessions.length} data-active={activeId} />
    {connection.authPrompt && <ConnectionAuthDialog profile={connection.authPrompt.profile} mode={connection.authPrompt.mode} busy={connection.authBusy} error={connection.authError}
      onSubmit={connection.submitAuth} onCancel={() => void connection.cancel(connection.authPrompt?.tabId)} onClose={() => connection.setAuthPrompt(null)} />}
  </>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>);
