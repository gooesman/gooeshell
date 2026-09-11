import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api, isPreview } from './api';
import { sameConnection } from '../shared/connections';
import type { ConnectionGroup, ConnectionHistoryEntry, CredentialUpdate, HostProfile, SessionInfo } from '../shared/types';

type AuthPrompt = { profile: HostProfile; mode: 'connect' | 'sudo'; tabId?: string; sessionId?: string };
type Attempt = { id: string; cancelled: boolean; tabId?: string; profile: HostProfile };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const authenticationError = (error: unknown) => /AUTH_REQUIRED|authentication|authenticate|encrypted.*key|passphrase|私钥口令/i.test(message(error));

export default function useConnections({ sessions, setSessions, activeId, setActiveId, closed, notify, sudoSubmit }: {
  sessions: SessionInfo[]; setSessions: Dispatch<SetStateAction<SessionInfo[]>>;
  activeId: string; setActiveId: Dispatch<SetStateAction<string>>; closed: Record<string, string>;
  notify: (message: string, error?: boolean) => void; sudoSubmit: boolean;
}) {
  const [profiles, setProfiles] = useState<HostProfile[]>([]);
  const [catalog, setCatalog] = useState<HostProfile[]>([]);
  const [history, setHistory] = useState<ConnectionHistoryEntry[]>([]);
  const [groups, setGroups] = useState<ConnectionGroup[]>([]);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [reconnectErrors, setReconnectErrors] = useState<Record<string, string>>({});
  const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null);
  const [authBusy, setAuthBusy] = useState(false), [authError, setAuthError] = useState('');
  const attempts = useRef(new Map<string, Attempt>());
  const refreshGeneration = useRef(0);
  const current = useRef({ sessions, activeId, closed, catalog }); current.current = { sessions, activeId, closed, catalog };
  const refresh = async () => {
    const generation = ++refreshGeneration.current;
    const state = await api.connections();
    if (generation !== refreshGeneration.current) return;
    setProfiles(state.profiles); setCatalog(state.connections); setHistory(state.history); setGroups(state.groups);
    setSessions(previous => previous.map(session => {
      const profile = state.connections.find(value => sameConnection(value, session.profile));
      return profile ? { ...session, profile: { ...session.profile, name: profile.name, icon: profile.icon, groupId: profile.groupId } } : session;
    }));
  };
  const save = async (profile: HostProfile, favorite: boolean, credentials?: CredentialUpdate) => {
    const saved = await api.saveConnection({ profile, favorite, credentials }); await refresh(); return saved;
  };
  const establish = async (profile: HostProfile, credentials?: CredentialUpdate, tabId?: string) => {
    const key = tabId || profile.id;
    if (attempts.current.has(key)) return false;
    const attempt: Attempt = { id: crypto.randomUUID(), cancelled: false, tabId, profile };
    attempts.current.set(key, attempt); setPending(previous => ({ ...previous, [key]: true }));
    if (tabId) setReconnectErrors(previous => ({ ...previous, [tabId]: '' }));
    try {
      const connected = await api.connect({ profile, credentials, attemptId: attempt.id });
      const previous = tabId ? current.current.sessions.find(session => (session.tabId || session.id) === tabId) : undefined;
      if (attempt.cancelled || (tabId && !previous)) { await api.disconnect(connected.id); return false; }
      const session = { ...connected, tabId: tabId || connected.id };
      setSessions(items => tabId ? items.map(item => (item.tabId || item.id) === tabId ? session : item) : [...items, session]);
      if (!previous || current.current.activeId === previous.id) setActiveId(session.id);
      void refresh().catch(error => notify(message(error), true));
      notify(isPreview ? '已打开演示会话，没有连接真实服务器' : `已连接 ${profile.name}`);
      return true;
    } catch (error) {
      if (attempt.cancelled || /CONNECTION_CANCELLED/.test(message(error))) return false;
      if (tabId) setReconnectErrors(previous => ({ ...previous, [tabId]: message(error) }));
      throw error;
    } finally {
      if (attempts.current.get(key) === attempt) attempts.current.delete(key);
      setPending(previous => ({ ...previous, [key]: false }));
    }
  };
  const cancel = async (tabId?: string) => {
    const selected = [...attempts.current.values()].filter(attempt => tabId ? attempt.tabId === tabId : !attempt.tabId);
    for (const attempt of selected) attempt.cancelled = true;
    await Promise.all(selected.map(attempt => api.cancelConnect(attempt.id).catch(error => notify(message(error), true))));
  };
  const cancelProfile = async (profileId: string) => {
    const selected = [...attempts.current.values()].filter(attempt => attempt.profile.id === profileId);
    for (const attempt of selected) attempt.cancelled = true;
    await Promise.all(selected.map(attempt => api.cancelConnect(attempt.id)));
  };
  const showAuth = (prompt: AuthPrompt) => { setAuthError(''); setAuthPrompt(prompt); };
  const direct = async (supplied: HostProfile, newTab = false) => {
    const profile = catalog.find(value => value.id === supplied.id) || supplied;
    const existing = !newTab && current.current.sessions.find(session => sameConnection(session.profile, profile) && !current.current.closed[session.id]);
    if (existing) { setActiveId(existing.id); return; }
    const offline = !newTab && current.current.sessions.find(session => sameConnection(session.profile, profile) && current.current.closed[session.id]);
    const tabId = offline ? offline.tabId || offline.id : undefined;
    if (offline) setActiveId(offline.id);
    try { await establish(profile, undefined, tabId); }
    catch (error) {
      if (authenticationError(error) && profile.auth !== 'agent') showAuth({ profile, mode: 'connect', tabId });
      else notify(message(error), true);
    }
  };
  const reconnect = async (session: SessionInfo) => {
    if (!current.current.closed[session.id]) return;
    // A changed endpoint is a new connection; the old terminal keeps its original identity.
    const configured = catalog.find(profile => profile.id === session.profile.id);
    const latest = configured && !sameConnection(configured, session.profile)
      ? { ...session.profile, id: crypto.randomUUID(), groupId: undefined }
      : configured || session.profile;
    const tabId = session.tabId || session.id;
    try { await establish(latest, undefined, tabId); }
    catch (error) {
      if (authenticationError(error) && latest.auth !== 'agent') showAuth({ profile: latest, mode: 'connect', tabId });
      else notify(message(error), true);
    }
  };
  const close = async (id: string) => {
    const target = current.current.sessions.find(session => session.id === id); if (!target) return;
    const tabId = target.tabId || target.id;
    void cancel(tabId);
    if (authPrompt?.tabId === tabId || authPrompt?.sessionId === id) setAuthPrompt(null);
    if (current.current.activeId === id) setActiveId(current.current.sessions.filter(item => (item.tabId || item.id) !== tabId).at(-1)?.id || '');
    setSessions(items => items.filter(item => (item.tabId || item.id) !== tabId));
    try { await api.disconnect(id); } catch (error) { notify(message(error), true); }
  };
  const sudoPending = useRef(false);
  const sudo = async (session: SessionInfo) => {
    if (sudoPending.current || current.current.activeId !== session.id || current.current.closed[session.id]) return;
    sudoPending.current = true;
    try { await api.sendSudoPassword({ sessionId: session.id, submit: sudoSubmit }); }
    catch (error) {
      if (/SUDO_PASSWORD_REQUIRED/.test(message(error))) showAuth({ profile: session.profile, mode: 'sudo', sessionId: session.id });
      else notify(message(error), true);
    } finally { sudoPending.current = false; }
  };
  const submitAuth = async (credentials: CredentialUpdate) => {
    if (!authPrompt || authBusy) return;
    const prompt = authPrompt; setAuthBusy(true); setAuthError('');
    try {
      if (prompt.mode === 'sudo') {
        const configured = current.current.catalog.find(profile => profile.id === prompt.profile.id);
        if (configured && !sameConnection(configured, prompt.profile)) throw new Error('此连接配置已更换地址或账号。请为原地址新建连接后设置密码。');
        await api.saveCredentials({ profile: prompt.profile, credentials });
        if (current.current.activeId !== prompt.sessionId || current.current.closed[prompt.sessionId!] || !current.current.sessions.some(session => session.id === prompt.sessionId)) {
          notify('密码已保存；目标终端已切换或断开，请回到该终端后再使用快捷键。');
        } else await api.sendSudoPassword({ sessionId: prompt.sessionId!, submit: sudoSubmit });
        setAuthPrompt(null);
      } else if (await establish(prompt.profile, credentials, prompt.tabId)) setAuthPrompt(null);
    } catch (error) { setAuthError(message(error)); }
    finally { setAuthBusy(false); }
  };
  return { profiles, setProfiles, catalog, setCatalog, history, setHistory, groups, setGroups, refresh, save, establish, direct, reconnect, close, cancel, cancelProfile, pending, reconnectErrors, sudo, authPrompt, setAuthPrompt, authBusy, authError, submitAuth };
}
