import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import TerminalView from '../../src/renderer/TerminalView';
import { defaultSettings } from '../../src/shared/defaults';
import type {AppSettings} from '../../src/shared/types';
import '../../src/renderer/styles.css';

// The actual component is mounted; only the IPC boundary belongs to the fixture.
const session = await (window as any).terminalFixture.connect();
function Fixture() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  type FontSelection=Pick<AppSettings,'fontFamily'|'fontWeight'|'chineseFont'|'chineseFontWeight'>;
  const [font, setFont] = useState<FontSelection>({fontFamily: defaultSettings.fontFamily, fontWeight: defaultSettings.fontWeight,chineseFont:'Microsoft YaHei',chineseFontWeight:400});
  useEffect(() => {
    (window as any).__fixtureSetTheme = setTheme;
    (window as any).__fixtureSetFont = (fontFamily: string, fontWeight: number) => setFont(previous=>({...previous,fontFamily, fontWeight}));
    (window as any).__fixtureSetFontSelection = (value:Partial<FontSelection>) => setFont(previous=>({...previous,...value}));
    return () => { delete (window as any).__fixtureSetTheme; delete (window as any).__fixtureSetFont; delete (window as any).__fixtureSetFontSelection; };
  }, []);
  useEffect(()=>{(window as any).__fixtureFontSelection=font;},[font]);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return <TerminalView session={session} settings={{ ...defaultSettings, ...font, theme }} active={true} />;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
