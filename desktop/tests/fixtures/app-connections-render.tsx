import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/renderer/App';
import { api, isPreview } from '../../src/renderer/api';
import type { AppEvent } from '../../src/shared/types';
import '../../src/renderer/styles.css';
import '../../src/renderer/terminal-fonts.css';

if (!isPreview) throw new Error('This App fixture requires the isolated demo API');
const initial = await api.initial();
await api.saveGroup({ id: 'development', name: '开发环境', icon: 'code', order: 0 });
await api.saveConnection({ profile: { ...initial.profiles[0], groupId: 'development', icon: 'code' }, favorite: true });
const calls: Array<{ method: string; profileId?: string; requestId?: string; decision?: string }> = [];
const eventListeners = new Set<(event: AppEvent) => void>();
let held: (() => void) | null = null;
const control = {
  calls, holdConnect: false,
  releaseConnect: () => { held?.(); held = null; },
  state: () => api.connections(),
  disconnect: (id: string) => api.disconnect(id),
  emit: (event: AppEvent) => eventListeners.forEach(handler => handler(event)),
};
const connect = api.connect;
api.connect = async request => {
  calls.push({ method: 'connect', profileId: request.profile.id });
  if (control.holdConnect) await new Promise<void>(resolve => { held = resolve; });
  return connect(request);
};
const saveConnection = api.saveConnection;
api.saveConnection = async request => { calls.push({ method: 'save', profileId: request.profile.id }); return saveConnection(request); };
const onEvent = api.onEvent;
api.onEvent = handler => { eventListeners.add(handler); const unsubscribe = onEvent(handler); return () => { eventListeners.delete(handler); unsubscribe(); }; };
api.confirmHostKey = async (requestId, decision) => { calls.push({ method: 'hostKey', requestId, decision }); };
(window as any).appConnectionsFixture = control;
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
