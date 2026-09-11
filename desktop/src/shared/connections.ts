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
  return JSON.stringify(identity);
}

export function sameConnection(a: HostProfile, b: HostProfile): boolean {
  return a.id === b.id && connectionIdentity(a) === connectionIdentity(b);
}
