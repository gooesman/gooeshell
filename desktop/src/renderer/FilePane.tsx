import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Crosshair, FileCode2, FileText, Folder, FolderOpen, Link2, RefreshCw, Upload } from 'lucide-react';
import { parentPath } from '../shared/file-paths';
import { sortFiles, type FileSortDirection, type FileSortKey } from '../shared/file-sort';
import type { FileEntry, FileListing } from '../shared/types';

type Side = 'local' | 'remote';
type FilePaneProps = {
  side: Side; sessionId?: string; listing: FileListing; loading: boolean; error: string; selected: string[]; connected: boolean;
  load: (path: string) => void; select: (entries: string[]) => void; context: (event: React.MouseEvent, entry?: FileEntry) => void;
  open: (entry: FileEntry) => void; drop: (event: React.DragEvent) => void; chooseFolder?: () => void; chooseUpload?: () => void;
  following?: boolean; toggleFollow?: () => void; followStatus?: string; refresh: () => void;
};

const dragMime = 'application/x-gooeshell-files';
const rowHeight = 29, headerHeight = 26, overscan = 6, virtualThreshold = 200;
// Creating an Intl formatter per cell dominates updates in large directories.
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function bytes(value: number) { if (!Number.isFinite(value) || value < 0) return '—'; if (value < 1024) return `${value} B`; const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024))); return `${(value / 1024 ** unit).toFixed(value / 1024 ** unit < 10 ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`; }
function modeText(mode?: number) { if (mode === undefined) return '—'; return [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 0o4, 0o2, 0o1].map((bit, i) => mode & bit ? 'rwx'[i % 3] : '-').join(''); }
function dateText(value: number) { return value && Number.isFinite(new Date(value).getTime()) ? dateFormatter.format(value) : '—'; }
function PaneButton({ title, children, disabled, onClick }: { title: string; children: React.ReactNode; disabled?: boolean; onClick?: () => void }) {
  return <button type="button" className="icon-button" title={title} aria-label={title} disabled={disabled} onClick={onClick}>{children}</button>;
}

type RowActions = Pick<FilePaneProps, 'open' | 'select' | 'context'> & { click: (event: React.MouseEvent, entry: FileEntry) => void };
// Rows depend on file/selection/viewport changes, not the App's transfer progress,
// toast updates, path input, or newly allocated parent callback closures.
const FileRows = memo(function FileRows({ rows, start, end, selected, side, sessionId, actions }: {
  rows: FileEntry[]; start: number; end: number; selected: string[]; side: Side; sessionId?: string; actions: React.RefObject<RowActions>;
}) {
  const selectedPaths = useMemo(() => new Set(selected), [selected]);
  const columns = side === 'remote' ? 4 : 3;
  // The date column is hidden in narrow windows. Keep a matching date cell in
  // spacers, so colspan cannot introduce a phantom column at that breakpoint.
  const spacer = (height: number) => <tr className="file-table-spacer" aria-hidden="true"><td colSpan={columns - 1} style={{ height }} /><td className="file-date" style={{ height }} /></tr>;
  return <tbody>
    {start > 0 && spacer(start * rowHeight)}
    {rows.slice(start, end).map((entry, index) => {
      const isSelected = selectedPaths.has(entry.path);
      return <tr key={entry.path} data-file-path={entry.path} aria-rowindex={start + index + 2} aria-selected={isSelected} className={isSelected ? 'selected' : ''}
        onClick={event => actions.current.click(event, entry)} onDoubleClick={() => actions.current.open(entry)}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!isSelected) actions.current.select([entry.path]); actions.current.context(event, entry); }}
        draggable onDragStart={event => { event.dataTransfer.setData(dragMime, JSON.stringify({ side, paths: isSelected ? selected : [entry.path], sessionId: side === 'remote' ? sessionId : undefined })); event.dataTransfer.effectAllowed = 'copy'; }}>
        <td className="file-name" title={entry.name}><div className="file-name-inner"><span className={`file-symbol ${entry.type === 'directory' ? 'directory' : entry.name.endsWith('.sh') ? 'script' : ''}`}>
          {entry.type === 'directory' ? <Folder size={15} strokeWidth={1.6} /> : entry.type === 'symlink' ? <Link2 size={14} /> : entry.name.endsWith('.sh') ? <FileCode2 size={15} strokeWidth={1.6} /> : <FileText size={14} strokeWidth={1.5} />}
        </span><span>{entry.name}</span></div></td>
        <td className="file-size">{entry.type === 'directory' ? '—' : bytes(entry.size)}</td>
        {side === 'remote' && <td className="file-perm" title={entry.mode === undefined ? '' : (entry.mode & 0o7777).toString(8)}>{modeText(entry.mode)}</td>}
        <td className="file-date">{dateText(entry.modified)}</td>
      </tr>;
    })}
    {end < rows.length && spacer((rows.length - end) * rowHeight)}
  </tbody>;
});

export default function FilePane({ side, sessionId, listing, loading, error, selected, connected, load, select, context, open, drop, chooseFolder, chooseUpload, following, toggleFollow, followStatus, refresh }: FilePaneProps) {
  const [collapsed, setCollapsed] = useState(side === 'local'); const paneName = side === 'local' ? '本地' : '远程';
  const [sort, setSort] = useState<{ key: FileSortKey; direction: FileSortDirection }>({ key: 'name', direction: 'ascending' });
  const [path, setPath] = useState(listing.path), [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0), anchor = useRef(''), wrap = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const updateViewport = useCallback(() => {
    const element = wrap.current;
    // A collapsed/hidden pane reports zero geometry. Keep its scroll position
    // until it is visible again, rather than snapping it back to the first row.
    if (!element?.clientHeight) return;
    const top = element.scrollTop, height = element.clientHeight;
    setViewport(previous => previous.top === top && previous.height === height ? previous : { top, height });
  }, []);
  useEffect(() => { setPath(listing.path); }, [listing.path]);
  const viewSession = side === 'remote' ? sessionId : undefined;
  useLayoutEffect(() => {
    anchor.current = '';
    if (wrap.current) wrap.current.scrollTop = 0;
    setViewport(previous => ({ ...previous, top: 0 }));
  }, [listing.path, viewSession]);
  useLayoutEffect(() => {
    const element = wrap.current;
    if (!element) return;
    updateViewport();
    const observer = new ResizeObserver(updateViewport); observer.observe(element);
    return () => observer.disconnect();
  }, [updateViewport]);
  useLayoutEffect(updateViewport, [collapsed, listing.entries, updateViewport]);
  const rows = useMemo(() => sortFiles(listing.entries, sort.key, sort.direction), [listing.entries, sort.key, sort.direction]);
  const virtual = rows.length > virtualThreshold;
  const visibleCount = Math.ceil((viewport.height || 400) / rowHeight);
  const start = virtual ? Math.min(Math.max(0, rows.length - visibleCount), Math.max(0, Math.floor(Math.max(0, viewport.top - headerHeight) / rowHeight) - overscan)) : 0;
  const end = virtual ? Math.min(rows.length, start + visibleCount + overscan * 2 + 1) : rows.length;
  const column = (key: FileSortKey, label: string, className?: string) => <th scope="col" className={className} aria-sort={sort.key === key ? sort.direction : 'none'}><button type="button" className={`file-sort-button${sort.key === key ? ' active' : ''}`} aria-label={`${paneName}按${label}排序`} title={`${label} · 点击${sort.key === key && sort.direction === 'ascending' ? '降序' : '升序'}排列（文件夹优先）`} onClick={() => setSort(previous => ({ key, direction: previous.key === key && previous.direction === 'ascending' ? 'descending' : 'ascending' }))}><span>{label}</span><span className="file-sort-arrow" aria-hidden="true">{sort.key === key && (sort.direction === 'ascending' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</span></button></th>;
  const click = (event: React.MouseEvent, entry: FileEntry) => {
    if (event.shiftKey && anchor.current) {
      const first = rows.findIndex(row => row.path === anchor.current), last = rows.findIndex(row => row.path === entry.path);
      if (first >= 0 && last >= 0) { select(rows.slice(Math.min(first, last), Math.max(first, last) + 1).map(row => row.path)); return; }
    }
    if (event.ctrlKey || event.metaKey) select(selected.includes(entry.path) ? selected.filter(path => path !== entry.path) : [...selected, entry.path]);
    else select([entry.path]);
    anchor.current = entry.path;
  };
  const actions = useRef<RowActions>({ open, select, context, click });
  useLayoutEffect(() => { actions.current = { open, select, context, click }; });
  const blankListPoint = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('table')) return false;
    const element = event.currentTarget, bounds = element.getBoundingClientRect(), x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    return x >= element.clientLeft && x < element.clientLeft + element.clientWidth && y >= element.clientTop && y < element.clientTop + element.clientHeight;
  };
  return <section data-side={side} aria-label={`${paneName}文件管理`} data-collapsed={collapsed} data-drop-label={side === 'remote' ? '松开后选择上传方式' : '松开后选择下载方式'} className={`file-pane${dragging ? ' drop-active' : ''}${collapsed ? ' collapsed' : ''}`}
    onDragEnter={event => { if (collapsed || !connected || (side === 'local' && !event.dataTransfer.types.includes(dragMime))) return; event.preventDefault(); dragDepth.current++; setDragging(true); }}
    onDragLeave={() => { dragDepth.current--; if (dragDepth.current <= 0) setDragging(false); }}
    onDragOver={event => { if (!collapsed && connected && (side === 'remote' || event.dataTransfer.types.includes(dragMime))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
    onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); if (!collapsed && connected) drop(event); }}>
    <button type="button" className="file-pane-collapsed-control" title={`展开${paneName}文件栏`} aria-label={`展开${paneName}文件栏`} aria-expanded="false" onClick={() => setCollapsed(false)}>{side === 'local' ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}<span>{paneName}</span><span className="pane-collapsed-count">{`${listing.entries.length} 项`}</span></button>
    <div className="file-pane-toolbar">
      <span className={`pane-label ${side === 'remote' ? 'remote' : ''}`}>{side === 'local' ? '▱ 本地' : '▤ 远程'}</span>
      <PaneButton title="上一级目录" disabled={!connected || loading} onClick={() => load(parentPath(listing.path, side))}><ArrowUp size={15} strokeWidth={1.7} /></PaneButton>
      <form style={{ display: 'flex', flex: 1, minWidth: 0 }} onSubmit={event => { event.preventDefault(); if (path.trim()) load(path.trim()); }}><input aria-label={side === 'local' ? '本地目录路径' : '远程目录路径'} className="path-input" value={path} onChange={event => setPath(event.target.value)} disabled={!connected} spellCheck={false} placeholder={side === 'remote' ? '连接服务器后浏览文件' : '本地文件路径'} /></form>
      <PaneButton title="刷新目录" disabled={!connected || loading} onClick={refresh}><RefreshCw size={15} strokeWidth={1.7} /></PaneButton>
      {side === 'local' ? <PaneButton title="选择本地文件夹" onClick={chooseFolder}><FolderOpen size={15} strokeWidth={1.7} /></PaneButton> : <PaneButton title="选择文件上传" disabled={!connected} onClick={chooseUpload}><Upload size={15} strokeWidth={1.7} /></PaneButton>}
      {side === 'remote' && <button type="button" aria-label="跟随终端目录" aria-pressed={!!following} title={followStatus || '自动跟随当前终端中的目录；手动浏览会暂停跟随'} className={`file-follow-button${following ? ' active' : ''}`} disabled={!connected} onClick={toggleFollow}><Crosshair size={14} /><span>跟随终端</span></button>}
      <button type="button" className="pane-collapse-button" title={`收起${paneName}文件栏`} aria-label={`收起${paneName}文件栏`} aria-expanded="true" onClick={() => setCollapsed(true)}>{side === 'local' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}</button>
    </div>
    <div ref={wrap} className="file-table-wrap" onScroll={updateViewport}
      onClick={event => { if (event.button === 0 && blankListPoint(event)) { anchor.current = ''; select([]); } }}
      onContextMenu={event => { event.preventDefault(); if (blankListPoint(event) && connected && !loading && listing.path) { anchor.current = ''; select([]); context(event); } }}>
      {!connected ? <div className="pane-message"><span>连接服务器后查看远程目录</span><span>支持上传、下载与断点续传</span></div> : loading && rows.length === 0 ? <div className="pane-message"><span className="loading-spin" />正在读取目录…</div> : <table className="file-table" aria-rowcount={rows.length + 1}>
        <thead><tr aria-rowindex={1}>{column('name', '名称')}{column('size', '大小', 'size-col')}{side === 'remote' && column('mode', '权限', 'perm-col')}{column('modified', '修改时间', 'date-col')}</tr></thead>
        <FileRows rows={rows} start={start} end={end} selected={selected} side={side} sessionId={sessionId} actions={actions} />
      </table>}
      {connected && !loading && rows.length === 0 && <div className="pane-message">{error ? '目录读取失败' : '此目录为空'}</div>}
    </div>
    {error && <div className="inline-error" title={error}>{error}</div>}
    <footer className="file-pane-footer"><span>{loading ? '正在刷新…' : `${rows.length} 项`}</span><span>{side === 'local' ? '双击打开 · 右键更多操作' : followStatus || '双击打开 · 右键更多操作'}</span></footer>
  </section>;
}
