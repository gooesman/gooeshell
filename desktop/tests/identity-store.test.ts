import assert from 'node:assert/strict';
import {test} from 'node:test';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {IdentityStore} from '../src/main/identity-store';
import {CredentialStore,type CredentialCipher} from '../src/main/credential-store';
import {resolveLoginIdentities,resolveIdentityMetadata,connectionCredentialUpdate} from '../src/main/identity-resolver';
import {Store,cleanProfile} from '../src/main/store';
import {jumpCredentialProfile} from '../src/main/jump-profile';
import {connectionIdentity,connectionConfigurationIdentity} from '../src/shared/connections';
import type {HostProfile} from '../src/shared/types';

const base:HostProfile={id:'connection-a',name:'Fixture',host:'fixture.invalid',port:22,username:'independent',auth:'password',rememberHost:true,encoding:'utf8'};
function cipher():CredentialCipher&{enabled:boolean;failEncrypt:boolean}{
 const key=randomBytes(32);return{enabled:true,failEncrypt:false,async available(){return this.enabled;},async encrypt(text){if(this.failEncrypt)throw new Error('fixture encryption failure');const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(text,'utf8'),c.final(),c.getAuthTag()]);},async decrypt(bytes){const d=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));d.setAuthTag(bytes.subarray(-16));return Buffer.concat([d.update(bytes.subarray(12,-16)),d.final()]).toString('utf8');}};
}
async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gooeshell-identity-test-'));t.after(async()=>{for(const name of await fs.readdir(root))await fs.unlink(path.join(root,name));await fs.rmdir(root);});
 const encryption=cipher();return{root,encryption,identities:new IdentityStore(root,encryption),file:path.join(root,'login-identities.json'),connections:new Store(root),credentials:new CredentialStore(root,encryption)};
}
test('identity metadata survives a cold start while session password does not',async t=>{
 const {root,encryption,identities,file}=await fixture(t),saved=await identities.save({name:'测试身份',username:'alice',password:'session-password',remember:'session'});
 assert.equal((await identities.snapshot(saved.id)).password,'session-password');assert.equal((await identities.list()).identities[0].hasPassword,true);
 const restarted=new IdentityStore(root,encryption);assert.equal((await restarted.snapshot(saved.id)).password,undefined);
 assert.equal((await restarted.list()).identities[0].hasPassword,false);assert.equal((await restarted.list()).identities[0].name,'测试身份');assert(!(await fs.readFile(file,'utf8')).includes('session-password'));
});
test('persistent identity passwords are encrypted with an independent namespace and no renderer secrets',async t=>{
 const {root,encryption,identities,file}=await fixture(t),saved=await identities.save({name:'Production',username:'admin',password:'persistent-password',remember:'persistent'});
 assert.equal((await new IdentityStore(root,encryption).snapshot(saved.id)).password,'persistent-password');
 assert(!(await fs.readFile(file,'utf8')).includes('persistent-password'));assert(!JSON.stringify(await identities.list()).includes('persistent-password'));
 assert.equal(saved.hasPassword,true);assert.equal(Object.hasOwn(saved,'encrypted'),false);assert.equal(Object.hasOwn(saved,'password'),false);
});
test('identity edits preserve undefined passwords, allow clearing and use optimistic versions',async t=>{
 const {identities}=await fixture(t);const first=await identities.save({name:'Shared',username:'alice',password:'same-password',remember:'session'});
 const edited=await identities.save({id:first.id,name:'Renamed',username:'bob',remember:'persistent',expectedVersion:first.version});
 assert.equal((await identities.snapshot(first.id)).password,'same-password');assert.equal(edited.username,'bob');assert.ok(edited.version>first.version);
 await assert.rejects(identities.save({id:first.id,name:'Stale',username:'alice',remember:'session',password:'stale',expectedVersion:first.version}),/LOGIN_IDENTITY_CONFLICT/);
 const cleared=await identities.save({id:first.id,name:edited.name,username:edited.username,remember:'session',password:'',expectedVersion:edited.version});
 assert.equal(cleared.hasPassword,false);assert.equal((await identities.snapshot(first.id)).password,undefined);
});
test('concurrent identity edits accept exactly one revision',async t=>{
 const {identities}=await fixture(t),first=await identities.save({name:'Original',username:'one',remember:'session'});
 const results=await Promise.allSettled(['two','three'].map(username=>identities.save({id:first.id,name:'Edited',username,remember:'session',expectedVersion:first.version})));
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected').length,1);
});
test('locked or wrong keyring does not destroy identity metadata and replacement password repairs encryption',async t=>{
 const {root,encryption,identities,file}=await fixture(t),first=await identities.save({name:'Identity',username:'alice',password:'old-secret',remember:'persistent'}),original=await fs.readFile(file,'utf8');
 encryption.enabled=false;assert.equal((await identities.list()).secureStorageAvailable,false);assert.equal((await identities.list()).identities[0].hasPassword,true);
 await assert.rejects(identities.snapshot(first.id),/CREDENTIAL_STORAGE_UNAVAILABLE/);assert.equal(await fs.readFile(file,'utf8'),original);
 const wrong=new IdentityStore(root,cipher());await assert.rejects(wrong.snapshot(first.id),/CREDENTIAL_DECRYPT_FAILED/);
 const repaired=await wrong.save({id:first.id,name:'Repaired',username:'alice',password:'new-secret',remember:'persistent',expectedVersion:first.version});assert.equal((await wrong.snapshot(first.id)).password,'new-secret');assert.ok(repaired.version>first.version);
});
test('encryption failure leaves both prior metadata and password unchanged',async t=>{
 const {identities,encryption,file}=await fixture(t),first=await identities.save({name:'Original',username:'alice',password:'old-secret',remember:'session'}),original=await fs.readFile(file,'utf8');
 encryption.failEncrypt=true;await assert.rejects(identities.save({id:first.id,name:'New',username:'bob',remember:'persistent',password:'new-secret',expectedVersion:first.version}),/CREDENTIAL_ENCRYPT_FAILED/);
 assert.equal(await fs.readFile(file,'utf8'),original);assert.equal((await identities.snapshot(first.id)).password,'old-secret');
});
test('target and jump references block deletion; unreferenced deletion works while keyring is locked',async t=>{
 const {identities,encryption}=await fixture(t),first=await identities.save({name:'Shared',username:'alice',password:'secret',remember:'persistent'});
 const profile={...base,loginIdentityId:first.id,jumpHost:{id:'gateway',name:'Gateway',host:'hop.invalid',port:2222,username:'stale',auth:'password' as const,rememberHost:true,reuseConnection:true,loginIdentityId:first.id}};
 const list=await identities.list([profile]);assert.deepEqual(list.identities[0].references.map(reference=>reference.role),['target','jump']);assert.equal(list.identities[0].references[1].port,2222);
 await assert.rejects(identities.delete(first.id,[profile]),/LOGIN_IDENTITY_IN_USE/);encryption.enabled=false;await identities.delete(first.id,[]);await identities.delete(first.id,[]);assert.equal((await identities.list()).identities.length,0);
});
test('late authentication never resurrects a deleted identity or replaces a newer username/password',async t=>{
 const {identities}=await fixture(t),first=await identities.save({name:'Shared',username:'alice',password:'old',remember:'session'}),snapshot=await identities.snapshot(first.id);
 await identities.save({id:first.id,name:'Shared',username:'bob',password:'new',remember:'session',expectedVersion:first.version});
 assert.equal(await identities.updatePasswordIfUnchanged(snapshot,'late',()=>true),false);assert.equal((await identities.snapshot(first.id)).password,'new');
 await identities.delete(first.id);assert.equal(await identities.updatePasswordIfUnchanged(snapshot,'late',()=>true),false);
 await assert.rejects(identities.save({id:first.id,name:'Revive',username:'alice',remember:'session',expectedVersion:first.version}),/LOGIN_IDENTITY_NOT_FOUND/);
});
test('explicit successful retry changes password only, preserves remember and honors cancellation',async t=>{
 const {identities}=await fixture(t),first=await identities.save({name:'Shared',username:'alice',password:'old',remember:'persistent'}),snapshot=await identities.snapshot(first.id);
 assert.equal(await identities.updatePasswordIfUnchanged(snapshot,'cancelled',()=>false),false);assert.equal((await identities.snapshot(first.id)).password,'old');
 assert.equal(await identities.updatePasswordIfUnchanged(snapshot,'verified',()=>true),true);const changed=await identities.snapshot(first.id);assert.equal(changed.password,'verified');assert.equal(changed.remember,'persistent');assert.equal(changed.username,'alice');
});
test('resolving shared target and hop creates snapshots and does not mutate configured or active profiles',async t=>{
 const {identities}=await fixture(t),target=await identities.save({name:'Target',username:'alice',password:'target-secret',remember:'session'}),hop=await identities.save({name:'Hop',username:'gateway',password:'hop-secret',remember:'session'});
 const configured=cleanProfile({...base,loginIdentityId:target.id,username:'',auth:'key',privateKeyPath:'discard-key',jumpHost:{id:'hop',name:'Hop',host:'hop.invalid',port:22,username:'',auth:'agent',rememberHost:true,reuseConnection:true,loginIdentityId:hop.id}});
 const active=await resolveLoginIdentities(identities,configured);assert.equal(active.profile.username,'alice');assert.equal(active.profile.jumpHost?.username,'gateway');assert.equal(active.target?.password,'target-secret');assert.equal(active.jump?.password,'hop-secret');assert.equal(configured.username,'');assert.equal(configured.auth,'password');
 await identities.save({id:target.id,name:target.name,username:'bob',password:'next-secret',remember:'session',expectedVersion:target.version});
 const next=await resolveLoginIdentities(identities,configured);assert.equal(next.profile.username,'bob');assert.equal(active.profile.username,'alice');assert.equal(active.target?.password,'target-secret');assert.notEqual(connectionIdentity(active.profile),connectionIdentity(next.profile));assert.equal(connectionConfigurationIdentity(active.profile),connectionConfigurationIdentity(next.profile));
});
test('canonical connections keep IDs across shared username changes without merging independent credentials',async t=>{
 const {identities,connections,credentials}=await fixture(t),identity=await identities.save({name:'Shared',username:'alice',password:'shared-secret',remember:'session'});
 const profile=(await resolveLoginIdentities(identities,{...base,loginIdentityId:identity.id})).profile;await connections.saveConnection(profile,true);
 const independent=await connections.saveConnection({...profile,id:'independent',loginIdentityId:undefined},true);assert.equal(independent.id,'independent');
 await credentials.save(independent,{remember:'session',password:'independent-secret',sudoUsesLogin:true});assert.equal((await credentials.get(profile)).password,undefined);
 await identities.save({id:identity.id,name:identity.name,username:'bob',remember:'session',expectedVersion:identity.version});
 const current=(await resolveIdentityMetadata(identities,await connections.connections())).find(item=>item.id===profile.id)!;
 const canonical=await connections.resolveConnection({...current,id:'new-id'});assert.equal(canonical.id,profile.id);await connections.recordConnection(current,true,true);assert.equal((await connections.history())[0].profile.id,profile.id);
 assert.equal((await resolveIdentityMetadata(identities,await connections.connections())).find(item=>item.id===independent.id)?.username,'alice');
});
test('per-connection and jump password updates cannot silently write shared secrets',async t=>{
 const {identities,credentials}=await fixture(t),identity=await identities.save({name:'Shared',username:'alice',password:'library-secret',remember:'session'}),profile={...base,username:'alice',loginIdentityId:identity.id};
 const update={remember:'persistent' as const,password:'one-time-override',passphrase:'unrelated',sudoUsesLogin:false,sudoPassword:'sudo-only',updateSharedIdentity:true};
 await credentials.save(profile,connectionCredentialUpdate(profile,update)!);assert.equal((await credentials.get(profile)).password,undefined);assert.equal((await credentials.get(profile)).sudoPassword,'sudo-only');assert.equal((await identities.snapshot(identity.id)).password,'library-secret');assert.equal((await identities.snapshot(identity.id)).remember,'session');
 const hop=jumpCredentialProfile({id:'hop',name:'Hop',host:'hop.invalid',port:22,username:'alice',auth:'password',loginIdentityId:identity.id,rememberHost:true,reuseConnection:true});assert.equal(hop.loginIdentityId,identity.id);assert.equal(connectionCredentialUpdate(hop,update)?.password,'');
});
test('metadata rendering works with a locked keyring; missing references fail actual resolution',async t=>{
 const {identities,encryption}=await fixture(t),identity=await identities.save({name:'Shared',username:'alice',password:'secret',remember:'persistent'}),profile={...base,loginIdentityId:identity.id};
 encryption.enabled=false;assert.equal((await resolveIdentityMetadata(identities,[profile]))[0].username,'alice');assert.equal((await resolveLoginIdentities(identities,profile,{targetPassword:false})).profile.username,'alice');
 await assert.rejects(resolveLoginIdentities(identities,profile),/CREDENTIAL_STORAGE_UNAVAILABLE/);await identities.delete(identity.id);await assert.rejects(resolveLoginIdentities(identities,profile,{targetPassword:false}),/LOGIN_IDENTITY_NOT_FOUND/);
});
test('corrupt metadata is rejected without rewriting the original file',async t=>{
 const {identities,file}=await fixture(t);const contents='{"schema":1,"revision":2,"identities":[{"id":"broken"}]}';await fs.writeFile(file,contents);await assert.rejects(identities.list(),/LOGIN_IDENTITY_DATA_INVALID/);assert.equal(await fs.readFile(file,'utf8'),contents);
});
test('cancelling during encryption never commits a new shared password',async t=>{
 const {identities,encryption,file}=await fixture(t),first=await identities.save({name:'Shared',username:'alice',password:'old',remember:'persistent'}),snapshot=await identities.snapshot(first.id),original=await fs.readFile(file,'utf8');
 const encrypt=encryption.encrypt.bind(encryption);let release!:()=>void,started!:()=>void,allowed=true;const ready=new Promise<void>(resolve=>started=resolve);
 encryption.encrypt=async text=>{started();await new Promise<void>(resolve=>release=resolve);return encrypt(text);};
 const pending=identities.updatePasswordIfUnchanged(snapshot,'cancelled',()=>allowed);await ready;allowed=false;release();assert.equal(await pending,false);assert.equal(await fs.readFile(file,'utf8'),original);assert.equal((await identities.snapshot(first.id)).password,'old');
});
test('encrypted identity passwords are bound to their ID, revision and SSH username',async t=>{
 const {identities,file}=await fixture(t),first=await identities.save({name:'Shared',username:'alice',password:'secret',remember:'persistent'}),original=JSON.parse(await fs.readFile(file,'utf8'));
 const modified=structuredClone(original);modified.identities[0].username='another-user';await fs.writeFile(file,JSON.stringify(modified));await assert.rejects(identities.snapshot(first.id),/CREDENTIAL_DECRYPT_FAILED/);
 const another=structuredClone(original);another.identities[0].id='another-identity';await fs.writeFile(file,JSON.stringify(another));await assert.rejects(identities.snapshot('another-identity'),/CREDENTIAL_DECRYPT_FAILED/);
 await fs.writeFile(file,JSON.stringify(original));assert.equal((await identities.snapshot(first.id)).password,'secret');
});
