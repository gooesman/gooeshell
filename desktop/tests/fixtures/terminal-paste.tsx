import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import TerminalView from '../../src/renderer/TerminalView';
import { defaultSettings } from '../../src/shared/defaults';
import '../../src/renderer/styles.css';

function Fixture() {
  const [active, setActive] = useState(0);
  const [ids, setIds] = useState(['paste-a', 'paste-b']);
  const [offline, setOffline] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [mouse, setMouse] = useState(false);
  useEffect(() => { Object.assign(window, { __pasteFixture: { setActive, setIds, setOffline, setReconnecting, setMouse } }); }, []);
  useEffect(() => { (window as any).__pasteState = { active, ids, offline, reconnecting, mouse }; });
  const settings = { ...defaultSettings, rightClickPaste: true, shortcuts: { ...defaultSettings.shortcuts, paste: mouse ? 'MouseMiddle' : defaultSettings.shortcuts.paste } };
  return <>{ids.map((id, index) => <section key={index} data-terminal-fixture={index} style={{ height: '100%', display: active === index ? 'block' : 'none' }}>
    <TerminalView session={{ id, tabId: 'paste-tab-' + index, profile: { id: 'fixture-' + index, name: 'Fixture ' + (index + 1), host: '127.0.0.1', port: 22, username: 'fixture', auth: 'agent', rememberHost: false, encoding: 'utf8' } }}
      settings={settings} active={active === index} disconnected={index === 0 && offline} reconnecting={index === 0 && reconnecting} onReconnect={() => {}} />
  </section>)}</>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
