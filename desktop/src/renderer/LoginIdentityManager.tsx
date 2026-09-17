import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Plus, Search } from 'lucide-react';
import { api } from './api';
import { connectionErrorText } from './connection-errors';
import './login-identities.css';

type Identity = Awaited<ReturnType<typeof api.listLoginIdentities>>['identities'][number];
type Draft = { id?: string; version?: number; name: string; username: string; password: string; remember: 'session' | 'persistent' };
const emptyDraft = (): Draft => ({ name: '', username: '', password: '', remember: 'session' });

export default function LoginIdentityManager({ onChange, onBusyChange }: { onChange?: () => Promise<void> | void; onBusyChange?: (busy: boolean) => void }) {
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [secureStorage, setSecureStorage] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const mounted = useRef(true);
  const operation = useRef(false);
  const generation = useRef(0);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);

  const refresh = async () => {
    const request = ++generation.current;
    const result = await api.listLoginIdentities();
    if (mounted.current && request === generation.current) {
      setIdentities(result.identities);
      setSecureStorage(result.secureStorageAvailable);
    }
    return result;
  };
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(cause => { if (mounted.current) setError(connectionErrorText(cause)); })
      .finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; ++generation.current; };
  }, []);

  const selected = identities.find(identity => identity.id === draft?.id);
  const references = selected?.references || [];
  const update = (partial: Partial<Draft>) => { setDraft(previous => previous && { ...previous, ...partial }); setError(''); setMessage(''); setDeleting(false); };
  const edit = (identity?: Identity) => {
    setDraft(identity ? { id: identity.id, version: identity.version, name: identity.name, username: identity.username, password: '', remember: identity.remember === 'persistent' ? 'persistent' : 'session' } : emptyDraft());
    setError(''); setMessage(''); setDeleting(false);
  };
  const changed = async () => { await refresh(); await onChange?.(); };
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || operation.current) return;
    operation.current = true; setBusy(true); setError(''); setMessage('');
    try {
      await api.saveLoginIdentity({ ...(draft.id ? { id: draft.id, expectedVersion: draft.version } : {}), name: draft.name.trim(), username: draft.username.trim(), remember: draft.remember, ...(draft.password ? { password: draft.password } : {}) });
      setDraft(null);
      await changed();
      if (mounted.current) setMessage('身份已保存，关联连接下次登录时使用新信息。');
    } catch (cause) { if (mounted.current) setError(connectionErrorText(cause)); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };
  const remove = async () => {
    if (!selected || references.length || operation.current) return;
    operation.current = true; setBusy(true); setError('');
    try {
      await api.deleteLoginIdentity(selected.id);
      setDraft(null); setDeleting(false);
      await changed();
      if (mounted.current) setMessage('登录身份已删除。');
    } catch (cause) { if (mounted.current) { setError(connectionErrorText(cause)); void refresh().catch(() => {}); } }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };

  return <section className="login-identities" aria-label="登录身份管理">
    <div className="identity-heading"><div><h3>登录身份</h3><p className="settings-description">保存常用 SSH 账号，让多个连接共用同一身份。</p></div>{!draft && <button type="button" className="button small secondary" disabled={loading || busy} onClick={() => edit()}><Plus size={14} />新建身份</button>}</div>
    {draft ? <form className="identity-form" onSubmit={save}>
      <div className="identity-edit-heading"><button type="button" className="text-button" disabled={busy} onClick={() => { setDraft(null); setError(''); setDeleting(false); }}><ChevronLeft size={14} />返回列表</button><span>{draft.id ? '编辑身份' : '新建身份'}</span></div>
      <fieldset disabled={busy}>
        <div className="form-field"><label htmlFor="login-identity-name">身份名称</label><input id="login-identity-name" value={draft.name} required maxLength={120} placeholder="例如：公司开发账号" onChange={event => update({ name: event.target.value })} autoFocus /></div>
        <div className="form-field"><label htmlFor="login-identity-username">SSH 用户名</label><input id="login-identity-username" value={draft.username} required maxLength={256} spellCheck={false} autoCapitalize="none" autoComplete="off" placeholder="例如：developer" onChange={event => update({ username: event.target.value })} /></div>
        <div className="form-field"><label htmlFor="login-identity-password">登录密码</label><input id="login-identity-password" type="password" value={draft.password} required={!selected?.hasPassword} autoComplete="new-password" placeholder={selected?.hasPassword ? '已保存密码 · 留空保留' : '输入登录密码'} onChange={event => update({ password: event.target.value })} />{selected?.hasPassword && <p className="identity-help">密码不会显示在这里，留空可保留原密码。</p>}</div>
        <div className="form-field"><label htmlFor="login-identity-remember">密码保存方式</label><select id="login-identity-remember" value={draft.remember} onChange={event => update({ remember: event.target.value as Draft['remember'] })}><option value="session">本次使用期间记住</option><option value="persistent" disabled={!secureStorage}>长期记住 · 系统加密{!secureStorage ? '（当前不可用）' : ''}</option></select><p className="identity-help">{draft.remember === 'persistent' ? '使用系统加密保存，重启后可继续使用。' : '身份名称和账号会保留；退出或重启应用后需重新填写密码。'}</p></div>
        {selected && <section className="identity-references" aria-label="关联服务器"><h4>关联服务器 <span>{references.length}</span></h4>{references.length ? <><ul>{references.map((reference, index) => <li key={`${reference.connectionId}:${reference.role}:${index}`}><strong>{reference.name}</strong><span>{reference.host}:{reference.port}{reference.role === 'jump' ? ' · 跳板机' : ''}</span></li>)}</ul><p className="identity-help">修改后仅影响下次登录，已连接的终端保持当前身份。要删除此身份，请先在这些服务器的“连接设置”中更换身份或改为手动填写。</p></> : <p className="identity-help">还没有连接使用此身份。</p>}</section>}
        {deleting && <div className="identity-delete-confirm" role="alert"><p>删除“{selected?.name}”及其保存的密码？</p><div><button type="button" className="button small secondary" onClick={() => setDeleting(false)}>取消</button><button type="button" className="button small primary" onClick={() => void remove()}>确认删除</button></div></div>}
        <div className="identity-form-actions">{selected && <button type="button" className="text-button" disabled={!!references.length} title={references.length ? '请先在关联连接中解除此身份' : '删除此身份'} onClick={() => { setDeleting(true); setError(''); }}>删除身份</button>}<span /><button className="button secondary" type="button" onClick={() => { setDraft(null); setError(''); setDeleting(false); }}>取消编辑</button><button className="button primary" type="submit">{busy ? '正在保存…' : '保存身份'}</button></div>
      </fieldset>
      <p className="identity-help">登录身份在此单独保存。</p>
    </form> : <>
      <div className="identity-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="搜索登录身份" placeholder="搜索名称或用户名" value={query} onChange={event => setQuery(event.target.value)} /></div>
      {loading ? <p className="identity-empty" role="status">正在加载身份…</p> : <div className="identity-list" aria-label="已保存的登录身份">{identities.filter(identity => `${identity.name}\n${identity.username}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(identity => <button type="button" className="identity-list-item" key={identity.id} onClick={() => edit(identity)}><span><strong>{identity.name}</strong><span className="identity-user">{identity.username}</span></span><span className="identity-summary"><span>{identity.references?.length || 0} 个关联</span><span>{!identity.hasPassword ? '待填写密码' : identity.remember === 'persistent' ? '系统加密保存' : '本次记住'}</span></span></button>)}{!identities.length && <p className="identity-empty">还没有登录身份。新建后可在连接的“身份验证”中选择。</p>}{identities.length > 0 && !identities.some(identity => `${identity.name}\n${identity.username}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) && <p className="identity-empty">没有匹配的登录身份。</p>}</div>}
    </>}
    {error && <div className="form-error" role="alert">{error}</div>}
    {message && <p className="identity-save-message" role="status">{message}</p>}
  </section>;
}
