import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { connectionErrorText } from './connection-errors';

export type IdentityChoice = {
  id: string; name: string; username: string; hasPassword: boolean; version: number;
  remember: 'never' | 'session' | 'persistent';
};

export function useLoginIdentityLibrary() {
  const [identities, setIdentities] = useState<IdentityChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    if (typeof api.listLoginIdentities !== 'function') return;
    setLoading(true);
    try {
      const result = await api.listLoginIdentities();
      if (request === generation.current) { setIdentities(result.identities); setError(''); }
    } catch (cause) { if (request === generation.current) setError(connectionErrorText(cause)); }
    finally { if (request === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void reload();
    const refresh = () => { void reload(); };
    window.addEventListener('gooeshell:identities-changed', refresh);
    return () => { ++generation.current; window.removeEventListener('gooeshell:identities-changed', refresh); };
  }, [reload]);
  return { identities, loading, error, reload };
}

export default function LoginIdentitySelect({ id, value, identities, disabled, onChange, onManage, label = '登录身份' }: {
  id: string; value?: string; identities: IdentityChoice[]; disabled?: boolean;
  onChange: (identity?: IdentityChoice) => void; onManage?: () => void; label?: string;
}) {
  const selected = identities.find(identity => identity.id === value);
  return <div className="form-field full identity-select">
    <label htmlFor={id}>{label}</label>
    <div className="field-inline"><select id={id} value={value || ''} disabled={disabled} onChange={event => onChange(identities.find(identity => identity.id === event.target.value))}>
      <option value="">手动填写</option>
      {value && !selected && <option value={value} disabled>身份暂不可用，请重新选择</option>}
      {identities.map(identity => <option key={identity.id} value={identity.id}>{identity.name} · {identity.username}</option>)}
    </select>{onManage && <button type="button" className="button secondary" disabled={disabled} onClick={onManage}>管理身份</button>}</div>
    {selected && <p className="connection-inline-note">{selected.hasPassword ? '已保存密码' : '需要填写密码'} · {selected.remember === 'persistent' ? '系统加密长期保存' : selected.remember === 'session' ? '本次使用期间记住' : '不记住密码'}。身份修改对关联连接的下次登录生效。</p>}
  </div>;
}
