import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Check, FileText, Maximize2, Minimize2, Redo2, RefreshCw, Replace, Save, Search, Undo2, WrapText, X } from 'lucide-react';
import { api } from './api';
import CodeEditor, { type CodeEditorHandle } from './CodeEditor';
import { editorLanguage, editorLanguages } from './editor-language';
import type { EditableTextFile, EditorEncoding, FileEntry, TextWriteRequest } from '../shared/types';
import './text-editor.css';

export interface EditorTarget {
  side: 'local' | 'remote';
  entry: FileEntry;
  sessionId: string;
  connectionName: string;
}
type Elevation = { elevated?: boolean; sudoPassword?: string };
type Operation = (elevation: Elevation) => Promise<void>;
type EolChoice = 'preserve' | 'lf' | 'crlf' | 'cr';
const encodings: [EditorEncoding, string][] = [['utf8', 'UTF-8'], ['utf8-bom', 'UTF-8 BOM'], ['utf16le', 'UTF-16 LE'], ['utf16be', 'UTF-16 BE'], ['gb18030', 'GB18030 / GBK'], ['big5', 'Big5']];
const eolNames = { lf: 'LF', crlf: 'CRLF', cr: 'CR', mixed: '混合换行', none: '无换行' };
function message(error: unknown) { return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error); }
function convertEol(text: string, choice: EolChoice) { return choice === 'preserve' ? text : text.replace(/\r\n|\r|\n/g, choice === 'crlf' ? '\r\n' : choice === 'cr' ? '\r' : '\n'); }
function lineEnding(text: string): EditableTextFile['lineEnding'] {
  const endings = new Set(text.match(/\r\n|\r|\n/g));
  return endings.size > 1 ? 'mixed' : endings.has('\r\n') ? 'crlf' : endings.has('\r') ? 'cr' : endings.has('\n') ? 'lf' : 'none';
}

export default function TextEditorDialog({ target, theme, disconnected, onClose, onSaved }: {
  target: EditorTarget; theme: 'dark' | 'light'; disconnected: boolean;
  onClose: () => void; onSaved: () => void;
}) {
  const [file, setFile] = useState<EditableTextFile | null>(null);
  const [draft, setDraft] = useState('');
  const [inputPending, setInputPending] = useState(false);
  const [encoding, setEncoding] = useState<EditorEncoding>('utf8');
  const [readEncoding, setReadEncoding] = useState<EditorEncoding | ''>('');
  const [eol, setEol] = useState<EolChoice>('preserve');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [wrap, setWrap] = useState(false);
  const [language, setLanguage] = useState('auto');
  const [indent, setIndent] = useState<'2' | '4' | 'tab'>('2');
  const [expanded, setExpanded] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [latest, setLatest] = useState<EditableTextFile | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; action: () => void; closing?: boolean } | null>(null);
  const [sudo, setSudo] = useState<{ title: string; action: Operation } | null>(null);
  const [password, setPassword] = useState('');
  const [sudoError, setSudoError] = useState('');
  const section = useRef<HTMLElement>(null);
  const surface = useRef<CodeEditorHandle>(null);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const current = useRef({ file, draft, encoding, eol, disconnected });
  current.current = { file, draft, encoding, eol, disconnected };
  const dirty = inputPending || !!file && (convertEol(draft, eol) !== file.text || encoding !== file.encoding);
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const initialText = useRef('');
  const closeRef = useRef(() => {});
  const saveRef = useRef<(closeAfter?: boolean) => void>(() => {});
  const isRemote = target.side === 'remote';
  const languageName = editorLanguage(target.entry.path, language).name;
  const canSave = !!file && !file.truncated && !disconnected && !busy;
  const request = useCallback((elevation: Elevation = {}) => ({ side: target.side, sessionId: target.sessionId, path: target.entry.path, ...elevation }), [target]);

  // Own the document independently of the active terminal tab. A disconnect never
  // clears the draft, and all operations retain the session that opened the file.
  const run = useCallback(async (title: string, action: Operation, elevation: Elevation = {}, fromSudo = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(title); setError(''); setSudoError('');
    try {
      await action(elevation);
      if (fromSudo && alive.current) { setSudo(null); setPassword(''); }
    } catch (cause) {
      if (!alive.current) return;
      const detail = message(cause);
      if (isRemote && !fromSudo && /PERMISSION_DENIED|permission denied|权限不足/i.test(detail)) {
        setSudo({ title, action });
      } else if (fromSudo && !/TEXT_CONFLICT/.test(detail)) {
        setSudoError(detail); setPassword('');
      } else {
        setError(detail);
        if (fromSudo) { setSudo(null); setPassword(''); }
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy('');
    }
  }, [isRemote]);

  const install = useCallback((value: EditableTextFile) => {
    initialText.current = value.text;
    setFile(value); setDraft(value.text); setEncoding(value.encoding); setEol('preserve');
    setLatest(null); setError(''); setGeneration(value => value + 1);
  }, []);

  const load = useCallback((chosen?: EditorEncoding) => {
    void run('读取文件', async elevation => {
      const value = await api.readTextFile({ ...request(elevation), encoding: chosen });
      if (!alive.current) return;
      install(value); setReadEncoding(chosen || ''); setStatus('');
    });
  }, [install, request, run]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [load]);

  useEffect(() => {
    api.editorState?.({ dirty, busy: !!busy });
  }, [dirty, busy]);
  useEffect(() => () => { api.editorState?.({ dirty: false, busy: false }); }, []);

  const save = async (closeAfter = false, expectedRevision?: string) => {
    if (busyRef.current) return;
    await surface.current?.flushText();
    const value = current.current;
    if (!alive.current || !value.file || value.file.truncated || value.disconnected || busyRef.current) return;
    const snapshot = { text: convertEol(surface.current?.getText() ?? value.draft, value.eol), encoding: value.encoding, bom: value.encoding === value.file.encoding ? value.file.bom : value.encoding === 'utf8-bom' || value.encoding.startsWith('utf16') };
    void run('保存文件', async elevation => {
      const result = await api.writeTextFile({ ...request(elevation), ...snapshot, expectedRevision: expectedRevision || value.file!.revision } satisfies TextWriteRequest);
      if (!alive.current) return;
      setFile({ ...value.file!, ...snapshot, ...result, lineEnding: lineEnding(snapshot.text) });
      setLatest(null); setStatus(`已保存 · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
      onSaved();
      if (closeAfter) {
        const latestText = await surface.current?.flushText();
        if (alive.current && convertEol(latestText ?? current.current.draft, current.current.eol) === snapshot.text && current.current.encoding === snapshot.encoding) onClose();
      }
    });
  };
  saveRef.current = save;

  const hasUnsavedChanges = () => {
    const value = current.current;
    return !!value.file && (convertEol(surface.current?.getText() ?? value.draft, value.eol) !== value.file.text || value.encoding !== value.file.encoding);
  };

  const close = async () => {
    if (busyRef.current) return;
    await surface.current?.flushText();
    if (!alive.current || busyRef.current) return;
    if (hasUnsavedChanges()) setConfirmation({ title: '此文件有未保存的修改', action: onClose, closing: true });
    else onClose();
  };
  closeRef.current = close;
  const confirmDiscard = async (title: string, action: () => void) => {
    if (busyRef.current) return;
    await surface.current?.flushText();
    if (!alive.current || busyRef.current) return;
    if (hasUnsavedChanges()) setConfirmation({ title, action });
    else action();
  };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!document.querySelector('.editor-subdialog')) saveRef.current();
        return;
      }
      if (event.key === 'Escape' && !event.defaultPrevented) {
        // CodeMirror handles Escape in its own panels before it reaches here.
        event.preventDefault(); event.stopPropagation();
        if (busyRef.current) return;
        if (section.current?.querySelector('.editor-subdialog')) {
          setConfirmation(null); setSudo(null); setPassword('');
        } else closeRef.current();
      }
      if (event.key === 'Tab' && !(event.target instanceof Element && event.target.closest('.cm-content'))) {
        const root = section.current?.querySelector('.editor-subdialog') || section.current;
        const controls = [...(root?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"],[contenteditable="true"]') || [])].filter(element => element.offsetParent !== null);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current || busyRef.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('beforeunload', unload);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (confirmation || sudo) section.current?.querySelector<HTMLElement>('.editor-subdialog input, .editor-subdialog button')?.focus();
  }, [confirmation, sudo]);

  const compare = () => void run('读取最新版本', async elevation => {
    const value = await api.readTextFile({ ...request(elevation), encoding: current.current.file?.encoding });
    if (alive.current) setLatest(value);
  });
  const localCopy = () => void run('另存到本地', async () => {
    await surface.current?.flushText();
    const value = current.current;
    const path = await api.saveTextCopy({ name: target.entry.name, text: convertEol(surface.current?.getText() ?? value.draft, value.eol), encoding: value.encoding, bom: value.encoding === value.file?.encoding ? value.file.bom : undefined });
    if (path && alive.current) setStatus(`已另存到本地：${path}（原文件未改变）`);
  });
  const formatJson = async () => {
    if (busyRef.current) return;
    await surface.current?.flushText();
    if (!alive.current || busyRef.current) return;
    if (!surface.current?.formatJson()) setError('JSON 格式有误，无法格式化；当前内容未改变。');
    else { setError(''); setStatus('已格式化，保存后生效'); }
  };
  const tool = (label: string, icon: React.ReactNode, action: () => void, disabled = false) => <button type="button" className="editor-tool" aria-label={label} title={label} disabled={disabled} onClick={action}>{icon}</button>;

  return <div className="modal-backdrop editor-backdrop"><section ref={section} role="dialog" aria-modal="true" aria-label={`${target.entry.name} · 文本编辑器`} className={`text-editor-dialog${expanded ? ' expanded' : ''}`}>
    <header className="editor-heading"><FileText size={17}/><div className="editor-heading-copy"><strong>{target.entry.name}{dirty && <span className="editor-dirty" aria-label="未保存"> ●</span>}</strong><span title={target.entry.path}>{isRemote ? target.connectionName : '本地'} · {target.entry.path}</span></div>{tool(expanded ? '还原编辑器' : '展开编辑器', expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>, () => setExpanded(value => !value))}{tool('关闭编辑器', <X size={17}/>, close, !!busy)}</header>
    <div className="editor-toolbar">
      <button type="button" className="button primary small" aria-label="保存文件" title="保存文件 · Ctrl+S / ⌘S" disabled={!canSave || !dirty} onClick={() => save()}><Save size={14}/>保存</button>
      {tool('另存到本地', <ArrowDownToLine size={16}/>, localCopy, !file || file.truncated || !!busy)}
      <span className="editor-separator"/>
      {tool('撤销', <Undo2 size={16}/>, () => surface.current?.undo(), !file || file.truncated)}
      {tool('重做', <Redo2 size={16}/>, () => surface.current?.redo(), !file || file.truncated)}
      {tool('查找', <Search size={16}/>, () => surface.current?.find(), !file)}
      {tool('替换', <Replace size={16}/>, () => surface.current?.replace(), !file || file.truncated)}
      <button type="button" className="editor-tool editor-tool-text" onClick={() => surface.current?.gotoLine()} disabled={!file} title="跳转行 · Ctrl+G">跳转行</button>
      {languageName === 'JSON' && <button type="button" className="editor-tool editor-tool-text" disabled={!file || file.truncated || !!busy} onClick={() => void formatJson()}>格式化 JSON</button>}
      <button type="button" className={`editor-tool${wrap ? ' active' : ''}`} aria-label="自动换行" title="自动换行" aria-pressed={wrap} onClick={() => setWrap(value => !value)}><WrapText size={16}/></button>
      <span className="editor-toolbar-spacer"/>
      {tool('重新读取', <RefreshCw size={15}/>, () => confirmDiscard('重新读取会放弃当前未保存的修改', () => load(readEncoding || undefined)), disconnected || !!busy)}
      <select aria-label="以编码重新打开" title="以指定编码重新读取原文件" value={readEncoding} disabled={!!busy || disconnected} onChange={event => { const chosen = event.target.value as EditorEncoding | ''; confirmDiscard('更换读取编码会放弃当前未保存的修改', () => load(chosen || undefined)); }}><option value="">读取编码：自动</option>{encodings.map(([key, label]) => <option key={key} value={key}>读取：{label}</option>)}</select>
    </div>
    {disconnected && <div className="editor-banner" role="status">连接已断开，编辑内容仍保留。可以继续编辑并另存到本地。</div>}
    {file?.truncated && <div className="editor-banner">文件超过 2 MB，当前为只读预览，不能保存截断内容。</div>}
    {error && <div className="editor-banner editor-error" role="alert"><span>{/TEXT_CONFLICT/.test(error) ? '原文件已发生变化，尚未覆盖。你的修改仍保留，请先查看最新版本。' : error}</span>{/TEXT_CONFLICT/.test(error) && <button type="button" className="text-button" disabled={!!busy || disconnected} onClick={compare}>查看最新版本</button>}</div>}
    <div className={`editor-document-area${latest ? ' comparing' : ''}`}>
      <div className="editor-document-pane">{latest && <div className="editor-pane-caption">当前编辑内容</div>}{file ? <CodeEditor key={generation} ref={surface} initialText={initialText.current} path={target.entry.path} language={language} indent={indent} theme={theme} readOnly={file.truncated || busy === '读取文件'} wrap={wrap} onInputPending={pending => { setInputPending(pending); if (pending) { dirtyRef.current = true; api.editorState?.({ dirty: true, busy: busyRef.current }); } }} onChange={text => { const value = current.current; value.draft = text; dirtyRef.current = !!value.file && (convertEol(text, value.eol) !== value.file.text || value.encoding !== value.file.encoding); api.editorState?.({ dirty: dirtyRef.current, busy: busyRef.current }); setDraft(text); setStatus(''); }} onCursorChange={(line, column) => setCursor({ line, column })} onSave={() => saveRef.current()}/> : <div className="editor-empty">{busy ? '正在读取文件…' : '文件尚未打开。可以选择正确的读取编码后重试。'}</div>}</div>
      {latest && <div className="editor-document-pane"><div className="editor-pane-caption">磁盘最新版本 · 只读</div><CodeEditor key={latest.revision} initialText={latest.text} path={target.entry.path} language={language} indent={indent} theme={theme} readOnly wrap={wrap} onChange={() => {}} onCursorChange={() => {}} onSave={() => {}}/></div>}
    </div>
    {latest && <div className="editor-compare-actions"><span>核对后选择；保存时还会再次检查版本。</span><button className="button secondary small" onClick={() => setLatest(null)}>取消比较</button><button className="button secondary small" disabled={!!busy} onClick={() => confirmDiscard('使用最新版本会放弃当前未保存的修改', () => { install(latest); setStatus('已读取最新版本'); })}>使用最新版本</button><button className="button primary small" disabled={!canSave || latest.truncated} onClick={() => save(false, latest.revision)}>以当前内容覆盖此版本</button></div>}
    <footer className="editor-statusbar"><span className="editor-save-status" title={status}>{busy || status || (dirty ? '未保存' : file ? '已载入' : '未载入')}{status.startsWith('已保存') && <Check size={12}/>}</span><span>行 {cursor.line}，列 {cursor.column}</span><select aria-label="语法模式" value={language} onChange={event => setLanguage(event.target.value)}>{editorLanguages.map(item => <option key={item.id} value={item.id}>{item.id === 'auto' ? `自动 · ${editorLanguage(target.entry.path).name}` : item.name}</option>)}</select><select aria-label="缩进" value={indent} onChange={event => setIndent(event.target.value as '2' | '4' | 'tab')}><option value="2">2 空格</option><option value="4">4 空格</option><option value="tab">Tab</option></select><select aria-label="换行格式" title="保存时使用的换行格式" value={eol} disabled={!file || file.truncated || !!busy} onChange={event => setEol(event.target.value as EolChoice)}><option value="preserve">保留原换行{file ? ` · ${eolNames[file.lineEnding]}` : ''}</option><option value="lf">LF</option><option value="crlf">CRLF</option><option value="cr">CR</option></select><select aria-label="保存编码" title="保存编码" value={encoding} disabled={!file || file.truncated || !!busy} onChange={event => setEncoding(event.target.value as EditorEncoding)}>{encodings.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>{file && <span>{file.truncated ? '> 2 MB' : `${(file.size / 1024).toFixed(1)} KB`}</span>}</footer>
    {confirmation && <div className="editor-subdialog-backdrop"><div className="editor-subdialog" role="alertdialog" aria-modal="true" aria-label="未保存的修改"><h3>{confirmation.title}</h3><p>可以继续编辑，或放弃修改后继续。</p><div className="editor-subdialog-actions"><button className="button secondary" onClick={() => { setConfirmation(null); surface.current?.focus(); }}>继续编辑</button><button className="button secondary" onClick={() => { const action = confirmation.action; setConfirmation(null); action(); }}>放弃修改</button>{confirmation.closing && <button className="button primary" disabled={!canSave} onClick={() => { setConfirmation(null); save(true); }}>保存并关闭</button>}</div></div></div>}
    {sudo && <div className="editor-subdialog-backdrop"><form className="editor-subdialog" role="dialog" aria-modal="true" aria-label="为本次文件操作使用 sudo" onSubmit={event => { event.preventDefault(); void run(sudo.title, sudo.action, { elevated: true, sudoPassword: password }, true); }}><h3>为本次文件操作使用 sudo</h3><p>{sudo.title} · {target.entry.name}</p><label>sudo 密码<input autoFocus aria-label="编辑器 sudo 密码" type="password" autoComplete="off" value={password} disabled={!!busy} onChange={event => setPassword(event.target.value)}/></label><p>免密 sudo 可留空。仅用于本次操作。</p>{sudoError && <div className="form-error" role="alert">{sudoError}</div>}<div className="editor-subdialog-actions"><button type="button" className="button secondary" disabled={!!busy} onClick={() => { setSudo(null); setPassword(''); surface.current?.focus(); }}>取消</button><button className="button primary" disabled={!!busy} type="submit">{busy ? '正在执行…' : '继续操作'}</button></div></form></div>}
  </section></div>;
}
