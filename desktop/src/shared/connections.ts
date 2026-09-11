import type { HostProfile } from './types';

export function connectionIdentity(profile: HostProfile): string {
  return JSON.stringify([
    profile.host.trim().replace(/^\[|\]$/g, '').toLowerCase(), profile.port,
    profile.username.trim(), profile.auth,
    profile.auth === 'key' ? (profile.privateKeyPath || '').trim() : '',
  ]);
}

export function sameConnection(a: HostProfile, b: HostProfile): boolean {
  return a.id === b.id && connectionIdentity(a) === connectionIdentity(b);
}
