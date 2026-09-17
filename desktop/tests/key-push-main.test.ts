import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fixtureEd25519Pair } from './fixtures/ssh-key-pairs';
import { identityMainHarness, waitUntil } from './fixtures/identity-main-harness';
import type { HostProfile } from '../src/shared/types';

const base: HostProfile = { id: 'key-target', name: 'Target', host: 'target.invalid', port: 22, username: 'alice', auth: 'password', rememberHost: true, encoding: 'utf8' };
const pair = fixtureEd25519Pair();
type Harness = Awaited<ReturnType<typeof identityMainHarness>>;
async function selected(h: Harness, encrypted = false) {
  const key = encrypted ? fixtureEd25519Pair({ passphrase: 'fixture-key-passphrase', cipher: 'aes256-ctr', rounds: 4 }) : pair;
  const privateKeyPath = path.join(h.root, 'fixture-private');
  await fs.writeFile(privateKeyPath, key.private);
  return { ...(await h.call('prepareSshKey', { path: privateKeyPath, ...(encrypted ? { passphrase: 'fixture-key-passphrase' } : {}) })), privateKeyPath };
}
const request = (profile: HostProfile, keyId: string, attemptId: string) => ({ profile, keyId, attemptId, credentials: { remember: 'session', sudoUsesLogin: true, password: 'fixture-login-password' } });

test('main key cancellation before preparation, during worker operation, and immediately before reply cannot issue an applicable token', async t => {
  const h = await identityMainHarness(t), key = await selected(h);
  for (const stage of ['preparation', 'worker', 'reply']) {
    if (stage === 'worker') h.keys.hold();
    let cancelReply: Promise<unknown> | undefined;
    if (stage === 'reply') h.keys.beforeReply(() => { cancelReply = h.call('cancelSshKeyPush', stage); });
    const pending = h.call('pushSshKey', request(base, key.keyId, stage));
    const rejected = assert.rejects(pending, /CONNECTION_CANCELLED/);
    if (stage === 'preparation') {
      await h.call('cancelSshKeyPush', stage);
    } else if (stage === 'worker') {
      await waitUntil(() => h.keys.pending() === 1);
      await h.call('cancelSshKeyPush', stage); await h.call('cancelSshKeyPush', stage);
      h.keys.release(); // Deliberately simulate a worker that returns late success despite cancellation.
    }
    await rejected; await cancelReply; h.keys.beforeReply();
  }
  assert(!h.calls.some(call => call.method === 'pushSshKey' && call.args[0].attemptId === 'preparation'));
  assert.equal((await h.call('connections')).connections.length, 0);
  assert.equal(h.calls.filter(call => call.method === 'connect' || call.method === 'disconnect').length, 0);
  await assert.rejects(h.call('applyVerifiedSshKey', { verificationId: 'not-issued' }), /SSH_KEY_VERIFICATION_EXPIRED/);
});

test('main key verification token expires, rejects unverified/public-only results, and is single-use', async t => {
  const h = await identityMainHarness(t), key = await selected(h);
  h.keys.result({ installed: true, alreadyPresent: false, verified: false, verificationError: 'fixture denied' });
  assert.equal((await h.call('pushSshKey', request(base, key.keyId, 'failed'))).verificationId, undefined);
  const pubFile = path.join(h.root, 'fixture-public.pub'); await fs.writeFile(pubFile, pair.public);
  const pub = await h.call('prepareSshKey', { path: pubFile });
  h.keys.result({ installed: true, alreadyPresent: false, verified: true });
  assert.equal((await h.call('pushSshKey', request(base, pub.keyId, 'pub-only'))).verificationId, undefined, 'main refuses a public-only verification claim even from the worker');
  const stale = await h.call('pushSshKey', request(base, key.keyId, 'expired'));
  h.advanceTime(10 * 60_000 + 1);
  await assert.rejects(h.call('applyVerifiedSshKey', { verificationId: stale.verificationId }), /SSH_KEY_VERIFICATION_EXPIRED/);
  h.advanceTime(-10 * 60_000 - 1);
  const valid = await h.call('pushSshKey', request(base, key.keyId, 'fresh'));
  const applied = await h.call('applyVerifiedSshKey', { verificationId: valid.verificationId });
  assert.equal(applied.auth, 'key');
  await assert.rejects(h.call('applyVerifiedSshKey', { verificationId: valid.verificationId }), /SSH_KEY_VERIFICATION_EXPIRED/);
});

test('main key token rejects edited and deleted connections without replacing their current configuration', async t => {
  const h = await identityMainHarness(t), key = await selected(h);
  const saved = await h.call('saveConnection', { profile: base, favorite: true });
  const first = await h.call('pushSshKey', request(saved, key.keyId, 'before-edit'));
  const replacement = await h.call('saveConnection', { profile: { ...saved, host: 'replacement.invalid' }, favorite: true });
  await assert.rejects(h.call('applyVerifiedSshKey', { verificationId: first.verificationId }), /CONNECTION_IDENTITY_CHANGED/);
  assert.equal((await h.call('connections')).connections[0].host, replacement.host);
  const second = await h.call('pushSshKey', request(replacement, key.keyId, 'before-delete'));
  await h.call('deleteConnection', replacement.id);
  await assert.rejects(h.call('applyVerifiedSshKey', { verificationId: second.verificationId }), /SSH_KEY_VERIFICATION_EXPIRED|CONNECTION_IDENTITY_CHANGED/);
  assert.equal((await h.call('connections')).connections.length, 0);
});

test('main key token rejects changed target and jump identity versions, and deleted unsaved identity references', async t => {
  const h = await identityMainHarness(t), key = await selected(h);
  let target = await h.call('saveLoginIdentity', { name: 'Target', username: 'alice', password: 'target-password', remember: 'session' });
  let hop = await h.call('saveLoginIdentity', { name: 'Hop', username: 'gateway', password: 'hop-password', remember: 'session' });
  const profile = await h.call('saveConnection', { profile: { ...base, loginIdentityId: target.id, jumpHost: { id: 'gateway', name: 'Gateway', host: 'hop.invalid', port: 22, username: 'gateway', auth: 'password', rememberHost: true, reuseConnection: true, loginIdentityId: hop.id } }, favorite: true });
  const beforeTarget = await h.call('pushSshKey', { profile, keyId: key.keyId, attemptId: 'target-version' });
  target = await h.call('saveLoginIdentity', { id: target.id, expectedVersion: target.version, name: target.name, username: 'new-alice', password: 'changed-target', remember: 'session' });
  await assert.rejects(h.call('applyVerifiedSshKey', { verificationId: beforeTarget.verificationId }), /CONNECTION_IDENTITY_CHANGED/);
  const beforeHop = await h.call('pushSshKey', { profile, keyId: key.keyId, attemptId: 'hop-version' });
  hop = await h.call('saveLoginIdentity', { id: hop.id, expectedVersion: hop.version, name: hop.name, username: hop.username, password: 'changed-hop', remember: 'session' });
  await assert.rejects(h.call('applyVerifiedSshKey', { verificationId: beforeHop.verificationId }), /CONNECTION_IDENTITY_CHANGED/);
  const temporary = await h.call('saveLoginIdentity', { name: 'Unsaved', username: 'temporary', password: 'temporary', remember: 'session' });
  const unsaved = await h.call('pushSshKey', { profile: { ...base, id: 'unsaved', host: 'unsaved.invalid', loginIdentityId: temporary.id }, keyId: key.keyId, attemptId: 'deleted-identity' });
  await h.call('deleteLoginIdentity', temporary.id);
  await assert.rejects(h.call('applyVerifiedSshKey', { verificationId: unsaved.verificationId }), /LOGIN_IDENTITY_NOT_FOUND/);
  assert.equal((await h.call('connections')).connections.length, 1);
});

test('main key apply rechecks the on-disk private key and rejects a substituted key or public-only file', async t => {
  const h = await identityMainHarness(t), key = await selected(h);
  const saved = await h.call('saveConnection', { profile: base, favorite: true });
  const result = await h.call('pushSshKey', request(saved, key.keyId, 'disk-change'));
  await fs.writeFile(key.privateKeyPath, fixtureEd25519Pair().private);
  await assert.rejects(h.call('applyVerifiedSshKey', { verificationId: result.verificationId }), /SSH_KEY_CHANGED/);
  await fs.writeFile(key.privateKeyPath, pair.public);
  await assert.rejects(h.call('applyVerifiedSshKey', { verificationId: result.verificationId }), /SSH_KEY_CHANGED/);
  assert.equal((await h.call('connections')).connections[0].auth, 'password');
});

test('main successful key apply affects one connection, preserves jump and other shared references, and defaults encrypted key passphrase to session memory', async t => {
  const h = await identityMainHarness(t), key = await selected(h, true);
  const target = await h.call('saveLoginIdentity', { name: 'Target', username: 'alice', password: 'shared-login', remember: 'persistent' });
  const hop = await h.call('saveLoginIdentity', { name: 'Hop', username: 'gateway', password: 'shared-hop', remember: 'session' });
  const jumpHost = { id: 'gateway', name: 'Gateway', host: 'hop.invalid', port: 2222, username: 'gateway', auth: 'password', rememberHost: true, reuseConnection: true, loginIdentityId: hop.id };
  const first = await h.call('saveConnection', { profile: { ...base, loginIdentityId: target.id, jumpHost }, favorite: true });
  const other = await h.call('saveConnection', { profile: { ...base, id: 'other', host: 'other.invalid', loginIdentityId: target.id, jumpHost }, favorite: true });
  const active = await h.call('connect', { profile: first, attemptId: 'existing-terminal' });
  const beforeIdentities = JSON.stringify(await h.call('listLoginIdentities'));
  const result = await h.call('pushSshKey', { profile: first, keyId: key.keyId, attemptId: 'install' });
  const transport = h.calls.find(call => call.method === 'pushSshKey')!.args[0];
  assert.equal(transport.password, 'shared-login'); assert.equal(transport.jumpPassword, 'shared-hop');
  assert.equal(transport.profile.jumpHost.port, 2222); assert.equal(transport.key.passphrase, 'fixture-key-passphrase');
  const applied = await h.call('applyVerifiedSshKey', { verificationId: result.verificationId });
  assert.equal(applied.id, first.id); assert.equal(applied.auth, 'key'); assert.equal(applied.loginIdentityId, undefined);
  assert.equal(applied.privateKeyPath, key.privateKeyPath); assert.equal(JSON.stringify(applied.jumpHost), JSON.stringify(first.jumpHost));
  const catalog = await h.call('connections'); assert.equal(catalog.profiles.length, 2);
  assert.equal(catalog.connections.find((item: HostProfile) => item.id === other.id).loginIdentityId, target.id);
  const identities = await h.call('listLoginIdentities'); assert.equal(identities.identities.find((item: any) => item.id === target.id).version, target.version);
  assert.equal(identities.identities.find((item: any) => item.id === target.id).references.length, 1);
  assert.equal(identities.identities.find((item: any) => item.id === hop.id).references.length, 2);
  assert.notEqual(JSON.stringify(identities), beforeIdentities); // Only reference metadata changes.
  const status = await h.call('credentialStatus', applied); assert.equal(status.remember, 'session'); assert.equal(status.hasPassphrase, true);
  await h.call('sendSudoPassword', { sessionId: active.id, submit: false });
  assert.equal(h.calls.at(-1)!.args[1], 'shared-login');
  assert.equal(h.calls.filter(call => call.method === 'disconnect').length, 0); assert.equal(active.profile.auth, 'password');
  for (const file of ['connections.json', 'credentials.encrypted.json', 'login-identities.json']) {
    const contents = await fs.readFile(path.join(h.root, file), 'utf8');
    for (const secret of ['fixture-key-passphrase', 'shared-login', 'shared-hop']) assert(!contents.includes(secret));
  }
  await h.call('connect', { profile: other, attemptId: 'other-still-shared' });
  assert.equal(h.calls.filter(call => call.method === 'connect').at(-1)!.args[0].password, 'shared-login');
});

test('main unencrypted key apply preserves the former shared login as session-only sudo for the next key-authenticated terminal', async t => {
  const h = await identityMainHarness(t), key = await selected(h);
  const identity = await h.call('saveLoginIdentity', { name: 'Shared', username: 'alice', password: 'shared-sudo-password', remember: 'persistent' });
  const original = await h.call('saveConnection', { profile: { ...base, loginIdentityId: identity.id }, favorite: true });
  const verified = await h.call('pushSshKey', { profile: original, keyId: key.keyId, attemptId: 'unencrypted' });
  const profile = await h.call('applyVerifiedSshKey', { verificationId: verified.verificationId });
  const status = await h.call('credentialStatus', profile);
  assert.equal(status.remember, 'session'); assert.equal(status.hasSudoPassword, true); assert.equal(status.sudoUsesLogin, false);
  const connected = await h.call('connect', { profile, attemptId: 'next-key-login' });
  await h.call('sendSudoPassword', { sessionId: connected.id, submit: false });
  assert.equal(h.calls.at(-1)!.args[1], 'shared-sudo-password');
  assert(!(await fs.readFile(path.join(h.root, 'credentials.encrypted.json'), 'utf8')).includes('shared-sudo-password'));
});
