import assert from 'node:assert/strict';
import {test} from 'node:test';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {CredentialStore,type CredentialCipher} from '../src/main/credential-store';
import type {HostProfile} from '../src/shared/types';

const profile:HostProfile={id:'fixture',name:'Fixture',host:'example.invalid',port:22,username:'tester',auth:'password',rememberHost:true,encoding:'utf8'};
function fixtureCipher():CredentialCipher&{enabled:boolean;failEncrypt:boolean}{
  const key=randomBytes(32);
  return{enabled:true,failEncrypt:false,async available(){return this.enabled;},async encrypt(value){
    if(this.failEncrypt)throw new Error('fixture failure');
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),bytes]);
  },async decrypt(value){const decipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8');}};
}
async function fixture(t:{after:(callback:()=>Promise<void>)=>void}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gooeshell-credential-test-'));
  t.after(async()=>{for(const name of await fs.readdir(root))await fs.unlink(path.join(root,name));await fs.rmdir(root);});
  const cipher=fixtureCipher();return{root,cipher,store:new CredentialStore(root,cipher),file:path.join(root,'credentials.encrypted.json')};
}
test('persistent credentials survive a broker restart with ciphertext only on disk and status never returns secrets',async t=>{
  const {root,cipher,store,file}=await fixture(t);
  await store.save(profile,{remember:'persistent',password:'fixture-login-secret',passphrase:'fixture-key-secret',sudoPassword:'fixture-root-secret',sudoUsesLogin:false});
  const disk=await fs.readFile(file,'utf8');for(const secret of ['fixture-login-secret','fixture-key-secret','fixture-root-secret'])assert(!disk.includes(secret));
  const restarted=new CredentialStore(root,cipher);
  assert.deepEqual(await restarted.get(profile),{remember:'persistent',password:'fixture-login-secret',passphrase:'fixture-key-secret',sudoPassword:'fixture-root-secret',sudoUsesLogin:false});
  assert.deepEqual(await restarted.status(profile),{remember:'persistent',hasPassword:true,hasPassphrase:true,hasSudoPassword:true,sudoUsesLogin:false,secureStorageAvailable:true});
  if(process.platform!=='win32')assert.equal((await fs.stat(file)).mode&0o777,0o600);
});
test('session credentials support reconnect but neither process restart nor forgetting retains them',async t=>{
  const {root,cipher,store,file}=await fixture(t);
  await store.save(profile,{remember:'session',password:'session-only-secret',sudoUsesLogin:true});
  assert.equal((await store.get(profile)).password,'session-only-secret');
  assert.equal((await store.status(profile)).hasSudoPassword,true);
  assert.equal((await new CredentialStore(root,cipher).get(profile)).password,undefined);
  assert(!(await fs.readFile(file,'utf8')).includes('session-only-secret'));
  store.clearMemory();assert.equal((await store.get(profile)).password,undefined);
});
test('renaming preserves credentials but changing endpoint, account, auth, key path or connection id cannot borrow them',async t=>{
  const {store}=await fixture(t);
  await store.save(profile,{remember:'persistent',password:'identity-secret',sudoUsesLogin:true});
  assert.equal((await store.get({...profile,name:'Renamed',icon:'cloud',groupId:'group'})).password,'identity-secret');
  for(const changes of [{id:'other'},{host:'other.invalid'},{port:2222},{username:'other'},{auth:'agent' as const},{auth:'key' as const,privateKeyPath:'/key'}]){
    assert.equal((await store.get({...profile,...changes})).password,undefined);
  }
  const keyProfile={...profile,auth:'key' as const,privateKeyPath:'/first-key'};
  await store.save(keyProfile,{remember:'session',passphrase:'keyphrase',sudoUsesLogin:false});
  assert.equal((await store.get({...keyProfile,privateKeyPath:'/second-key'})).passphrase,undefined);
  await store.invalidate({...keyProfile,privateKeyPath:'/second-key'});
  assert.equal((await store.get(keyProfile)).passphrase,undefined);
});
test('changing identity permanently invalidates old persistent secrets even if the address later changes back',async t=>{
  const {store}=await fixture(t);
  await store.save(profile,{remember:'persistent',password:'old-device',sudoUsesLogin:true});
  await store.invalidate({...profile,username:'replacement'});
  assert.equal((await store.get(profile)).password,undefined);
});
test('partial settings preserve matching secrets, explicit blank clears, never clears even with a locked keyring',async t=>{
  const {store,cipher,file}=await fixture(t);
  await store.save(profile,{remember:'persistent',password:'login',sudoPassword:'separate-sudo',sudoUsesLogin:false});
  await store.save(profile,{remember:'persistent',sudoUsesLogin:true});
  assert.equal((await store.get(profile)).password,'login');
  await store.save(profile,{remember:'persistent',password:'',sudoUsesLogin:false});
  assert.equal((await store.get(profile)).password,undefined);
  assert.equal((await store.get(profile)).sudoPassword,'separate-sudo');
  cipher.enabled=false;
  await store.save(profile,{remember:'never',sudoUsesLogin:true});
  assert.equal((await store.get(profile)).sudoPassword,undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')).records,[]);
});
test('unavailable encryption is rejected without plaintext fallback and session mode remains available',async t=>{
  const {store,cipher,root,file}=await fixture(t);cipher.enabled=false;
  await assert.rejects(store.save(profile,{remember:'persistent',password:'never-on-disk',sudoUsesLogin:true}),/CREDENTIAL_STORAGE_UNAVAILABLE/);
  assert.deepEqual(await fs.readdir(root),[]);
  await store.save(profile,{remember:'session',password:'session-safe',sudoUsesLogin:true});
  assert.equal((await store.get(profile)).password,'session-safe');
  assert(!(await fs.readFile(file,'utf8')).includes('session-safe'));
});
test('failed encryption preserves previous encrypted credentials and concurrent saves do not lose entries',async t=>{
  const {store,cipher}=await fixture(t);
  await store.save(profile,{remember:'persistent',password:'working',sudoUsesLogin:true});
  cipher.failEncrypt=true;
  await assert.rejects(store.save(profile,{remember:'persistent',password:'replacement',sudoUsesLogin:true}),/CREDENTIAL_ENCRYPT_FAILED/);
  assert.equal((await store.get(profile)).password,'working');
  cipher.failEncrypt=false;
  await Promise.all(Array.from({length:8},(_,index)=>store.save({...profile,id:'fixture-'+index},{remember:'persistent',password:'password-'+index,sudoUsesLogin:true})));
  for(let index=0;index<8;index++)assert.equal((await store.get({...profile,id:'fixture-'+index})).password,'password-'+index);
});
test('a ciphertext copied onto another connection cannot be decrypted as that connection',async t=>{
  const {store,file}=await fixture(t);const other={...profile,id:'other',host:'second.invalid'};
  await store.save(profile,{remember:'persistent',password:'first',sudoUsesLogin:true});
  await store.save(other,{remember:'persistent',password:'second',sudoUsesLogin:true});
  const document=JSON.parse(await fs.readFile(file,'utf8'));document.records[1].encrypted=document.records[0].encrypted;
  await fs.writeFile(file,JSON.stringify(document));
  await assert.rejects(store.get(other),/CREDENTIAL_DECRYPT_FAILED/);
  await store.forget(other.id);assert.equal((await store.get(other)).password,undefined);
});
test('corrupt storage never silently replaces other saved entries',async t=>{
  const {store,file}=await fixture(t);await fs.writeFile(file,'not valid json');
  await assert.rejects(store.save(profile,{remember:'session',password:'new',sudoUsesLogin:true}),/CREDENTIAL_STORAGE_READ_FAILED/);
  assert.equal(await fs.readFile(file,'utf8'),'not valid json');
});
test('authentication snapshots cannot restore credentials after forgetting or an identity round trip',async t=>{
  const {store}=await fixture(t);const update={remember:'persistent' as const,password:'old-auth-secret',sudoUsesLogin:true};
  let snapshot=await store.prepareConnect(profile,update);
  await store.forget(profile.id);
  assert.equal(await store.saveIfUnchanged(profile,update,snapshot.revision),false);
  assert.equal((await store.get(profile)).password,undefined);
  snapshot=await store.prepareConnect(profile,update);
  await store.invalidate({...profile,host:'replacement.invalid'});await store.invalidate(profile);
  assert.equal(await store.saveIfUnchanged(profile,update,snapshot.revision),false);
  const startedAt=store.connectClock();await store.forget(profile.id);
  snapshot=await store.prepareConnect(profile,update);
  assert.equal(await store.saveIfUnchanged(profile,update,snapshot.revision,()=>true,startedAt),false,'forget during canonical profile lookup must also invalidate a later snapshot');
});
test('metadata edits and changes to another connection do not prevent a valid credential commit',async t=>{
  const {store}=await fixture(t);const update={remember:'session' as const,password:'valid-login',sudoUsesLogin:true};
  const startedAt=store.connectClock(),snapshot=await store.prepareConnect(profile,update);
  await store.invalidate({...profile,name:'New name',groupId:'group'});await store.forget('other-connection');
  assert.equal(await store.saveIfUnchanged(profile,update,snapshot.revision,()=>true,startedAt),true);
  assert.equal((await store.get(profile)).password,'valid-login');
});
test('cancelling while system encryption is pending never commits the new credentials',async t=>{
  const {store,cipher,file}=await fixture(t);
  await store.save(profile,{remember:'persistent',password:'previous-working',sudoUsesLogin:true});
  const update={remember:'persistent' as const,password:'cancelled-password',sudoUsesLogin:true};
  const snapshot=await store.prepareConnect(profile,update);const original=await fs.readFile(file,'utf8');
  const encrypt=cipher.encrypt.bind(cipher);let release!:()=>void,entered!:()=>void,cancelled=false;
  const started=new Promise<void>(resolve=>entered=resolve);const waiting=new Promise<void>(resolve=>release=resolve);
  cipher.encrypt=async value=>{entered();await waiting;return encrypt(value);};
  const saving=store.saveIfUnchanged(profile,update,snapshot.revision,()=>!cancelled);
  await started;cancelled=true;release();assert.equal(await saving,false);
  assert.equal(await fs.readFile(file,'utf8'),original);assert.equal((await store.get(profile)).password,'previous-working');
});
