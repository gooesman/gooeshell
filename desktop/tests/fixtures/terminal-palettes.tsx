import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import TerminalView from '../../src/renderer/TerminalView';
import TerminalColorSettings from '../../src/renderer/TerminalColorSettings';
import { defaultSettings } from '../../src/shared/defaults';
import type { AppSettings } from '../../src/shared/types';
import '../../src/renderer/styles.css';

const profile = { id: 'palette-connection', name: 'Isolated renderer', host: '127.0.0.1', port: 22, username: 'fixture', auth: 'agent' as const, rememberHost: false, encoding: 'utf8' as const };
function Fixture() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  useEffect(() => { document.documentElement.dataset.theme = settings.theme; (window as any).__fixturePaletteSettings = settings; }, [settings]);
  return <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 550px', height: '100%' }}>
    <TerminalView session={{ id: 'palette-transport', profile }} settings={settings} active={true} />
    <div style={{ padding: 20, overflow: 'auto', background: 'var(--surface)' }}>
      <button id="interface-dark" onClick={() => setSettings(value => ({ ...value, theme: 'dark' }))}>黑色界面</button>
      <button id="interface-light" onClick={() => setSettings(value => ({ ...value, theme: 'light' }))}>白色界面</button>
      <button id="background-on" onClick={() => setSettings(value => ({ ...value, backgroundImage: 'fixture-only', backgroundOpacity: .2 }))}>背景图片</button>
      <TerminalColorSettings settings={settings} onChange={partial => setSettings(value => ({ ...value, ...partial }))} />
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
