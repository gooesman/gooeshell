import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api } from './api';
import type { CredentialRemember, CredentialStatus, CredentialUpdate, HostProfile } from '../shared/types';
import './connection-manager.css';

export default function ConnectionAuthDialog({ profile, mode, busy, error, onSubmit, onClose, onCancel }: {
  profile: HostProfile; mode: 'connect' | 'sudo'; busy: boolean; error: string;
  onSubmit: (credentials: CredentialUpdate) => Promise<void>; onClose: () => void; onCancel: () => void;
}) {
  const [secret, setSecret] = useState('');
  const [jumpSecret, setJumpSecret] = useState('');
  const [remember, setRemember] = useState<CredentialRemember>('session');
  const [jumpRemember, setJumpRemember] = useState<CredentialRemember>('session');
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const rememberTouched = useRef(false);
  const jumpRememberTouched = useRef(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    api.credentialStatus(profile).then(value => { if (!cancelled) { setStatus(value); if (!rememberTouched.current) setRemember(value.remember === 'never' ? 'session' : value.remember); if (!jumpRememberTouched.current) setJumpRemember(value.jump?.remember === 'persistent' ? 'persistent' : 'session'); } }).catch(cause => { if (!cancelled) setStatusError(String(cause)); });
    return () => { cancelled = true; };
  }, [profile]);
  const sudo = mode === 'sudo';
  const jump = sudo ? undefined : profile.jumpHost;
  const targetSecret = sudo || profile.auth !== 'agent';
  const title = sudo ? '填写此连接的 sudo 密码' : '身份验证';
  return <div className="modal-backdrop"><section ref={dialog} className="modal compact connection-auth-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') { const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') || [])]; const first = controls[0], last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}>
    <header className="modal-header"><span className="modal-title">{title}</span><button className="icon-button" type="button" aria-label="取消身份验证" disabled={busy} onClick={onClose}><X size={16}/></button></header>
    <form onSubmit={async event => {
      event.preventDefault();
      const update: CredentialUpdate = { remember, sudoUsesLogin: sudo ? false : status?.sudoUsesLogin ?? true,
        ...(sudo ? { sudoPassword: secret } : secret && profile.auth === 'password' ? { password: secret } : secret && profile.auth === 'key' ? { passphrase: secret } : {}),
        ...(jump ? { jump: { remember: jumpRemember, ...(jumpSecret && jump.auth === 'password' ? { password: jumpSecret } : jumpSecret && jump.auth === 'key' ? { passphrase: jumpSecret } : {}) } } : {}) };
      await onSubmit(update);
    }}>
      <div className="modal-body"><section className="connection-auth-section">{jump && <div className="connection-section-label">目标服务器</div>}<div className="property-endpoint"><strong>{profile.name}</strong><span>{profile.username}@{profile.host}:{profile.port}</span></div>
        {targetSecret ? <><div className="form-field"><label htmlFor="connection-auth-secret">{sudo ? 'sudo 密码' : profile.auth === 'password' ? '登录密码' : '私钥口令'}</label><input id="connection-auth-secret" autoFocus type="password" value={secret} disabled={busy} onChange={event => setSecret(event.target.value)} autoComplete="off" placeholder={!sudo && (profile.auth === 'password' ? status?.hasPassword : status?.hasPassphrase) ? '已记住 · 留空保留' : ''}/></div>
        <div className="form-field"><label htmlFor="connection-auth-remember">记住密码</label><select id="connection-auth-remember" value={remember} disabled={busy} onChange={event => { rememberTouched.current = true; setRemember(event.target.value as CredentialRemember); }}>{!sudo && <option value="never">不记住</option>}<option value="session">本次使用期间</option><option value="persistent" disabled={!status?.secureStorageAvailable}>长期记住 · 系统加密</option></select></div></> : <p className="connection-inline-note">目标服务器使用 SSH Agent 中的密钥验证。</p>}</section>
        {jump && <section className="connection-auth-section"><div className="connection-section-label">跳板机</div><div className="property-endpoint"><strong>{jump.name || jump.host}</strong><span>{jump.username}@{jump.host}:{jump.port}</span></div>{jump.auth === 'agent' ? <p className="connection-inline-note">跳板机使用 SSH Agent 中的密钥验证。</p> : <><div className="form-field"><label htmlFor="connection-auth-jump-secret">{jump.auth === 'password' ? '跳板机登录密码' : '跳板机私钥口令'}</label><input id="connection-auth-jump-secret" autoFocus={!targetSecret} type="password" value={jumpSecret} disabled={busy} onChange={event => setJumpSecret(event.target.value)} autoComplete="off" placeholder={(jump.auth === 'password' ? status?.jump?.hasPassword : status?.jump?.hasPassphrase) ? '已记住 · 留空保留' : ''} /></div><div className="form-field"><label htmlFor="connection-auth-jump-remember">记住跳板机密码</label><select id="connection-auth-jump-remember" value={jumpRemember} disabled={busy} onChange={event => { jumpRememberTouched.current = true; setJumpRemember(event.target.value as CredentialRemember); }}><option value="never">不记住</option><option value="session">本次使用期间</option><option value="persistent" disabled={!status?.secureStorageAvailable}>长期记住 · 系统加密</option></select></div></>}</section>}
        {sudo && <p className="settings-description" style={{marginTop:12}}>确认当前终端正在等待 sudo 密码后再填入。密码仅发送到这个连接。</p>}
        {(error || statusError) && <div className="form-error" role="alert">{error || statusError}</div>}
      </div><footer className="modal-footer"><button type="button" className="button secondary" disabled={busy && sudo} onClick={busy ? onCancel : onClose}>{busy ? '取消连接' : '取消'}</button><button type="submit" className="button primary" disabled={busy || !status}>{busy ? '正在处理…' : sudo ? '填入终端' : '连接'}</button></footer>
    </form>
  </section></div>;
}
