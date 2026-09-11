import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api, isPreview } from './api';
import { sameConnection } from '../shared/connections';
import type { ConnectionGroup, ConnectionHistoryEntry, CredentialUpdate, HostProfile, SessionInfo } from '../shared/types';

type AuthPrompt = { profile: HostProfile; mode: 'connect' | 'sudo'; tabId?: string; sessionId?: string };
type Attempt = { id: string; cancelled: boolean; tabId?: string; profile: HostProfile };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const authenticationError = (error: unknown) => /AUTH_REQUIRED|AUTH_FAILED|authentication|authenticate|encrypted.*key|passphrase|私钥口令/i.test(message(error));
const canPromptAuthentication = (profile: HostProfile, error: unknown) => authenticationError(error)
  && (/JUMP_AUTH_/i.test(message(error)) ? !!profile.jumpHost && profile.jumpHost.auth !== 'agent' : profile.auth !== 'agent');

export default function useConnections({ sessions, setSessions, tabs, setTabs, activeId, setActiveId, closed, notify, sudoSubmit }: {
  sessions: SessionInfo[]; setSessions: Dispatch<SetStateAction<SessionInfo[]>>;
  tabs?: string[]; setTabs?: Dispatch<SetStateAction<string[]>>;
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
  const current = useRef({ sessions, tabs, activeId, closed, catalog }); current.current = { sessions, tabs, activeId, closed, catalog };
  const hasTab = (tabId: string) => current.current.tabs
    ? current.current.tabs.includes(tabId)
    : current.current.sessions.some(session => (session.tabId || session.id) === tabId);
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
    // A home tab is a real target even though it has no SSH transport yet.
    if (tabId && !hasTab(tabId)) return false;
    const key = tabId || profile.id;
    if (attempts.current.has(key)) return false;
    const attempt: Attempt = { id: crypto.randomUUID(), cancelled: false, tabId, profile };
    attempts.current.set(key, attempt); setPending(previous => ({ ...previous, [key]: true }));
    if (tabId) setReconnectErrors(previous => ({ ...previous, [tabId]: '' }));
    try {
      const connected = await api.connect({ profile, credentials, attemptId: attempt.id });
      const previous = tabId ? current.current.sessions.find(session => (session.tabId || session.id) === tabId) : undefined;
      if (attempt.cancelled || (tabId && !hasTab(tabId))) { await api.disconnect(connected.id); return false; }
      const session = { ...connected, tabId: tabId || connected.id };
      setSessions(items => previous ? items.map(item => (item.tabId || item.id) === tabId ? session : item) : [...items, session]);
      if (!tabId) setTabs?.(items => [...items, session.tabId]);
      if (!tabId) setActiveId(session.id);
      else setActiveId(selected => selected === (previous?.id || tabId) ? session.id : selected);
      void refresh().catch(error => notify(message(error), true));
      notify(isPreview ? '已打开演示会话，没有连接真实服务器' : `已连接 ${profile.name}`);
      return true;
    } catch (error) {
      if (attempt.cancelled || (tabId && !hasTab(tabId)) || /CONNECTION_CANCELLED/.test(message(error))) return false;
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
    if (selected.length) setPending(previous => {
      const next = { ...previous };
      for (const attempt of selected) next[attempt.tabId || attempt.profile.id] = false;
      return next;
    });
    if (tabId) setAuthPrompt(prompt => prompt?.mode === 'connect' && prompt.tabId === tabId ? null : prompt);
    await Promise.all(selected.map(attempt => api.cancelConnect(attempt.id).catch(error => notify(message(error), true))));
  };
  const cancelProfile = async (profileId: string) => {
    const selected = [...attempts.current.values()].filter(attempt => attempt.profile.id === profileId);
    for (const attempt of selected) attempt.cancelled = true;
    await Promise.all(selected.map(attempt => api.cancelConnect(attempt.id)));
  };
  const showAuth = (prompt: AuthPrompt, error = '') => { setAuthError(error); setAuthPrompt(prompt); };
  const direct = async (supplied: HostProfile, newTab = false, targetTabId?: string) => {
    const profile = catalog.find(value => value.id === supplied.id) || supplied;
    const existing = !targetTabId && !newTab && current.current.sessions.find(session => sameConnection(session.profile, profile) && !current.current.closed[session.id]);
    if (existing) { setActiveId(existing.id); return; }
    const offline = !targetTabId && !newTab && current.current.sessions.find(session => sameConnection(session.profile, profile) && current.current.closed[session.id]);
    const activeHome = !newTab && current.current.tabs?.includes(current.current.activeId)
      && !current.current.sessions.some(session => (session.tabId || session.id) === current.current.activeId)
      ? current.current.activeId : undefined;
    const tabId = targetTabId || (offline ? offline.tabId || offline.id : activeHome);
    if (offline) setActiveId(offline.id);
    try { await establish(profile, undefined, tabId); }
    catch (error) {
      if (canPromptAuthentication(profile, error)) showAuth({ profile, mode: 'connect', tabId }, message(error));
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
      if (canPromptAuthentication(latest, error)) showAuth({ profile: latest, mode: 'connect', tabId }, message(error));
      else notify(message(error), true);
    }
  };
  const close = async (id: string) => {
    const target = current.current.sessions.find(session => session.id === id); if (!target) return;
    const tabId = target.tabId || target.id;
    void cancel(tabId);
    if (authPrompt?.tabId === tabId || authPrompt?.sessionId === id) setAuthPrompt(null);
    const remaining = current.current.sessions.filter(item => (item.tabId || item.id) !== tabId);
    const orderedTabs = current.current.tabs;
    if (orderedTabs) {
      const remainingTabs = orderedTabs.filter(value => value !== tabId);
      const nextTabId = remainingTabs[Math.min(orderedTabs.indexOf(tabId), remainingTabs.length - 1)];
      const nextActiveId = remaining.find(item => (item.tabId || item.id) === nextTabId)?.id || nextTabId || '';
      setActiveId(selected => selected === id ? nextActiveId : selected);
      current.current.tabs = remainingTabs;
      setTabs?.(items => items.filter(value => value !== tabId));
    } else setActiveId(selected => selected === id ? remaining.at(-1)?.id || '' : selected);
    current.current.sessions = remaining;
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
      if (prompt.mode === 'connect' && prompt.tabId && !hasTab(prompt.tabId)) { setAuthPrompt(null); return; }
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
  const hasUntargetedPending = [...attempts.current.values()].some(attempt => !attempt.tabId && !attempt.cancelled);
  return { profiles, setProfiles, catalog, setCatalog, history, setHistory, groups, setGroups, refresh, save, establish, direct, reconnect, close, cancel, cancelProfile, pending, hasUntargetedPending, reconnectErrors, sudo, authPrompt, setAuthPrompt, authBusy, authError, submitAuth };
}
