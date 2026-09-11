import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import TextEditorDialog from '../../src/renderer/TextEditorDialog';
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
  const [saved, setSaved] = useState(0);
  useEffect(() => {
    (window as any).editorFixture = { setDisconnected, setActiveSession, setTheme, setOpen };
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return <>
    <output id="fixture-state" data-open={String(open)} data-active-session={activeSession} data-saved={saved} />
    {open && <TextEditorDialog target={originalTarget} theme={theme} disconnected={disconnected}
      onClose={() => setOpen(false)} onSaved={() => setSaved(count => count + 1)} />}
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
