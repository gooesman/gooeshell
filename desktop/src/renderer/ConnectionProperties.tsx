import { useState } from 'react';
import type { HostProfile } from '../shared/types';

export default function ConnectionProperties({profile, skipVerification, onSave, onClose}: {
  profile: HostProfile; skipVerification: boolean;
  onSave: (skip: boolean) => Promise<void>; onClose: () => void;
}) {
  const [skip, setSkip] = useState(skipVerification);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <form className="connection-properties" onSubmit={async event => {
    event.preventDefault(); setBusy(true);
    try { await onSave(skip); onClose(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }}>
    <div className="modal-body">
      <div className="property-endpoint"><strong>{profile.name}</strong><span>{profile.host}:{profile.port}</span></div>
      <label className="property-choice"><input type="checkbox" checked={skip} onChange={event => setSkip(event.target.checked)} /><span><strong>自动接受服务器指纹</strong><span>不校验、不保存，也不弹出指纹确认。</span></span></label>
      <p className="settings-description">仅对 {profile.host}:{profile.port} 生效，包括此地址的快速连接和历史连接。适合同一 IP 轮换多台设备，账号密码或私钥认证仍需通过。</p>
      {skip && <p className="form-note">开启后无法识别冒用此地址的服务器。请仅对你确认可信的设备网络使用。</p>}
      <p className="settings-description">对下一次连接生效；关闭后恢复常规指纹校验。</p>
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
    <div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={busy}>保存属性</button></div>
  </form>;
}
