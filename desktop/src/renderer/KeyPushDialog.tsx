import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api } from './api';
import { connectionErrorText } from './connection-errors';
import type { CredentialUpdate, HostProfile } from '../shared/types';
import './key-push.css';

type KeyInfo = Awaited<ReturnType<typeof api.prepareSshKey>>;
type PushResult = Awaited<ReturnType<typeof api.pushSshKey>>;
export default function KeyPushDialog({ profile, credentials, onClose, onApplied }: {
  profile: HostProfile; credentials: CredentialUpdate; onClose: () => void;
  onApplied: (profile: HostProfile) => Promise<void>;
}) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [path, setPath] = useState(profile.privateKeyPath || '');
  const [name, setName] = useState('gooeshell');
  const [passphrase, setPassphrase] = useState('');
  const [key, setKey] = useState<KeyInfo | null>(null);
  const [result, setResult] = useState<PushResult | null>(null);
  const [auth, setAuth] = useState<CredentialUpdate>({ ...credentials, updateSharedIdentity: false, jump: credentials.jump ? { ...credentials.jump, updateSharedIdentity: false } : undefined });
  const [authOpen, setAuthOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const attempt = useRef<string | null>(null);
  const alive = useRef(true);
  const dialog = useRef<HTMLElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => { if (result || error) feedback.current?.scrollIntoView({ block: 'nearest' }); }, [result, error]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    alive.current = true;
    return () => { alive.current = false; if (attempt.current) void api.cancelSshKeyPush(attempt.current).catch(() => {}); if (previous?.isConnected) previous.focus(); };
  }, []);
  const changed = () => { setKey(null); setResult(null); setError(''); };
  const prepare = async () => {
    if (busy) return;
    setBusy(mode === 'new' ? '正在生成密钥…' : '正在读取密钥…'); setError(''); setResult(null);
    try {
      const value = mode === 'new' ? await api.generateSshKey({ name: name.trim(), passphrase }) : await api.prepareSshKey({ path: path.trim(), passphrase });
      if (alive.current) { setKey(value); setPassphrase(''); }
    } catch (cause) { if (alive.current) setError(connectionErrorText(cause)); }
    finally { if (alive.current) setBusy(''); }
  };
  const push = async () => {
    if (busy || !key) return;
    const id = crypto.randomUUID(); attempt.current = id;
    setBusy('正在安装公钥并验证登录…'); setError(''); setResult(null);
    try {
      const value = await api.pushSshKey({ profile, credentials: auth, keyId: key.keyId, attemptId: id });
      if (alive.current && attempt.current === id) setResult(value);
    } catch (cause) {
      if (alive.current && attempt.current === id) { setError(connectionErrorText(cause)); if (/AUTH_REQUIRED|AUTH_FAILED|authentication|authenticate|passphrase|口令/i.test(String(cause))) setAuthOpen(true); }
    } finally { if (attempt.current === id) attempt.current = null; if (alive.current) { setBusy(''); setCancelling(false); } }
  };
  const cancel = async () => {
    if (!busy) { onClose(); return; }
    if (!attempt.current || cancelling) return;
    setCancelling(true);
    try { await api.cancelSshKeyPush(attempt.current); }
    catch (cause) { if (alive.current) { setError(connectionErrorText(cause)); setCancelling(false); } }
  };
  const apply = async () => {
    if (busy || !result?.verified || !result.verificationId) return;
    setBusy('正在保存连接设置…'); setError('');
    try { await onApplied(await api.applyVerifiedSshKey({ verificationId: result.verificationId })); onClose(); }
    catch (cause) { if (alive.current) setError(connectionErrorText(cause)); }
    finally { if (alive.current) setBusy(''); }
  };
  return <div className="modal-backdrop"><section ref={dialog} className="modal key-push-dialog" role="dialog" aria-modal="true" aria-label="推送 SSH 公钥" onKeyDown={event => {
    const all = document.querySelectorAll('[role="dialog"]'); if (all[all.length - 1] !== dialog.current) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }
    if (event.key === 'Tab') {
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary') || [])].filter(item => item.offsetParent !== null);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header className="modal-header"><span className="modal-title">推送 SSH 公钥</span><button type="button" className="icon-button" aria-label="关闭公钥推送" disabled={!!busy} onClick={onClose}><X size={16}/></button></header>
    <div className="modal-body">
      <div className="property-endpoint"><strong>{profile.name}</strong><span>{profile.username}@{profile.host}:{profile.port}</span>{profile.jumpHost && <span>经由 {profile.jumpHost.name || profile.jumpHost.host}，安装到目标服务器</span>}</div>
      <p className="connection-inline-note">公钥用于授权这台电脑登录，私钥保存在本机。远端需为 Linux / OpenSSH，并已安装 Python 3。</p>
      <p className="connection-inline-note">验证后可单独切换此连接。私钥口令沿用此连接的保存方式；尚未设置时仅在本次使用期间记住。</p>
      <fieldset className="connection-fields" disabled={!!busy}>
        <div className="radio-group key-source" role="group" aria-label="密钥来源"><button type="button" aria-pressed={mode === 'existing'} className={mode === 'existing' ? 'active' : ''} onClick={() => { setMode('existing'); changed(); }}>选择已有密钥</button><button type="button" aria-pressed={mode === 'new'} className={mode === 'new' ? 'active' : ''} onClick={() => { setMode('new'); changed(); }}>生成新密钥</button></div>
        {mode === 'existing' ? <div className="form-field"><label htmlFor="key-source-path">私钥或公钥文件</label><div className="field-inline"><input id="key-source-path" value={path} onChange={event => { setPath(event.target.value); changed(); }}/><button type="button" className="button secondary" onClick={async () => { try { const [selected] = await api.chooseFiles({ title: '选择 SSH 私钥或公钥文件' }); if (selected) { setPath(selected); changed(); } } catch (cause) { setError(connectionErrorText(cause)); } }}>选择文件…</button></div></div>
          : <div className="form-field"><label htmlFor="key-new-name">密钥名称</label><input id="key-new-name" value={name} onChange={event => { setName(event.target.value); changed(); }}/><p className="connection-inline-note">生成独立的新密钥文件，完成后显示保存位置。</p></div>}
        <div className="form-field"><label htmlFor="key-passphrase-input">私钥口令（可选）</label><input id="key-passphrase-input" type="password" autoComplete="new-password" value={passphrase} onChange={event => { setPassphrase(event.target.value); changed(); }}/></div>
        <button type="button" className="button secondary" disabled={mode === 'new' ? !name.trim() : !path.trim()} onClick={() => void prepare()}>{mode === 'new' ? '生成密钥' : '读取密钥'}</button>
      </fieldset>
      {key && <section className="key-summary"><strong>{key.name}</strong><span className="key-fingerprint">{key.fingerprint}</span>{key.privateKeyPath ? <span className="dialog-path">私钥：{key.privateKeyPath}</span> : <p className="connection-inline-note">当前只有公钥，可以安装；验证登录需要对应私钥。</p>}</section>}
      <details className="key-auth" open={authOpen} onToggle={event => setAuthOpen(event.currentTarget.open)}><summary>本次连接凭据</summary><p className="connection-inline-note">优先使用此连接已记住的凭据，也可在这里填写本次操作所需的密码。</p>
        {profile.auth !== 'agent' && <div className="form-field"><label htmlFor="key-login-secret">{profile.auth === 'password' ? '目标服务器登录密码' : '当前登录私钥的口令'}</label><input id="key-login-secret" type="password" disabled={!!busy} autoComplete="off" value={(profile.auth === 'password' ? auth.password : auth.passphrase) || ''} onChange={event => { setError(''); setAuth(previous => ({...previous, [profile.auth === 'password' ? 'password' : 'passphrase']:event.target.value})); }}/></div>}
        {profile.jumpHost && profile.jumpHost.auth !== 'agent' && <div className="form-field"><label htmlFor="key-jump-secret">{profile.jumpHost.auth === 'password' ? '跳板机登录密码' : '跳板机私钥口令'}</label><input id="key-jump-secret" type="password" disabled={!!busy} autoComplete="off" value={(profile.jumpHost.auth === 'password' ? auth.jump?.password : auth.jump?.passphrase) || ''} onChange={event => { setError(''); setAuth(previous => ({...previous, jump:{...previous.jump, remember:previous.jump?.remember || 'session', [profile.jumpHost!.auth === 'password' ? 'password' : 'passphrase']:event.target.value}})); }}/></div>}
      </details>
      <div ref={feedback}>{result && <section className="key-push-result" role="status"><p>{result.alreadyPresent ? '服务器已有此公钥，已保留原授权设置。' : '公钥已安装。'}</p><p>{result.verified ? '密钥登录验证通过，可以将此连接改为密钥登录。' : result.verificationError || '尚未验证密钥登录。'}</p></section>}
      {error && <div className="form-error" role="alert">{error}</div>}
      </div>
      {busy && <p className="connection-inline-note" role="status">{cancelling ? '正在停止…' : busy}</p>}
    </div>
    <footer className="modal-footer"><button type="button" className="button secondary" disabled={!!busy && (!attempt.current || cancelling)} onClick={() => void cancel()}>{busy ? '停止操作' : '关闭'}</button>{result?.verified && <button type="button" className="button primary" disabled={!!busy} onClick={() => void apply()}>此连接改用密钥登录</button>}<button type="button" className="button primary" disabled={!!busy || !key} onClick={() => void push()}>{key?.privateKeyPath ? '推送并验证' : '推送公钥'}</button></footer>
  </section></div>;
}
