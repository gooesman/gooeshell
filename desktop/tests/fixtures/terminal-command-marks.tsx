import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import TerminalView from '../../src/renderer/TerminalView';
import { defaultSettings } from '../../src/shared/defaults';
import type { AppSettings } from '../../src/shared/types';
import '../../src/renderer/styles.css';
import '../../src/renderer/workspace.css';

const profile = { id: 'command-marks-fixture', name: 'Isolated command marks', host: '127.0.0.1', port: 22,
  username: 'fixture', auth: 'agent' as const, rememberHost: false, encoding: 'utf8' as const };

function Fixture() {
  const [connection, setConnection] = useState({ id: 'marks-old', disconnected: false, reconnecting: false });
  const [active, setActive] = useState('a');
  const [settings, setSettings] = useState<AppSettings>({ ...defaultSettings, cursorBlink: false });
  useEffect(() => {
    Object.assign(window, { __marksFixture: { connection, active, settings, setConnection, setActive,
      patchSettings: (patch: Partial<AppSettings>) => setSettings(previous => ({ ...previous, ...patch })) } });
  }, [connection, active, settings]);
  return <div style={{ height: '100%', background: '#000' }}>
    <div data-fixture-tab="a" style={{ height: '100%', display: active === 'a' ? 'block' : 'none' }}>
      <TerminalView session={{ id: connection.id, tabId: 'marks-stable-a', profile }} settings={settings} active={active === 'a'}
        disconnected={connection.disconnected} reconnecting={connection.reconnecting} onReconnect={() => {}} />
    </div>
    <div data-fixture-tab="b" style={{ height: '100%', display: active === 'b' ? 'block' : 'none' }}>
      <TerminalView session={{ id: 'marks-b', tabId: 'marks-stable-b', profile }} settings={settings} active={active === 'b'} />
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
