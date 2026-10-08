import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from './api';
import type { CreateLocalSessionRequest, LocalSessionInfo, SessionInfo } from '../shared/types';
import { createLocalSessionController } from './local-session-controller';

export default function useLocalSessions(state: {
  sessions: SessionInfo[]; setSessions: Dispatch<SetStateAction<SessionInfo[]>>;
  tabs: string[]; setTabs: Dispatch<SetStateAction<string[]>>;
  activeId: string; setActiveId: Dispatch<SetStateAction<string>>;
  closed: Record<string, string>;
}) {
  const current = useRef(state); current.current = state;
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const controller = useRef<ReturnType<typeof createLocalSessionController> | null>(null);
  if (!controller.current) controller.current = createLocalSessionController({
    state: () => ({ ...current.current,
      // A preview or IPC reply can resolve before React has committed the new tab.
      setTabs: update => {
        const next = typeof update === 'function' ? update(current.current.tabs) : update;
        current.current.tabs = next; current.current.setTabs(next);
      },
      setSessions: update => {
        const next = typeof update === 'function' ? update(current.current.sessions) : update;
        current.current.sessions = next; current.current.setSessions(next);
      },
      setActiveId: update => {
        const next = typeof update === 'function' ? update(current.current.activeId) : update;
        current.current.activeId = next; current.current.setActiveId(next);
      },
    }),
    create: request => api.createLocalSession(request), disconnect: id => api.disconnect(id),
    setPending: (id, value) => setPending(previous => ({ ...previous, [id]: value })),
    setError: (id, value) => setErrors(previous => ({ ...previous, [id]: value })),
  });
  return {
    pending, errors,
    open: (request: CreateLocalSessionRequest, tabId?: string) => controller.current!.open(request, tabId),
    reopen: (session: LocalSessionInfo) => state.closed[session.id] ? controller.current!.open({ shell: session.shell, cwd: session.cwd }, session.tabId || session.id, session.id) : Promise.resolve(false),
    cancel: (tabId: string) => controller.current!.cancel(tabId),
  };
}
