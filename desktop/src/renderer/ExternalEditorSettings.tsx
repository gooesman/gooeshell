import React, { useState } from 'react';
import type { AppSettings } from '../shared/types';
import { normalizeEditorExtension } from '../shared/external-editor';
import { api } from './api';

export default function ExternalEditorSettings({ settings, change }: { settings: AppSettings; change: (value: Partial<AppSettings>) => void }) {
  const [extension, setExtension] = useState('');
  const [error, setError] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const rules = settings.externalEditorByExtension || {};
  const update = (type: string, value: string) => change({ externalEditorByExtension: { ...rules, [type]: value } });
  const browse = async (type?: string) => {
    setBrowsing(true); setError('');
    try {
      const [file] = await api.chooseFiles({ title: type ? `选择 ${type} 文件的文本编辑器` : '选择文本编辑器程序' });
      if (file) { if (type) update(type, file); else change({ externalEditorPath: file }); }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBrowsing(false); }
  };
  const add = () => {
    const type = normalizeEditorExtension(extension);
    if (!type) { setError('请输入一个扩展名，例如 .py、.md 或 .txt。'); return; }
    if (Object.hasOwn(rules, type)) { setError(`${type} 已有设置，请修改现有项。`); return; }
    update(type, ''); setExtension(''); setError('');
  };
  return <>
    <h3>外部文本编辑器</h3>
    <p className="settings-description">文件右键 → 用外部编辑器打开。系统默认会按文件类型使用各自关联的应用；也可为指定类型单独选择编辑器。</p>
    <fieldset className="external-editor-preferences" disabled={browsing}>
      <div className="form-field"><label htmlFor="external-editor-path">未单独设置的文件</label><div className="field-inline"><input id="external-editor-path" value={settings.externalEditorPath} placeholder="系统默认（按文件类型）" onChange={event => change({ externalEditorPath: event.target.value })} /><button className="button secondary" onClick={() => void browse()}>浏览…</button><button className="button secondary" onClick={() => change({ externalEditorPath: '' })}>系统默认</button></div></div>
      <h3>按文件类型设置</h3>
      <p className="settings-description">例如 .py 使用 VS Code，.md 和 .txt 保持系统默认。这里的设置优先于上方；留空表示此类型使用系统默认。</p>
      {Object.entries(rules).map(([type, program]) => <div className="external-editor-rule" key={type} data-editor-extension={type}>
        <label htmlFor={`editor-type-${type}`}>{type}</label>
        <div className="field-inline"><input id={`editor-type-${type}`} aria-label={`${type} 编辑器程序`} value={program} placeholder="系统默认（此文件类型）" onChange={event => update(type, event.target.value)} /><button className="button secondary" aria-label={`选择 ${type} 编辑器`} onClick={() => void browse(type)}>浏览…</button><button className="button secondary" onClick={() => update(type, '')}>系统默认</button><button className="text-button" aria-label={`删除 ${type} 编辑器设置`} onClick={() => { const next = { ...rules }; delete next[type]; change({ externalEditorByExtension: next }); }}>删除</button></div>
      </div>)}
      <div className="field-inline external-editor-add"><input aria-label="文件扩展名" value={extension} placeholder="例如 .py" onChange={event => setExtension(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} /><button className="button secondary" onClick={add}>添加文件类型</button></div>
    </fieldset>
    {error && <div className="form-error" role="alert">{error}</div>}
    <p className="settings-description">Windows 选择编辑器的 .exe（如 Code.exe）；macOS 可选择 .app；Linux 选择可执行程序。不填写命令参数。脚本（如 .py）需要为该类型指定文本编辑器，避免被系统直接执行。</p>
    <h3>远程文件回传</h3><p className="settings-description">保存后自动回传，冲突时暂停并保留两边内容。在底部“外部编辑”中比较、处理冲突或结束回传。退出应用后保留本地草稿，重新连接原服务器后手动恢复。</p><p className="settings-description">支持不超过 2 MiB 的 UTF-8 / 带 BOM 的 UTF-16 普通文本；权限不足时可改用内置编辑器。远程 Markdown 引用的图片等相邻资源不会自动下载。</p>
  </>;
}
