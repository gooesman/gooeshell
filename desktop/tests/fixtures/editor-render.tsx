import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import TextEditorDialog from '../../src/renderer/TextEditorDialog';
import type { EditorPalette } from '../../src/shared/types';
import '../../src/renderer/styles.css';

const originalTarget = {
  side: 'remote' as const,
  entry: { name: 'deploy.sh', path: '/home/fixture/deploy.sh', type: 'file' as const, size: 20, modified: 0, mode: 0o100644 },
  sessionId: 'original-session', connectionName: 'Original connection',
};

function Fixture() {
  const [open, setOpen] = useState(true);
  const [disconnected, setDisconnected] = useState(false);
  const [activeSession, setActiveSession] = useState('original-session');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [palette, setPalette] = useState<EditorPalette>(() => (localStorage.getItem('fixture-editor-palette') || 'auto') as EditorPalette);
  const paletteSave = useRef({ failNext: false, hold: false, finish: null as (() => void) | null });
  const [saved, setSaved] = useState(0);
  useEffect(() => {
    (window as any).editorFixture = {
      setDisconnected, setActiveSession, setTheme, setOpen,
      failNextPaletteSave: () => { paletteSave.current.failNext = true; },
      holdPaletteSave: () => { paletteSave.current.hold = true; },
      finishPaletteSave: () => { paletteSave.current.hold = false; paletteSave.current.finish?.(); paletteSave.current.finish = null; },
      readEditor: () => {
        const dom = document.querySelector<HTMLElement>('.cm-editor');
        const view = dom && EditorView.findFromDOM(dom);
        return view ? { text: view.state.doc.toString(), selection: view.state.selection.toJSON(), scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft } : null;
      },
      selectPosition: (line: number, column: number) => {
        const dom = document.querySelector<HTMLElement>('.cm-editor');
        const view = dom && EditorView.findFromDOM(dom);
        if (view) view.dispatch({ selection: { anchor: view.state.doc.line(line).from + column }, scrollIntoView: true });
      },
    };
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return <>
    <output id="fixture-state" data-open={String(open)} data-active-session={activeSession} data-saved={saved} />
    {open && <TextEditorDialog target={originalTarget} theme={theme} palette={palette} disconnected={disconnected}
      onPaletteChange={async next => {
        if (paletteSave.current.hold) await new Promise<void>(resolve => { paletteSave.current.finish = resolve; });
        if (paletteSave.current.failNext) { paletteSave.current.failNext = false; throw new Error('配色偏好保存失败（测试）'); }
        localStorage.setItem('fixture-editor-palette', next);
        setPalette(next);
      }}
      onClose={() => setOpen(false)} onSaved={() => setSaved(count => count + 1)} />}
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
