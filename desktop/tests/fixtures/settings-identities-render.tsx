import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import SettingsDialog from '../../src/renderer/SettingsDialog';
import { api, isPreview } from '../../src/renderer/api';
import { defaultSettings } from '../../src/shared/defaults';
import type { LoginIdentitySummary, SaveLoginIdentityInput } from '../../src/shared/types';
import '../../src/renderer/styles.css';
import '../../src/renderer/terminal-fonts.css';

if (!isPreview) throw new Error('This fixture requires an isolated preview API');
let identities: LoginIdentitySummary[] = [{ id: 'shared', name: '开发账号', username: 'developer', version: 3, hasPassword: true, remember: 'persistent', references: [{ connectionId: 'fixture-server', name: '开发服务器', host: 'fixture.example.test', port: 22, role: 'target' }] }];
const fixture = { updates: [] as SaveLoginIdentityInput[], deletions: [] as string[], changes: 0, savedSettings: structuredClone(defaultSettings), closed: 0, secureStorageAvailable: true };
api.listLoginIdentities = async () => ({ identities: structuredClone(identities), secureStorageAvailable: fixture.secureStorageAvailable });
api.saveLoginIdentity = async update => {
  const previous = identities.find(identity => identity.id === update.id);
  if (previous && previous.version !== update.expectedVersion) throw new Error('身份已更新，请重新加载');
  fixture.updates.push(structuredClone(update));
  const next: LoginIdentitySummary = { id: update.id || 'new-identity', name: update.name, username: update.username, hasPassword: !!update.password || !!previous?.hasPassword, remember: update.remember, version: (previous?.version || 0) + 1, references: previous?.references || [] };
  identities = [...identities.filter(identity => identity.id !== next.id), next];
  return next;
};
api.deleteLoginIdentity = async id => { if (identities.find(identity => identity.id === id)?.references.length) throw new Error('仍有引用'); fixture.deletions.push(id); identities = identities.filter(identity => identity.id !== id); };
(window as any).settingsIdentityFixture = fixture;
function Fixture() {
  const [revision, setRevision] = useState(0);
  return <SettingsDialog key={revision} settings={fixture.savedSettings} save={async value => { fixture.savedSettings = structuredClone(value); }} clearHistory={async () => {}} close={() => { fixture.closed++; setRevision(value => value + 1); }} onIdentitiesChange={() => { fixture.changes++; }} />;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>);
