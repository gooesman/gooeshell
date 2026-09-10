import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import TerminalView from '../../src/renderer/TerminalView';
import { defaultSettings } from '../../src/shared/defaults';
import '../../src/renderer/styles.css';

// The actual component is mounted; only the IPC boundary belongs to the fixture.
const session = await (window as any).terminalFixture.connect();
function Fixture() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [font, setFont] = useState({fontFamily: defaultSettings.fontFamily, fontWeight: defaultSettings.fontWeight});
  useEffect(() => {
    (window as any).__fixtureSetTheme = setTheme;
    (window as any).__fixtureSetFont = (fontFamily: string, fontWeight: 400 | 700) => setFont({fontFamily, fontWeight});
    return () => { delete (window as any).__fixtureSetTheme; delete (window as any).__fixtureSetFont; };
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return <TerminalView session={session} settings={{ ...defaultSettings, ...font, theme }} active={true} />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
