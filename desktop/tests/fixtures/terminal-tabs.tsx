import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import TerminalView from '../../src/renderer/TerminalView';
import { defaultSettings } from '../../src/shared/defaults';
import type { AppSettings } from '../../src/shared/types';
import '../../src/renderer/styles.css';

const profile = { id: 'tabs-fixture', name: 'Isolated terminal', host: '127.0.0.1', port: 22, username: 'fixture', auth: 'agent' as const, rememberHost: false, encoding: 'utf8' as const };
function Fixture() {
  const [count, setCount] = useState(1), [active, setActive] = useState(0);
  const [settings, setSettings] = useState<AppSettings>({ ...defaultSettings, chineseFont: 'DejaVu Sans Mono', cursorBlink: false });
  useEffect(() => { Object.assign(window, { __tabsSetCount: setCount, __tabsSetActive: setActive, __tabsSetSettings: setSettings, __tabsActive: active }); }, [active]);
  return <div style={{ height: '100%', background: '#000' }}>{Array.from({ length: count }, (_, index) =>
    <TerminalView key={index} session={{ id: `tabs-${index}`, profile }} settings={settings} active={active === index} />)}</div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
