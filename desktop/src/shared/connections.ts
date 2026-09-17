import type { HostProfile } from './types';

export function connectionIdentity(profile: HostProfile): string {
  const identity: unknown[] = [
    profile.host.trim().replace(/^\[|\]$/g, '').toLowerCase(), profile.port,
    profile.username.trim(), profile.auth,
    profile.auth === 'key' ? (profile.privateKeyPath || '').trim() : '',
  ];
  // Keep existing direct identities byte-for-byte stable so remembered passwords
  // survive upgrades. A route distinguishes private addresses behind different hops.
  if (profile.jumpHost) {
    const jump = profile.jumpHost;
    identity.push(['jump',
      jump.host.trim().replace(/^\[|\]$/g, '').toLowerCase(), jump.port,
      jump.username.trim(), jump.auth,
      jump.auth === 'key' ? (jump.privateKeyPath || '').trim() : '',
    ]);
  }
  if (profile.loginIdentityId || profile.jumpHost?.loginIdentityId) identity.push(['login-identities',profile.loginIdentityId || '',profile.jumpHost?.loginIdentityId || '']);
  return JSON.stringify(identity);
}

export function sameConnection(a: HostProfile, b: HostProfile): boolean {
  return a.id === b.id && connectionIdentity(a) === connectionIdentity(b);
}

/** A shared identity's username is live metadata, not a new saved connection. */
export function connectionConfigurationIdentity(profile: HostProfile): string {
  const snapshot = structuredClone(profile);
  if (snapshot.loginIdentityId) snapshot.username = `identity:${snapshot.loginIdentityId}`;
  if (snapshot.jumpHost?.loginIdentityId) snapshot.jumpHost.username = `identity:${snapshot.jumpHost.loginIdentityId}`;
  return JSON.stringify([connectionIdentity(snapshot), profile.loginIdentityId || '', profile.jumpHost?.loginIdentityId || '']);
}
export function sameConnectionConfiguration(a: HostProfile, b: HostProfile): boolean {
  return a.id === b.id && connectionConfigurationIdentity(a) === connectionConfigurationIdentity(b);
}
