import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Client, Server, utils} from 'ssh2';
import {Store} from '../src/main/store';
import {CredentialStore} from '../src/main/credential-store';
import {IdentityStore} from '../src/main/identity-store';
import {CommandStore} from '../src/main/command-store';
import {LocalKeyStore,generateVerifiedEd25519KeyPair} from '../src/main/local-keys';
import {jumpCredentialProfile} from '../src/main/jump-profile';
import {collectPortableConfig,importPortableConfig,validatePortableConfig,backupCatalog,selectPortableConfig} from '../src/main/portable-config';
import {encryptBackup,decryptBackup} from '../src/main/portable-backup';
import type {HostProfile} from '../src/shared/types';

const scope={settings:[],groupIds:[],identityIds:[],connectionIds:['one','two'],commands:false,secrets:true,privateKeys:true,hostPreferences:false};
const cipher={available:async()=>true,encrypt:async(s:string)=>Buffer.from(s),decrypt:async(b:Buffer)=>b.toString()};
function stores(dir:string){return [new Store(dir),new IdentityStore(dir,cipher),new CredentialStore(dir,cipher),new CommandStore(dir)] as const;}
const profile:HostProfile={id:'one',name:'One',username:'alice',host:'127.0.0.1',port:22,auth:'key',rememberHost:true,encoding:'utf8'};

test('selected private keys survive removal of originals and authenticate two restored SSH connections',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gooeshell-key-migration-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const src=stores(path.join(root,'src')), dst=stores(path.join(root,'dst'));
  const restoredKeys=new LocalKeyStore(path.join(root,'dst','keys'));
  const names=['one','two'],phrases=[undefined,'fixture-key-passphrase'];
  const pairs=await Promise.all(phrases.map(phrase=>generateVerifiedEd25519KeyPair(phrase)));
  const allowed=pairs.map(pair=>utils.parseKey(pair.public));
  const hostKey=await generateVerifiedEd25519KeyPair();
  const server=new Server({hostKeys:[hostKey.private]},peer=>{
    peer.on('error',()=>{}).on('authentication',ctx=>{
      const key=allowed[names.indexOf(ctx.username)];
      if(ctx.method!=='publickey'||!key||key instanceof Error||Array.isArray(key)||!key.getPublicSSH().equals(ctx.key.data))return ctx.reject();
      if(ctx.signature&&(!ctx.blob||!key.verify(ctx.blob,ctx.signature)))return ctx.reject();
      ctx.accept();
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>server.close());
  for(const [i,name] of names.entries()){
    const file=path.join(root,name);
    await fs.writeFile(file,pairs[i].private);
    const target={...profile,id:name,name,username:name,port:server.address().port,privateKeyPath:file};
    await src[0].saveConnection(target,true);
    if(phrases[i])await src[2].save(target,{remember:'persistent',sudoUsesLogin:true,passphrase:phrases[i]});
  }
  await src[0].saveConnection({...profile,id:'excluded',privateKeyPath:path.join(root,'absent')},true);
  const portable=await collectPortableConfig(...src,scope);
  assert.equal(portable.version,3);
  const wire=await encryptBackup(portable,'fixture-backup-password');
  assert(!wire.includes('PRIVATE KEY'));assert(!wire.includes(phrases[1]!));
  const backup=validatePortableConfig(await decryptBackup(wire,'fixture-backup-password'));
  const preview=backupCatalog(backup);
  assert(preview.connections.every(c=>c.hasPrivateKey));assert(!JSON.stringify(preview).includes('PRIVATE KEY'));
  assert.equal(Object.keys(selectPortableConfig(backup,{...scope,connectionIds:['one']}).privateKeys!).length,1);
  const withoutKeys=selectPortableConfig(backup,{...scope,privateKeys:false});
  assert.equal(withoutKeys.privateKeys,undefined);assert(!backupCatalog(withoutKeys).connections.some(c=>c.hasPrivateKey));
  assert.equal((await importPortableConfig(backup,...src,scope,new LocalKeyStore(path.join(root,'src','keys')))).skipped,2);
  const changed=structuredClone(backup);
  const [first,second]=Object.keys(changed.privateKeys!);
  changed.privateKeys![first]=changed.privateKeys![second];
  assert.throws(()=>validatePortableConfig(changed),/私钥校验失败/);
  assert.throws(()=>validatePortableConfig({...backup,version:2}),/私钥列表无效/);
  await assert.rejects(collectPortableConfig(...src,{...scope,connectionIds:['excluded']}),/无法备份/);
  assert.equal((await collectPortableConfig(...src,{...scope,privateKeys:false})).version,2);
  for(const name of names)await fs.unlink(path.join(root,name));
  assert.equal((await importPortableConfig(backup,...dst,scope,restoredKeys)).added,2);
  for(const item of await dst[0].connections()){
    assert.equal(path.relative(path.join(root,'dst','keys'),item.privateKeyPath!).startsWith('..'),false);
    const key=await fs.readFile(item.privateKeyPath!);
    assert.equal(key.toString(),pairs[names.indexOf(item.id)].private);
    const credentials=await dst[2].get(item);
    await new Promise<void>((resolve,reject)=>{
      const client=new Client();
      client.once('error',reject).once('ready',()=>client.end()).once('close',resolve);
      client.connect({host:item.host,port:item.port,username:item.username,privateKey:key,passphrase:credentials.passphrase,readyTimeout:5000});
    });
  }
  assert.equal((await importPortableConfig(backup,...dst,scope,restoredKeys)).skipped,2);
});

test('a failed decryption can be explicitly omitted while retaining a shared jump key and other credentials',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gooeshell-key-omission-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const src=stores(root);
  const file=path.join(root,'gateway-key');
  await fs.writeFile(file,(await generateVerifiedEd25519KeyPair()).private);
  const hop={...profile,id:'hop',privateKeyPath:file,reuseConnection:true};
  const target={...profile,auth:'password' as const,jumpHost:hop};
  await src[0].saveConnection(target,true);
  await src[2].save(target,{remember:'persistent',password:'unreadable-fixture',sudoUsesLogin:true});
  await src[2].save(jumpCredentialProfile(hop),{remember:'persistent',sudoUsesLogin:false,sudoPassword:'readable-fixture'});
  const credentials=new CredentialStore(root,{...cipher,decrypt:async b=>{if(b.includes('unreadable-fixture'))throw Error('fixture error');return b.toString();}});
  const selected={...scope,connectionIds:[target.id]};
  const warnings:string[]=[];
  const data=await collectPortableConfig(src[0],src[1],credentials,src[3],selected,label=>warnings.push(label));
  assert.deepEqual(warnings,['连接「One」']);
  assert.equal(data.connections[0].credentials,undefined);
  assert.equal(data.connections[0].jumpCredentials?.sudoPassword,'readable-fixture');
  await fs.unlink(file);
  const dir=path.join(root,'dst'),dst=stores(dir);
  await importPortableConfig(data,...dst,selected,new LocalKeyStore(path.join(dir,'keys')));
  const imported=(await dst[0].connections())[0];
  assert.notEqual(imported.jumpHost?.privateKeyPath,file);
  assert.equal((await dst[2].get(jumpCredentialProfile(imported.jumpHost!))).sudoPassword,'readable-fixture');
});
