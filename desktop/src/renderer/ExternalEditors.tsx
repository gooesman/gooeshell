import { useState } from 'react';
import type { AppSettings, ExternalEdit, ExternalEditAction, ExternalEditComparison } from '../shared/types';
import { api } from './api';
import CodeEditor from './CodeEditor';
import './external-editors.css';

export default function ExternalEditors({ edits, settings, configure }: { edits: ExternalEdit[]; settings: AppSettings; configure: () => void }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [comparison, setComparison] = useState<{ id: string; files: ExternalEditComparison } | null>(null);
  const [confirm, setConfirm] = useState<ExternalEditAction | null>(null);
  const run = async (action: () => Promise<unknown>, id: string) => {
    setBusy(id); setError('');
    try { await action(); } catch (error) { setError(String(error).replace(/^Error(?: invoking remote method '[^']+': Error)?:\s*/, '')); }
    finally { setBusy(''); }
  };
  const perform = (request: ExternalEditAction) => void run(async () => { await api.externalEditAction(request); setConfirm(null); setComparison(null); }, request.id);
  const selected = edits.find(item => item.id === comparison?.id);
  const stateLabels = { watching: '监测保存', uploading: '正在回传', conflict: '文件冲突', error: '回传已暂停', paused: '已暂停' };
  return <div className="modal-body external-editors">
    <div className="external-editors-intro"><p>在外部编辑器保存后自动回传。退出 GooeShell 后停止回传，本地草稿保留。</p><button className="text-button" onClick={configure} disabled={!!busy}>选择编辑器…</button></div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {edits.length === 0 && <p className="settings-description">在文件右键菜单选择“用外部编辑器打开”。本地文件直接打开；远程文件会在这里显示回传状态。</p>}
    <div className="external-edit-list">{edits.map(edit => <article key={edit.id} className="external-edit-item" data-external-edit={edit.id}>
      <div className="external-edit-title"><strong>{edit.name}</strong><span>{stateLabels[edit.state]}</span></div>
      <div className="external-edit-location">{edit.connectionName} · {edit.path}</div>
      <p role="status">{edit.message}</p>
      <div className="external-edit-actions">
        <button className="button small secondary" disabled={!!busy} onClick={() => perform({ id: edit.id, action: 'open' })}>重新打开</button>
        <button className="button small secondary" disabled={!!busy} onClick={() => perform({ id: edit.id, action: 'reveal' })}>本地草稿</button>
        {edit.state !== 'watching' && edit.state !== 'uploading' && <button className="button small secondary" disabled={!!busy} onClick={() => perform({ id: edit.id, action: 'retry' })}>恢复回传</button>}
        {(edit.state === 'conflict' || edit.state === 'error') && <button className="button small primary" disabled={!!busy} onClick={() => void run(async () => { setComparison({ id: edit.id, files: await api.compareExternalEdit(edit.id) }); setConfirm(null); }, edit.id)}>比较并处理</button>}
        <button className="text-button" disabled={!!busy || edit.state === 'uploading'} onClick={() => setConfirm({ id: edit.id, action: 'finish' })}>结束回传</button>
      </div>
    </article>)}</div>
    {selected && comparison && <section className="external-edit-comparison" aria-label="外部编辑冲突比较">
      <h3>{selected.name} · 比较版本</h3>
      <div className="external-edit-columns">{(['local', 'remote'] as const).map(side => <div key={side}><strong>{side === 'local' ? '本地已保存的版本' : '服务器最新版本'}</strong><CodeEditor key={comparison.files[side].revision} initialText={comparison.files[side].text} path={selected.path} theme={settings.theme} palette={settings.editorPalette} readOnly wrap onChange={() => {}} onCursorChange={() => {}} onSave={() => {}} /></div>)}</div>
      <div className="external-edit-actions"><button className="button secondary" disabled={!!busy} onClick={() => setConfirm({ id: selected.id, action: 'reload', localRevision: comparison.files.local.revision, remoteRevision: comparison.files.remote.revision })}>采用服务器版本</button><button className="button primary" disabled={!!busy} onClick={() => setConfirm({ id: selected.id, action: 'upload', localRevision: comparison.files.local.revision, remoteRevision: comparison.files.remote.revision })}>用本地版本覆盖服务器</button><button className="text-button" onClick={() => setComparison(null)}>收起比较</button></div>
    </section>}
    {confirm && <div className="external-edit-confirm" role="alert"><p>{confirm.action === 'finish' ? '结束自动回传并移出列表？本地草稿保留，尚未回传的修改不会再上传。' : confirm.action === 'reload' ? '用服务器版本替换本地草稿？原本地版本会备份。请在外部编辑器中重新载入文件。' : '确认用刚才比较的本地版本覆盖服务器文件？若任一版本又有修改，本次操作会停止。'}</p><div className="external-edit-actions"><button className="button secondary" disabled={!!busy} onClick={() => setConfirm(null)}>取消</button><button className="button primary" disabled={!!busy} onClick={() => perform(confirm)}>{busy ? '正在处理…' : '确认'}</button></div></div>}
  </div>;
}
