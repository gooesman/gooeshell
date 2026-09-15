import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import type { FileEntry } from '../shared/types';

export type FileTarget = { side: 'local' | 'remote'; sessionId: string; basePath: string; connectionName: string };
export type FileElevation = { elevated?: boolean; sudoPassword?: string };
export type FileAction = FileTarget & { type: 'createFile' | 'mkdir' | 'rename' | 'delete'; entries: FileEntry[] };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export function childPath(target: FileTarget, name: string) {
  const separator = target.side === 'local' && target.basePath.includes('\\') ? '\\' : '/';
  return target.basePath.replace(/[\\/]$/, '') + separator + name;
}

/** One immutable destination belongs to the dialog, even when tabs or listings change. */
export function FileActionDialog({ action, close, onPermission, refresh, done }: {
  action: FileAction; close: () => void;
  onPermission: (label: string, run: (elevation: FileElevation) => Promise<unknown>) => void;
  refresh: (target: FileTarget) => void; done: (message: string) => void;
}) {
  const [name, setName] = useState(action.type === 'rename' ? action.entries[0]?.name || '' : '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const removed = useRef(new Set<string>()), locked = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const deleting = action.type === 'delete';
  const title = deleting ? '删除文件或文件夹' : action.type === 'mkdir' ? '新建文件夹' : action.type === 'rename' ? '重命名' : '新建文件';
  const valid = name.trim().length > 0 && !/[\\/\0\r\n]/.test(name) && !['.', '..'].includes(name.trim()) && (action.side !== 'local' || !/[<>:"|?*]/.test(name));
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>(deleting ? '.file-action-cancel' : 'input')?.focus();
    const keyboard = (event: KeyboardEvent) => {
      const top = [...document.querySelectorAll('[role="dialog"]')].at(-1);
      if (top !== dialog.current) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!locked.current) close(); }
      if (event.key === 'Tab') {
        const controls = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')];
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => { window.removeEventListener('keydown', keyboard); if (previous?.isConnected) previous.focus(); };
  }, []);
  const submit = async () => {
    if (locked.current || (!deleting && !valid)) return;
    locked.current = true; setBusy(true); setError('');
    // Capture the submitted name, not the later input/active directory.
    const destination = childPath(action, name);
    const run = async (elevation: FileElevation) => {
      const request = { side: action.side, sessionId: action.sessionId, ...elevation };
      try {
        if (deleting) {
          for (const entry of action.entries) {
            if (removed.current.has(entry.path)) continue;
            await api.removeFile({ ...request, path: entry.path, recursive: entry.type === 'directory' });
            removed.current.add(entry.path);
          }
        } else if (action.type === 'rename') {
          await api.rename({ ...request, path: action.entries[0].path, destination });
        } else {
          await api[action.type === 'mkdir' ? 'mkdir' : 'createFile']({ ...request, path: destination });
        }
        done(deleting ? `已删除 ${action.entries.length} 项` : action.type === 'rename' ? '名称已更新' : `已创建 ${name}`);
        close();
      } finally { refresh(action); }
    };
    try { await run({}); }
    catch (failure) {
      const message = errorText(failure);
      const progress = removed.current.size ? `已删除 ${removed.current.size} 项。` : '';
      setError(progress + message);
      if (action.side === 'remote' && /PERMISSION_DENIED|permission denied|权限不足/i.test(message)) {
        const paths = deleting ? action.entries.filter(entry => !removed.current.has(entry.path)).map(entry => entry.path).join('\n') : action.type === 'rename' ? `${action.entries[0].path} → ${destination}` : destination;
        onPermission(`${action.connectionName}\n${title}${deleting ? '（包含所选目录中的内容）' : ''}\n${paths}`, run);
      }
    } finally { locked.current = false; setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close(); }}>
    <section ref={dialog} className="modal compact file-action-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-header"><span className="modal-title">{title}</span><button aria-label="关闭" className="icon-button" disabled={busy} onClick={close}>×</button></div>
      <form id="file-name-form" className="modal-body" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className="file-action-location"><strong>{action.side === 'local' ? '本地' : action.connectionName}</strong><span>{action.basePath}</span></div>
        {deleting ? <><p>将永久删除以下 {action.entries.length} 项；文件夹中的内容也会删除，无法从回收站恢复。</p><ul className="file-delete-targets">{action.entries.map(entry => <li key={entry.path}>{removed.current.has(entry.path) ? '已删除 · ' : ''}{entry.path}{entry.type === 'directory' ? '/' : ''}</li>)}</ul></> : <div className="form-field"><label htmlFor="file-new-name">{action.side === 'remote' ? '远程' : '本地'}名称</label><input id="file-new-name" autoFocus value={name} disabled={busy} spellCheck={false} onChange={event => setName(event.target.value)} /></div>}
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>
      <div className="modal-footer"><button className="button secondary file-action-cancel" disabled={busy} onClick={close}>取消</button><button className="button primary" form="file-name-form" type="submit" disabled={busy || (!deleting && !valid)}>{busy ? '正在处理…' : deleting ? '确认删除' : action.type === 'rename' ? '重命名' : '创建'}</button></div>
    </section>
  </div>;
}

export function FileContextMenu({ x, y, close, children }: { x: number; y: number; close: () => void; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = element.current!, bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(5, Math.min(x, window.innerWidth - bounds.width - 5))}px`;
    menu.style.top = `${Math.max(5, Math.min(y, window.innerHeight - bounds.height - 5))}px`;
    menu.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const outside = (event: MouseEvent) => { if (!element.current?.contains(event.target as Node)) close(); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); close(); return; }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const controls = [...element.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      event.preventDefault(); event.stopPropagation();
      const index = controls.indexOf(document.activeElement as HTMLButtonElement);
      controls[event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + controls.length) % controls.length]?.focus();
    };
    window.addEventListener('mousedown', outside); window.addEventListener('keydown', keyboard); window.addEventListener('blur', close); window.addEventListener('resize', close);
    return () => { window.removeEventListener('mousedown', outside); window.removeEventListener('keydown', keyboard); window.removeEventListener('blur', close); window.removeEventListener('resize', close); };
  }, [close]);
  return <div ref={element} className="context-menu file-context-menu" role="menu" aria-label="文件操作" style={{ left: x, top: y }} onClick={event => event.stopPropagation()}>{children}</div>;
}
