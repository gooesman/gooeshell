import assert from 'node:assert/strict';
import {test} from 'node:test';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {identityMainHarness,waitUntil} from './fixtures/identity-main-harness';
import type {HostProfile} from '../src/shared/types';

const base:HostProfile={id:'saved',name:'Server',host:'target.invalid',port:22,username:'stale-ui-value',auth:'password',rememberHost:true,encoding:'utf8'};
test('main resolves latest shared usernames, preserves saved IDs and sends sudo with the active login snapshot',async t=>{
 const h=await identityMainHarness(t),identity=await h.call('saveLoginIdentity',{name:'Shared',username:'alice',password:'first-password',remember:'session'});
 const profile=await h.call('saveConnection',{profile:{...base,loginIdentityId:identity.id},favorite:true});assert.equal(profile.username,'alice');
 const connected=await h.call('connect',{profile,attemptId:'first'});assert.equal(connected.profile.id,base.id);assert.equal(connected.profile.username,'alice');
 const firstCall=h.calls.find(call=>call.method==='connect')!;assert.equal(firstCall.args[0].password,'first-password');
 await h.call('saveLoginIdentity',{id:identity.id,name:'Shared',username:'bob',password:'second-password',remember:'session',expectedVersion:identity.version});
 const catalog=await h.call('connections');assert.equal(catalog.connections[0].username,'bob');assert.equal(catalog.connections.length,1);
 await h.call('sendSudoPassword',{sessionId:connected.id,submit:true});assert.equal(h.calls.at(-1)?.args[1],'first-password\r');
 const second=await h.call('connect',{profile,attemptId:'second'});assert.equal(second.profile.id,base.id);assert.equal(second.profile.username,'bob');assert.equal(h.calls.filter(call=>call.method==='connect').at(-1)?.args[0].password,'second-password');
 assert.equal(connected.profile.username,'alice');assert.equal((await h.call('listLoginIdentities')).identities[0].references.length,1);
});
test('main retry passwords are temporary unless explicitly updating shared identity and remember never changes it',async t=>{
 const h=await identityMainHarness(t),identity=await h.call('saveLoginIdentity',{name:'Shared',username:'alice',password:'library-original',remember:'persistent'}),profile=await h.call('saveConnection',{profile:{...base,loginIdentityId:identity.id},favorite:true});
 await h.call('connect',{profile,attemptId:'temporary',credentials:{remember:'never',password:'temporary-only',sudoUsesLogin:true}});
 await h.call('connect',{profile,attemptId:'unchanged'});assert.equal(h.calls.filter(call=>call.method==='connect').at(-1)?.args[0].password,'library-original');
 await h.call('connect',{profile,attemptId:'explicit',credentials:{remember:'session',password:'verified-new',sudoUsesLogin:true,updateSharedIdentity:true}});
 await h.call('connect',{profile,attemptId:'updated'});assert.equal(h.calls.filter(call=>call.method==='connect').at(-1)?.args[0].password,'verified-new');
 const status=await h.call('credentialStatus',profile);assert.equal(status.remember,'persistent');assert.equal(status.hasSudoPassword,true);
 for(const file of ['connections.json','credentials.encrypted.json','login-identities.json']){const contents=await fs.readFile(path.join(h.root,file),'utf8');for(const secret of ['temporary-only','library-original','verified-new'])assert(!contents.includes(secret));}
});
test('main target and jump shared identities remain independent and ignore caller jumpPassword transport fields',async t=>{
 const h=await identityMainHarness(t),target=await h.call('saveLoginIdentity',{name:'Target',username:'target-user',password:'target-password',remember:'session'}),hop=await h.call('saveLoginIdentity',{name:'Hop',username:'hop-user',password:'hop-password',remember:'session'});
 const profile=await h.call('saveConnection',{profile:{...base,loginIdentityId:target.id,jumpHost:{id:'hop',name:'Gateway',host:'hop.invalid',port:22,username:'stale-hop',auth:'password',rememberHost:true,reuseConnection:true,loginIdentityId:hop.id}},favorite:true});
 const connected=await h.call('connect',{profile,attemptId:'jump',jumpPassword:'untrusted-transport-override'}),request=h.calls.find(call=>call.method==='connect')!.args[0];assert.equal(request.password,'target-password');assert.equal(request.jumpPassword,'hop-password');assert.equal(request.profile.jumpHost.username,'hop-user');
 await h.call('saveLoginIdentity',{id:hop.id,name:'Hop',username:'next-hop-user',password:'next-hop-password',remember:'session',expectedVersion:hop.version});
 await h.call('connect',{profile,attemptId:'next-jump'});const next=h.calls.filter(call=>call.method==='connect').at(-1)!.args[0];assert.equal(next.profile.id,profile.id);assert.equal(next.profile.jumpHost.username,'next-hop-user');assert.equal(connected.profile.jumpHost.username,'hop-user');assert.equal(next.jumpPassword,'next-hop-password');
 await assert.rejects(h.call('deleteLoginIdentity',hop.id),/LOGIN_IDENTITY_IN_USE/);
});
test('main late shared authentication cannot overwrite a concurrent edit or recreate a deleted identity',async t=>{
 const h=await identityMainHarness(t),identity=await h.call('saveLoginIdentity',{name:'Shared',username:'alice',password:'old',remember:'session'}),profile={...base,loginIdentityId:identity.id};
 h.hold();const pending=h.call('connect',{profile,attemptId:'late',credentials:{remember:'session',password:'late-overwrite',sudoUsesLogin:true,updateSharedIdentity:true}});await waitUntil(()=>h.pending()===1);
 const edited=await h.call('saveLoginIdentity',{id:identity.id,name:'New',username:'bob',password:'new',remember:'session',expectedVersion:identity.version});h.release();const active=await pending;assert.equal(active.profile.username,'alice');
 await h.call('connect',{profile,attemptId:'after-edit'});assert.equal(h.calls.filter(call=>call.method==='connect').at(-1)?.args[0].password,'new');
 const other=await h.call('saveLoginIdentity',{name:'Unsaved',username:'temporary',password:'temporary',remember:'session'});
 h.hold();const deleted=h.call('connect',{profile:{...base,id:'unsaved',host:'unsaved.invalid',loginIdentityId:other.id},attemptId:'delete-inflight',credentials:{remember:'session',password:'must-not-revive',sudoUsesLogin:true,updateSharedIdentity:true}});await waitUntil(()=>h.pending()===1);await h.call('deleteLoginIdentity',other.id);h.release();await deleted;
 const list=await h.call('listLoginIdentities');assert.equal(list.identities.length,1);assert.equal(list.identities[0].version,edited.version);assert(!(await h.call('connections')).connections.some((item:HostProfile)=>item.loginIdentityId===other.id));
});
test('main cancelling shared authentication is idempotent and commits no password or catalog',async t=>{
 const h=await identityMainHarness(t),identity=await h.call('saveLoginIdentity',{name:'Shared',username:'alice',password:'original',remember:'session'});
 h.hold();const pending=h.call('connect',{profile:{...base,loginIdentityId:identity.id},attemptId:'cancel',credentials:{remember:'session',password:'cancelled-value',sudoUsesLogin:true,updateSharedIdentity:true}});const rejected=assert.rejects(pending,/CONNECTION_CANCELLED/);await waitUntil(()=>h.pending()===1);
 await h.call('cancelConnect','cancel');await h.call('cancelConnect','cancel');await rejected;assert.equal((await h.call('connections')).connections.length,0);assert.equal((await h.call('listLoginIdentities')).identities[0].version,identity.version);
 h.release();await h.call('connect',{profile:{...base,loginIdentityId:identity.id},attemptId:'retry'});assert.equal(h.calls.filter(call=>call.method==='connect').at(-1)?.args[0].password,'original');
});
test('main serializes saving references against identity deletion and does not delete independent secrets',async t=>{
 const h=await identityMainHarness(t),identity=await h.call('saveLoginIdentity',{name:'Shared',username:'alice',password:'shared',remember:'session'});
 await h.call('saveConnection',{profile:{...base,id:'independent'},favorite:true,credentials:{remember:'session',password:'independent-secret',sudoUsesLogin:true}});
 const results=await Promise.allSettled([h.call('saveConnection',{profile:{...base,loginIdentityId:identity.id},favorite:true}),h.call('deleteLoginIdentity',identity.id)]);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
 await h.call('deleteConnection',base.id);await h.call('deleteLoginIdentity',identity.id);const independent=(await h.call('connections')).connections[0];await h.call('connect',{profile:independent,attemptId:'independent'});assert.equal(h.calls.filter(call=>call.method==='connect').at(-1)?.args[0].password,'independent-secret');
});
test('main can use a temporary shared password while the system keyring is locked',async t=>{
 const h=await identityMainHarness(t),identity=await h.call('saveLoginIdentity',{name:'Shared',username:'alice',password:'stored-password',remember:'persistent'});
 const profile=await h.call('saveConnection',{profile:{...base,loginIdentityId:identity.id},favorite:true,credentials:{remember:'persistent',sudoUsesLogin:true}});
 h.cipher.enabled=false;const status=await h.call('credentialStatus',profile);assert.equal(status.secureStorageAvailable,false);
 await h.call('connect',{profile,attemptId:'locked-override',credentials:{remember:'persistent',sudoUsesLogin:true,password:'temporary-password'}});assert.equal(h.calls.filter(call=>call.method==='connect').at(-1)?.args[0].password,'temporary-password');
 assert.equal((await h.call('listLoginIdentities')).identities[0].version,identity.version);h.cipher.enabled=true;
 await h.call('connect',{profile,attemptId:'unlocked'});assert.equal(h.calls.filter(call=>call.method==='connect').at(-1)?.args[0].password,'stored-password');
});
test('main keeps independent sudo memory separate from shared identity memory in both directions',async t=>{
 const h=await identityMainHarness(t);
 for(const [index,identityRemember,sudoRemember] of [[0,'persistent','session'],[1,'session','persistent']] as const){
  const identity=await h.call('saveLoginIdentity',{name:'Shared-'+index,username:'alice',password:'login-'+index,remember:identityRemember});
  const profile=await h.call('saveConnection',{profile:{...base,id:'sudo-'+index,loginIdentityId:identity.id},favorite:true,credentials:{remember:sudoRemember,sudoUsesLogin:false,sudoPassword:'sudo-'+index}});
  const status=await h.call('credentialStatus',profile);assert.equal(status.remember,sudoRemember);assert.equal(status.sudoUsesLogin,false);
  await h.call('saveConnection',{profile:{...profile,name:'Renamed'},favorite:true,credentials:{remember:status.remember,sudoUsesLogin:status.sudoUsesLogin}});assert.equal((await h.call('credentialStatus',profile)).remember,sudoRemember);
  if(sudoRemember==='persistent'){
   h.cipher.enabled=false;const lockedStatus=await h.call('credentialStatus',profile);assert.equal(lockedStatus.sudoUsesLogin,false);
   await h.call('connect',{profile,attemptId:'locked-sudo',credentials:{remember:lockedStatus.remember,sudoUsesLogin:false,password:'temporary'}});h.cipher.enabled=true;
   const connected=await h.call('connect',{profile,attemptId:'preserved-sudo'});await h.call('sendSudoPassword',{sessionId:connected.id,submit:false});assert.equal(h.calls.at(-1)?.args[1],'sudo-'+index);
  }
 }
});
