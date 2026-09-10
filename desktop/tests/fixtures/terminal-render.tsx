import React from 'react';
import { createRoot } from 'react-dom/client';
import TerminalView from '../../src/renderer/TerminalView';
import { defaultSettings } from '../../src/shared/defaults';

// The actual component is mounted; only the IPC boundary belongs to the fixture.
const session = await (window as any).terminalFixture.connect();
createRoot(document.getElementById('root')!).render(<TerminalView session={session} settings={defaultSettings} active={true} />);
