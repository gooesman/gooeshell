import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ShieldCheck, X } from 'lucide-react';
import type { ConnectionGroup, CredentialUpdate, HostKeyPreference, HostProfile, JumpHostProfile } from '../shared/types';
import { connectionIdentity } from '../shared/connections';
import { api } from './api';
import { ConnectionIcon, connectionIcons } from './ConnectionSidebar';
import './connection-manager.css';

export interface ConnectionDialogProps {
  profile?: HostProfile;
  saved: boolean;
  groups: ConnectionGroup[];
  hostKeyPreferences: HostKeyPreference[];
  busy: boolean;
  error: string;
  onSave: (profile: HostProfile, favorite: boolean, credentials?: CredentialUpdate) => Promise<void>;
  onConnect: (profile: HostProfile, credentials: CredentialUpdate, favorite: boolean) => Promise<void>;
  onCancelConnect?: () => void;
  onClose: () => void;
}

function normalizedHost(value: string) { return value.trim().replace(/^\[|\]$/g, '').toLowerCase(); }
function sameIdentity(a: HostProfile | JumpHostProfile, b: HostProfile | JumpHostProfile) {
  return normalizedHost(a.host) === normalizedHost(b.host) && a.port === b.port && a.username.trim() === b.username.trim() && a.auth === b.auth && (a.privateKeyPath || '') === (b.privateKeyPath || '');
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

export default function ConnectionDialog({ profile, saved, groups, hostKeyPreferences, busy, error, onSave, onConnect, onCancelConnect, onClose }: ConnectionDialogProps) {
  const [draft, setDraft] = useState<HostProfile>(() => profile ? { ...profile } : { id: crypto.randomUUID(), name: '', host: '', port: 22, username: 'root', auth: 'password', rememberHost: true, encoding: 'utf8', icon: 'server' });
  const [favorite, setFavorite] = useState(saved);
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [sudoPassword, setSudoPassword] = useState('');
  const [sudoUsesLogin, setSudoUsesLogin] = useState(true);
  const [remember, setRemember] = useState<CredentialUpdate['remember']>('session');
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.credentialStatus>> | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [localError, setLocalError] = useState('');
  const [localBusy, setLocalBusy] = useState(false);
  const [forgotten, setForgotten] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(!!profile?.jumpHost);
  const [jumpPresets, setJumpPresets] = useState<JumpHostProfile[]>([]);
  const [jumpPassword, setJumpPassword] = useState('');
  const [jumpPassphrase, setJumpPassphrase] = useState('');
  const [jumpRemember, setJumpRemember] = useState<CredentialUpdate['remember']>('session');
  const [jumpIdentityChanged, setJumpIdentityChanged] = useState(false);
  const jumpRememberTouched = useRef(false);
  const cachedJump = useRef<JumpHostProfile | undefined>(profile?.jumpHost);
  const rememberTouched = useRef(false);
  const sudoPreferenceTouched = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const blocked = busy || localBusy;
  const closeRef = useRef(() => { if (!blocked) onClose(); });
  closeRef.current = () => { if (!blocked) onClose(); };
  const identityChanged = !!profile && connectionIdentity(profile) !== connectionIdentity(draft);
  const automaticHostKey = hostKeyPreferences.some(preference => preference.skipVerification && normalizedHost(preference.host) === normalizedHost(draft.host) && preference.port === draft.port);
  const change = <K extends keyof HostProfile>(key: K, value: HostProfile[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const jump = draft.jumpHost;
  const automaticJumpHostKey = !!jump && hostKeyPreferences.some(preference => preference.skipVerification && normalizedHost(preference.host) === normalizedHost(jump.host) && preference.port === jump.port);
  const resetJumpSecrets = () => { setJumpPassword(''); setJumpPassphrase(''); setJumpRemember('session'); jumpRememberTouched.current = false; };
  const selectJump = (value?: JumpHostProfile) => {
    resetJumpSecrets(); setJumpIdentityChanged(false);
    change('jumpHost', value ? { ...value } : { id: crypto.randomUUID(), name: '', host: '', port: 22, username: 'root', auth: 'password', rememberHost: true, reuseConnection: true });
  };
  const changeJump = <K extends keyof JumpHostProfile>(key: K, value: JumpHostProfile[K]) => {
    if (!jump) return;
    const next = { ...jump, [key]: value };
    if (!sameIdentity(jump, next)) {
      next.id = crypto.randomUUID(); resetJumpSecrets(); setJumpIdentityChanged(true);
    }
    change('jumpHost', next);
  };

  useEffect(() => {
    let disposed = false;
    void api.connections().then(state => {
      if (disposed) return;
      const unique = new Map<string, JumpHostProfile>();
      for (const connection of state.connections) if (connection.jumpHost) unique.set(connection.jumpHost.id, connection.jumpHost);
      setJumpPresets([...unique.values()]);
    }).catch(reason => { if (!disposed) setLocalError(errorMessage(reason)); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const handle = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== dialogRef.current) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])].filter(control => control.offsetParent !== null);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', handle);
    dialogRef.current?.querySelector<HTMLInputElement>(profile ? '#host-name' : '#host-address')?.focus();
    return () => { window.removeEventListener('keydown', handle); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  useEffect(() => {
    let disposed = false;
    setStatusLoading(true);
    const timer = window.setTimeout(() => { void api.credentialStatus(draft).then(next => {
      if (disposed) return;
      setStatus(next);
      if (!rememberTouched.current) setRemember(profile && !identityChanged ? next.remember : 'session');
      if (!sudoPreferenceTouched.current) setSudoUsesLogin(next.sudoUsesLogin);
      if (!jumpRememberTouched.current) setJumpRemember(next.jump?.remember === 'never' ? 'session' : next.jump?.remember || 'session');
    }).catch(reason => { if (!disposed) { setStatus(null); setLocalError(errorMessage(reason)); } })
      .finally(() => { if (!disposed) setStatusLoading(false); }); }, 180);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [draft.id, draft.host, draft.port, draft.username, draft.auth, draft.privateKeyPath, jump?.id, jump?.host, jump?.port, jump?.username, jump?.auth, jump?.privateKeyPath]);

  const normalized = (): HostProfile => ({ ...draft, name: draft.name.trim() || draft.host.trim(), host: draft.host.trim().replace(/^\[|\]$/g, ''), username: draft.username.trim(), privateKeyPath: draft.auth === 'key' ? draft.privateKeyPath?.trim() : undefined, groupId: draft.groupId || undefined,
    jumpHost: jump ? { ...jump, name: jump.name.trim() || jump.host.trim(), host: jump.host.trim().replace(/^\[|\]$/g, ''), username: jump.username.trim(), privateKeyPath: jump.auth === 'key' ? jump.privateKeyPath?.trim() : undefined } : undefined });
  const credentials = (): CredentialUpdate => ({ remember, sudoUsesLogin, ...(password ? { password } : {}), ...(passphrase ? { passphrase } : {}), ...(sudoPassword && !sudoUsesLogin ? { sudoPassword } : {}),
    ...(jump ? { jump: { remember: jumpRemember, ...(jumpPassword && jump.auth === 'password' ? { password: jumpPassword } : {}), ...(jumpPassphrase && jump.auth === 'key' ? { passphrase: jumpPassphrase } : {}) } } : {}) });
  const valid = () => {
    if (!draft.host.trim() || !draft.username.trim()) { setLocalError('请填写服务器地址和用户名。'); return false; }
    if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) { setLocalError('端口应在 1–65535 之间。'); return false; }
    if (draft.auth === 'key' && !draft.privateKeyPath?.trim()) { setLocalError('请选择本机私钥文件。'); return false; }
    if (remember === 'persistent' && !status?.secureStorageAvailable) { setLocalError('系统加密存储暂不可用，请选择仅本次记住。'); return false; }
    if (jump) {
      if (!jump.host.trim() || !jump.username.trim()) { setLocalError('请填写跳板机地址和用户名。'); setAdvancedOpen(true); return false; }
      if (!Number.isInteger(jump.port) || jump.port < 1 || jump.port > 65535) { setLocalError('跳板机端口应在 1–65535 之间。'); return false; }
      if (jump.auth === 'key' && !jump.privateKeyPath?.trim()) { setLocalError('请选择跳板机的本机私钥文件。'); return false; }
      if (jumpRemember === 'persistent' && !status?.secureStorageAvailable) { setLocalError('系统加密存储暂不可用，请调整跳板机密码保存方式。'); return false; }
    }
    setLocalError(''); return true;
  };
  const submit = async (connect: boolean) => {
    if (blocked || statusLoading || !valid()) return;
    setLocalBusy(true);
    try {
      if (connect) await onConnect(normalized(), credentials(), favorite);
      else { await onSave(normalized(), profile ? favorite : true, credentials()); onClose(); }
    } catch (reason) { setLocalError(errorMessage(reason)); }
    finally { setLocalBusy(false); }
  };
  const forget = async () => {
    setLocalBusy(true);
    try {
      await api.forgetCredentials(draft.id);
      setStatus(await api.credentialStatus(draft));
      setForgotten(true); setPassword(''); setPassphrase(''); setSudoPassword('');
    } catch (reason) { setLocalError(errorMessage(reason)); }
    finally { setLocalBusy(false); }
  };
  const forgetJump = async () => {
    if (!jump) return;
    setLocalBusy(true);
    try {
      await api.forgetJumpCredentials(jump);
      resetJumpSecrets(); setStatus(await api.credentialStatus(draft));
    } catch (reason) { setLocalError(errorMessage(reason)); }
    finally { setLocalBusy(false); }
  };
  const hasStored = !!status && !identityChanged && (status.hasPassword || status.hasPassphrase || status.hasSudoPassword);

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <section className="modal connection-manager-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label={profile ? '连接设置' : '新建 SSH 连接'}>
      <header className="modal-header"><span className="modal-title">{profile ? '连接设置' : '新建 SSH 连接'}</span><button type="button" className="icon-button" aria-label="关闭连接设置" disabled={blocked} onClick={onClose}><X size={16} /></button></header>
      <form id="connect-form" className="modal-body connection-form" onSubmit={event => { event.preventDefault(); void submit(true); }}>
        <fieldset className="connection-fields" disabled={blocked}>
          <div className="connection-section-label">{jump ? '目标服务器' : '连接信息'}</div>
          <div className="form-grid">
            <div className="form-field full"><label htmlFor="host-name">连接名称</label><input id="host-name" value={draft.name} onChange={event => change('name', event.target.value)} placeholder="例如：开发服务器" /></div>
            <div className="form-field"><label htmlFor="host-address">服务器地址</label><input id="host-address" value={draft.host} onChange={event => change('host', event.target.value)} placeholder="192.168.1.10 / example.com" autoComplete="off" /></div>
            <div className="form-field"><label htmlFor="host-port">SSH 端口</label><input id="host-port" type="number" min={1} max={65535} value={draft.port} onChange={event => change('port', Number(event.target.value))} /></div>
            <div className="form-field"><label htmlFor="host-user">用户名</label><input id="host-user" value={draft.username} onChange={event => change('username', event.target.value)} autoComplete="off" /></div>
            <div className="form-field"><label htmlFor="host-encoding">终端编码</label><select id="host-encoding" value={draft.encoding} onChange={event => change('encoding', event.target.value as HostProfile['encoding'])}><option value="utf8">UTF-8（推荐）</option><option value="gb18030">GB18030 / GBK</option><option value="big5">Big5</option></select></div>
          </div>
          <div className="connection-section-label">身份验证</div>
          <div className="form-grid">
            <div className="form-field full"><div className="radio-group" role="group" aria-label="身份验证方式">{([['password', '密码'], ['key', '私钥文件'], ['agent', 'SSH Agent']] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={draft.auth === id} className={draft.auth === id ? 'active' : ''} onClick={() => change('auth', id)}>{label}</button>)}</div></div>
            {draft.auth === 'password' && <div className="form-field full"><label htmlFor="host-password">登录密码</label><input id="host-password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" placeholder={!identityChanged && status?.hasPassword ? '已记住 · 留空保留原密码' : '输入登录密码'} /></div>}
            {draft.auth === 'key' && <><div className="form-field full"><label htmlFor="host-key">私钥文件</label><div className="field-inline"><input id="host-key" value={draft.privateKeyPath || ''} onChange={event => change('privateKeyPath', event.target.value)} placeholder="选择本机私钥文件" /><button type="button" className="button secondary" onClick={async () => { try { const [path] = await api.chooseFiles({ title: '选择 SSH 私钥' }); if (path) change('privateKeyPath', path); } catch (reason) { setLocalError(errorMessage(reason)); } }}>浏览…</button></div></div><div className="form-field full"><label htmlFor="key-passphrase">私钥口令（可选）</label><input id="key-passphrase" type="password" value={passphrase} onChange={event => setPassphrase(event.target.value)} autoComplete="new-password" placeholder={!identityChanged && status?.hasPassphrase ? '已记住 · 留空保留原口令' : '仅加密的私钥需要'} /></div></>}
            {draft.auth === 'agent' && <p className="connection-inline-note full">使用本机正在运行的 SSH Agent 中的密钥。</p>}
            <div className="form-field full"><label htmlFor="credential-remember">密码与口令保存方式</label><select id="credential-remember" disabled={statusLoading} value={remember} onChange={event => { rememberTouched.current = true; setRemember(event.target.value as CredentialUpdate['remember']); }}><option value="never">不记住</option><option value="session">仅本次使用期间记住</option><option value="persistent" disabled={!status?.secureStorageAvailable}>长期记住 · 系统加密存储{status && !status.secureStorageAvailable ? '（不可用）' : ''}</option></select><span className="hint">{statusLoading ? '正在读取密码保存状态…' : remember === 'persistent' ? '应用重启后仍可使用，可随时清除。' : remember === 'session' ? '关闭应用后清除，断线时仍可用于重连。' : '下次连接需要重新输入。'}</span></div>
            <div className="form-field full"><label className="checkbox-row"><input type="checkbox" checked={sudoUsesLogin} onChange={event => { sudoPreferenceTouched.current = true; setSudoUsesLogin(event.target.checked); }} />sudo 密码与登录密码相同</label>{!sudoUsesLogin && <><label htmlFor="sudo-password">sudo 密码（可选）</label><input id="sudo-password" type="password" value={sudoPassword} onChange={event => setSudoPassword(event.target.value)} autoComplete="new-password" placeholder={!identityChanged && status?.hasSudoPassword ? '已记住 · 留空保留原密码' : '用于终端中的 sudo 快捷输入'} /></>}{sudoUsesLogin && draft.auth !== 'password' && <><label htmlFor="sudo-login-password">登录 / sudo 密码（可选）</label><input id="sudo-login-password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" placeholder={!identityChanged && status?.hasPassword ? '已记住 · 留空保留原密码' : '密钥登录时，可在这里填写 sudo 所需密码'} /></>}</div>
            {identityChanged && <p className="connection-inline-note full">连接地址、账号或认证方式已修改，请重新填写密码；原连接的密码不会自动用于新目标。</p>}
            {(hasStored || forgotten) && <div className="credential-status full"><ShieldCheck size={15} /><span>{forgotten && !hasStored ? '已清除记住的密码与口令' : '此连接已有记住的密码或口令'}</span>{hasStored && <button type="button" className="text-button" onClick={() => void forget()}>清除已记住的密码</button>}</div>}
          </div>
          <section className="connection-advanced">
            <button type="button" className="connection-advanced-toggle" aria-expanded={advancedOpen} aria-controls="connection-advanced-options" onClick={() => setAdvancedOpen(value => !value)}><span><strong>高级选项</strong><small>{jump ? `通过跳板机${jump.name || jump.host ? ` · ${jump.name || jump.host}` : ''}` : '跳板机与连接复用'}</small></span><ChevronDown size={16} /></button>
            {advancedOpen && <div id="connection-advanced-options" className="connection-advanced-body">
              <label className="checkbox-row"><input id="jump-enabled" type="checkbox" checked={!!jump} onChange={event => { if (event.target.checked) { if (cachedJump.current) selectJump(cachedJump.current); else selectJump(); } else { cachedJump.current = jump; change('jumpHost', undefined); resetJumpSecrets(); } }} />通过 SSH 跳板机连接</label>
              <p className="connection-inline-note">先登录跳板机，再连接上方填写的目标服务器。两台服务器分别验证账号和密码。</p>
              {jump && <div className="form-grid">
                {jumpPresets.length > 0 && <div className="form-field full"><label htmlFor="jump-preset">从已有连接复用跳板机设置</label><select id="jump-preset" value={jumpPresets.some(preset => preset.id === jump.id) ? jump.id : ''} onChange={event => selectJump(jumpPresets.find(preset => preset.id === event.target.value))}><option value="">新建跳板机设置</option>{jumpPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name || preset.host} · {preset.username}@{preset.host}:{preset.port}</option>)}</select><span className="hint">沿用该跳板机已记住的密码；修改地址、账号或认证方式后作为新跳板机保存。</span></div>}
                <div className="form-field full"><label htmlFor="jump-name">跳板机名称（可选）</label><input id="jump-name" value={jump.name} onChange={event => changeJump('name', event.target.value)} placeholder="例如：公司网关" /></div>
                <div className="form-field"><label htmlFor="jump-address">跳板机地址</label><input id="jump-address" value={jump.host} onChange={event => changeJump('host', event.target.value)} autoComplete="off" placeholder="192.168.1.1 / gateway.example.com" /></div>
                <div className="form-field"><label htmlFor="jump-port">跳板机 SSH 端口</label><input id="jump-port" type="number" min={1} max={65535} value={jump.port} onChange={event => changeJump('port', Number(event.target.value))} /></div>
                <div className="form-field full"><label htmlFor="jump-user">跳板机用户名</label><input id="jump-user" value={jump.username} onChange={event => changeJump('username', event.target.value)} autoComplete="off" /></div>
                <div className="form-field full"><label htmlFor="jump-auth">跳板机身份验证</label><select id="jump-auth" value={jump.auth} onChange={event => changeJump('auth', event.target.value as JumpHostProfile['auth'])}><option value="password">密码</option><option value="key">私钥文件</option><option value="agent">SSH Agent</option></select></div>
                {jump.auth === 'password' && <div className="form-field full"><label htmlFor="jump-password">跳板机登录密码</label><input id="jump-password" type="password" value={jumpPassword} onChange={event => setJumpPassword(event.target.value)} autoComplete="new-password" placeholder={!statusLoading && status?.jump?.hasPassword ? '已记住 · 留空保留原密码' : '输入跳板机密码'} /></div>}
                {jump.auth === 'key' && <><div className="form-field full"><label htmlFor="jump-key">跳板机私钥文件</label><div className="field-inline"><input id="jump-key" value={jump.privateKeyPath || ''} onChange={event => changeJump('privateKeyPath', event.target.value)} placeholder="选择本机私钥文件" /><button type="button" className="button secondary" onClick={async () => { try { const [path] = await api.chooseFiles({ title: '选择跳板机 SSH 私钥' }); if (path) changeJump('privateKeyPath', path); } catch (reason) { setLocalError(errorMessage(reason)); } }}>浏览…</button></div></div><div className="form-field full"><label htmlFor="jump-passphrase">跳板机私钥口令（可选）</label><input id="jump-passphrase" type="password" value={jumpPassphrase} onChange={event => setJumpPassphrase(event.target.value)} autoComplete="new-password" placeholder={!statusLoading && status?.jump?.hasPassphrase ? '已记住 · 留空保留原口令' : '仅加密的私钥需要'} /></div></>}
                {jump.auth === 'agent' && <p className="connection-inline-note full">使用本机 SSH Agent 中的密钥登录跳板机。</p>}
                <div className="form-field full"><label htmlFor="jump-remember">跳板机密码与口令保存方式</label><select id="jump-remember" disabled={statusLoading} value={jumpRemember} onChange={event => { jumpRememberTouched.current = true; setJumpRemember(event.target.value as CredentialUpdate['remember']); }}><option value="never">不记住</option><option value="session">仅本次使用期间记住</option><option value="persistent" disabled={!status?.secureStorageAvailable}>长期记住 · 系统加密存储</option></select></div>
                {jumpIdentityChanged && <p className="connection-inline-note full">跳板机地址、账号或认证方式已修改，请重新填写密码；不会更改其他连接中的跳板机设置。</p>}
                {(status?.jump?.hasPassword || status?.jump?.hasPassphrase) && !statusLoading && <div className="credential-status full"><ShieldCheck size={15} /><span>此跳板机已有记住的密码或口令</span><button type="button" className="text-button" onClick={() => void forgetJump()}>清除跳板机密码</button><span className="hint">复用此跳板机设置的连接也将需要重新输入密码。</span></div>}
                <div className="form-field full"><label className="checkbox-row"><input id="jump-reuse" type="checkbox" checked={jump.reuseConnection} onChange={event => changeJump('reuseConnection', event.target.checked)} />复用跳板机连接</label><span className="hint">多个目标可共用同一条跳板机连接；关闭一个终端不会断开其他终端，最后一个目标断开后释放连接。</span></div>
                <div className="form-field full">{!automaticJumpHostKey && <label className="checkbox-row"><input type="checkbox" checked={jump.rememberHost} onChange={event => changeJump('rememberHost', event.target.checked)} />允许保存跳板机指纹</label>}<span className="hint">{automaticJumpHostKey ? '此跳板机地址已设为自动接受指纹，直接进行账号认证。' : '首次连接单独确认跳板机指纹；关闭后仅信任本次，不读取或保存旧指纹。'}</span></div>
              </div>}
            </div>}
          </section>
          <div className="connection-section-label">侧边栏与外观</div>
          <div className="form-grid">
            <div className="form-field full"><label className="checkbox-row"><input type="checkbox" checked={favorite} onChange={event => setFavorite(event.target.checked)} />收藏到左侧侧边栏</label></div>
            <div className="form-field full"><label htmlFor="host-group">连接分组</label><select id="host-group" value={draft.groupId || ''} onChange={event => change('groupId', event.target.value || undefined)}><option value="">未分组</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></div>
            <div className="form-field full"><span className="field-label" id="host-icon-label">连接图标</span><div className="connection-icon-picker" role="group" aria-labelledby="host-icon-label">{connectionIcons.map(icon => <button type="button" key={icon.id} title={icon.name} aria-label={icon.name} aria-pressed={(draft.icon || 'server') === icon.id} className={(draft.icon || 'server') === icon.id ? 'selected' : ''} onClick={() => change('icon', icon.id)}><ConnectionIcon name={icon.id} size={18} />{(draft.icon || 'server') === icon.id && <Check size={10} className="connection-icon-check" />}</button>)}</div></div>
          </div>
          <div className="connection-section-label">服务器指纹</div>
          <div className="form-field full">{!automaticHostKey && <label className="checkbox-row"><input type="checkbox" checked={draft.rememberHost} onChange={event => change('rememberHost', event.target.checked)} />允许保存服务器指纹（首次连接仍需确认）</label>}<span className="hint">{automaticHostKey ? '此地址已设为自动接受指纹：不校验、不保存，直接进行账号认证。' : '关闭后仅信任本次设备，不读取或保存旧指纹记录。可在连接属性中设置此地址一律不保存指纹。'}</span></div>
          {(localError || error) && <div className="form-error" role="alert">{localError || error}</div>}
        </fieldset>
      </form>
      <footer className="modal-footer"><span className="footer-note">保存设置不会建立连接</span>{busy && onCancelConnect && <button type="button" className="button secondary" onClick={onCancelConnect}>取消连接</button>}<button type="button" className="button secondary" disabled={blocked || statusLoading} onClick={() => void submit(false)}>{profile ? '保存' : '保存到侧边栏'}</button><button type="submit" className="button primary" form="connect-form" disabled={blocked || statusLoading}>{blocked ? <><span className="loading-spin" />处理中…</> : profile ? '保存并连接' : '连接服务器'}</button></footer>
    </section>
  </div>;
}
