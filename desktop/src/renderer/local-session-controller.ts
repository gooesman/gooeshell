import type { Dispatch, SetStateAction } from 'react';
import type { CreateLocalSessionRequest, LocalSessionInfo, SessionInfo } from '../shared/types';

type Workspace = {
  sessions: SessionInfo[]; tabs: string[]; activeId: string;
  setSessions: Dispatch<SetStateAction<SessionInfo[]>>; setTabs: Dispatch<SetStateAction<string[]>>;
  setActiveId: Dispatch<SetStateAction<string>>;
};

/** Keep asynchronous process creation attached to its originating tab. */
export function createLocalSessionController(options: {
  state: () => Workspace;
  create: (request: CreateLocalSessionRequest) => Promise<LocalSessionInfo>;
  disconnect: (id: string) => Promise<void>;
  setPending: (tabId: string, pending: boolean) => void;
  setError: (tabId: string, error: string) => void;
}) {
  const attempts = new Map<string, { cancelled: boolean }>();
  const cancel = (tabId: string) => {
    const attempt = attempts.get(tabId); if (attempt) attempt.cancelled = true;
    options.setPending(tabId, false);
  };
  const open = async (request: CreateLocalSessionRequest, targetTabId?: string, previousSessionId?: string) => {
    const initial = options.state();
    const activeHome = initial.tabs.includes(initial.activeId) && !initial.sessions.some(session => (session.tabId || session.id) === initial.activeId);
    const tabId = targetTabId || (activeHome ? initial.activeId : crypto.randomUUID());
    if (attempts.has(tabId)) return false;
    if (targetTabId && !initial.tabs.includes(tabId)) return false;
    const occupied = initial.sessions.find(session => (session.tabId || session.id) === tabId);
    if (occupied && occupied.id !== previousSessionId) return false;
    if (previousSessionId && occupied?.id !== previousSessionId) return false;
    if (!initial.tabs.includes(tabId)) {
      initial.setTabs(previous => [...previous, tabId]); initial.setActiveId(tabId);
    }
    const attempt = { cancelled: false }; attempts.set(tabId, attempt);
    options.setError(tabId, ''); options.setPending(tabId, true);
    try {
      const process = await options.create(request);
      const current = options.state();
      const previous = current.sessions.find(session => (session.tabId || session.id) === tabId);
      if (attempt.cancelled || !current.tabs.includes(tabId) || (previous && previous.id !== previousSessionId) || (previousSessionId && previous?.id !== previousSessionId)) {
        await options.disconnect(process.id); return false;
      }
      const session = { ...process, tabId };
      current.setSessions(items => previous ? items.map(item => item.id === previous.id ? session : item) : [...items, session]);
      current.setActiveId(selected => selected === (previousSessionId || tabId) ? session.id : selected);
      return true;
    } catch (cause) {
      if (!attempt.cancelled && options.state().tabs.includes(tabId)) options.setError(tabId, cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      if (attempts.get(tabId) === attempt) attempts.delete(tabId);
      options.setPending(tabId, false);
    }
  };
  return { open, cancel };
}
