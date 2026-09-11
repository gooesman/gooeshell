import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {Store,cleanGroup,cleanProfile,cleanSettings} from '../src/main/store.ts';
import {defaultSettings} from '../src/shared/defaults.ts';
import type {ConnectionGroup,HostProfile} from '../src/shared/types.ts';

async function fixture(run:(directory:string)=>Promise<void>){
  const base=path.resolve('test-output');await fs.mkdir(base,{recursive:true});
  const directory=await fs.mkdtemp(path.join(base,'connection-catalog-'));
  try{await run(directory);}
  finally{assert.ok(directory.startsWith(base+path.sep));await fs.rm(directory,{recursive:true,force:true});}
}
const profile=(id:string,overrides:Partial<HostProfile>={}):HostProfile=>({id,name:id,host:`${id}.example.test`,port:22,username:'alice',auth:'password',rememberHost:true,encoding:'utf8',...overrides});
const group=(id:string,order=0):ConnectionGroup=>({id,name:id,icon:'folder',order});

test('legacy favorites and recent snapshots migrate once to stable records without losing their names or timestamps',async()=>fixture(async directory=>{
  const favorite=profile('favorite',{host:'SHARED.example.test',name:'自定义服务器',icon:'cloud'});
  await fs.writeFile(path.join(directory,'profiles.json'),JSON.stringify([favorite,null,{host:'invalid'}]));
  await fs.writeFile(path.join(directory,'connection-history.json'),JSON.stringify([
    {profile:profile('recent-alias',{host:'shared.example.test',name:'旧名字'}),connectedAt:300},
    {profile:profile('older',{host:'shared.example.test'}),connectedAt:100},
    {profile:{...profile('temporary'),password:'never-write'},connectedAt:200},
  ]));
  const store=new Store(directory);
  assert.deepEqual(await store.profiles(),[cleanProfile(favorite)]);
  assert.deepEqual(await store.history(),[
    {profile:cleanProfile(favorite),connectedAt:300},
    {profile:cleanProfile(profile('temporary')),connectedAt:200},
  ]);
  const persisted=JSON.parse(await fs.readFile(path.join(directory,'connections.json'),'utf8'));
  assert.equal(persisted.version,1);assert.equal(persisted.records.length,2);
  assert.deepEqual(persisted.history,[{connectionId:'favorite',connectedAt:300},{connectionId:'temporary',connectedAt:200}]);
  assert.ok(!JSON.stringify(persisted).includes('never-write'));
  // Legacy files are recovery copies, not a second live source that can resurrect deleted history.
  await store.deleteHistory('favorite');
  await fs.writeFile(path.join(directory,'connection-history.json'),JSON.stringify([{profile:favorite,connectedAt:999}]));
  assert.deepEqual((await new Store(directory).history()).map(entry=>entry.profile.id),['temporary']);
}));

test('editing recent connections keeps stable identity, latest name, original timestamp and favorite choice',async()=>fixture(async directory=>{
  const store=new Store(directory);const original=profile('recent');
  await store.recordConnection(original);const timestamp=(await store.history())[0].connectedAt;
  const saved=await store.saveConnection({...original,name:'重命名',icon:'router'},false);
  assert.equal(saved.id,original.id);assert.deepEqual(await store.profiles(),[]);
  assert.deepEqual(await store.history(),[{profile:cleanProfile(saved),connectedAt:timestamp}]);
  await store.saveProfile(saved);
  assert.deepEqual(await store.profiles(),[saved]);
  await store.deleteProfile(saved.id);
  assert.deepEqual(await store.profiles(),[]);
  assert.equal((await store.connections()).length,1);
  assert.equal((await store.history())[0].connectedAt,timestamp);
  await store.saveConnection(profile('never-connected'),false);
  assert.equal((await store.history()).length,1);
}));

test('delayed authentication records success without overwriting a concurrent rename or group move',async()=>fixture(async directory=>{
  const store=new Store(directory);
  await store.saveGroup(group('before'));await store.saveGroup(group('after'));
  const connecting=profile('connecting',{groupId:'before',icon:'server'});
  await store.saveConnection(connecting,true);
  const edited=await store.saveConnection({...connecting,name:'连接期间改名',groupId:'after',icon:'cloud'},true);
  await store.recordConnection(connecting,true);
  assert.deepEqual(await store.profiles(),[edited]);
  assert.deepEqual((await store.history()).map(entry=>entry.profile),[edited]);
  assert.ok((await store.history())[0].connectedAt>0);
  await store.recordConnection(profile('new-connection'),true);
  assert.deepEqual((await store.history()).map(entry=>entry.profile.id),['new-connection','connecting']);
  assert.equal((await store.connections()).length,2);
}));

test('late authentication cannot recreate a connection deleted while it was connecting',async()=>fixture(async directory=>{
  const store=new Store(directory);const connecting=profile('deleted-during-auth');
  await store.saveConnection(connecting,true);
  await Promise.all([store.deleteConnection(connecting.id),store.recordConnection(connecting,true,true)]);
  assert.deepEqual(await store.connections(),[]);assert.deepEqual(await store.history(),[]);assert.deepEqual(await store.profiles(),[]);
  // Another config for the same endpoint is a different saved record; the deleted
  // request must not attach history to it by identity fallback either.
  const replacement=await store.saveConnection({...connecting,id:'new-record',name:'Replacement'},false);
  await store.recordConnection(connecting,true,true);
  assert.deepEqual(await store.connections(),[replacement]);assert.deepEqual(await store.history(),[]);
  await store.recordConnection(profile('genuinely-new'),true,false);
  assert.deepEqual((await store.history()).map(entry=>entry.profile.id),['genuinely-new']);
}));

test('late authentication for an old destination never marks its edited replacement successfully connected',async()=>fixture(async directory=>{
  const store=new Store(directory);const connecting=profile('retargeted',{host:'old.example.test'});
  await store.saveConnection(connecting,true);
  const replacement=await store.saveConnection({...connecting,host:'new.example.test'},true);
  await store.recordConnection(connecting,true,true);
  assert.deepEqual(await store.profiles(),[replacement]);assert.deepEqual(await store.history(),[]);
  await store.recordConnection(replacement,true,true);
  const completed=(await store.history())[0];assert.equal(completed.profile.host,'new.example.test');
  await store.recordConnection(connecting,true,true);
  assert.deepEqual(await store.history(),[completed]);
}));

test('connection resolution does not save or connect and matches authentication identity without depending on display name',async()=>fixture(async directory=>{
  const store=new Store(directory);const original=profile('stable',{host:'shared.example.test'});
  await store.saveConnection(original,false);
  const alias=await store.resolveConnection(profile('temporary-id',{host:'SHARED.example.test',name:'新名称'}));
  assert.equal(alias.id,'stable');assert.equal(alias.name,'新名称');
  assert.deepEqual(await store.connections(),[cleanProfile(original)]);
  assert.deepEqual(await store.history(),[]);
  assert.equal((await store.resolveConnection(profile('different-user',{host:original.host,username:'bob'}))).id,'different-user');
  assert.equal((await store.resolveConnection(profile('different-port',{host:original.host,port:2222}))).id,'different-port');
  assert.equal((await store.resolveConnection(profile('different-auth',{host:original.host,auth:'agent'}))).id,'different-auth');
  const edited=await store.resolveConnection({...original,host:'replacement.example.test'});
  assert.equal(edited.id,'stable');assert.equal(edited.host,'replacement.example.test');
  const canonical=await store.saveConnection(alias,true);
  assert.equal(canonical.id,'stable');assert.equal((await store.connections()).length,1);
}));

test('connection groups persist order and deletion moves connections to ungrouped without deleting them',async()=>fixture(async directory=>{
  const store=new Store(directory);
  await store.saveGroup(group('late',20));await store.saveGroup(group('early',1));
  await store.saveConnection(profile('saved',{groupId:'late',icon:'database'}),true);
  await store.recordConnection(profile('recent',{groupId:'late'}));
  await store.saveGroup({...group('late',0),name:'改名',icon:'server'});
  assert.deepEqual((await store.groups()).map(value=>value.id),['late','early']);
  assert.equal((await store.connections())[0].groupId,'late');
  await store.deleteGroup('late');
  assert.deepEqual((await new Store(directory).groups()).map(value=>value.id),['early']);
  assert.ok((await store.connections()).every(value=>value.groupId===undefined));
  assert.deepEqual((await store.profiles()).map(value=>value.id),['saved']);
  assert.deepEqual((await store.history()).map(value=>value.profile.id),['recent']);
  await assert.rejects(store.saveConnection(profile('missing-group',{groupId:'late'}),true),/分组不存在/);
}));

test('history deletion, unfavoriting and full connection deletion have separate effects',async()=>fixture(async directory=>{
  const store=new Store(directory);const target=profile('target');
  await store.saveProfile(target);await store.recordConnection(target);
  await store.deleteHistory(target.id);
  assert.deepEqual(await store.history(),[]);assert.equal((await store.profiles()).length,1);assert.equal((await store.connections()).length,1);
  await store.recordConnection(target);await store.deleteProfile(target.id);
  assert.equal((await store.history()).length,1);assert.deepEqual(await store.profiles(),[]);
  await store.deleteConnection(target.id);
  assert.deepEqual(await store.connections(),[]);assert.deepEqual(await store.history(),[]);
}));

test('catalog mutations serialize across groups, favorite edits, successful connects and history removal',async()=>fixture(async directory=>{
  const store=new Store(directory);
  await Promise.all([
    store.saveGroup(group('group')),
    ...Array.from({length:15},(_,index)=>store.saveConnection(profile(`saved-${index}`,{groupId:'group'}),true)),
    ...Array.from({length:15},(_,index)=>store.recordConnection(profile(`recent-${index}`,{groupId:'group'}))),
    store.deleteHistory('recent-5'),
    store.deleteProfile('saved-5'),
    store.deleteGroup('group'),
  ]);
  const reopened=new Store(directory);
  assert.equal((await reopened.connections()).length,30);
  assert.equal((await reopened.profiles()).length,14);
  assert.equal((await reopened.history()).length,14);
  assert.deepEqual(await reopened.groups(),[]);
  assert.ok((await reopened.connections()).every(value=>!value.groupId));
  assert.ok(!(await reopened.history()).some(entry=>entry.profile.id==='recent-5'));
  assert.deepEqual((await fs.readdir(directory)).filter(name=>name.endsWith('.tmp')),[]);
}));

test('corrupt or unsupported catalog is never overwritten or silently replaced from legacy data',async()=>fixture(async directory=>{
  const file=path.join(directory,'connections.json');
  await fs.writeFile(path.join(directory,'profiles.json'),JSON.stringify([profile('legacy')]));
  for(const contents of ['{broken',JSON.stringify({version:2,records:[],history:[],groups:[]}),JSON.stringify({version:1,records:null,history:[],groups:[]})]){
    await fs.writeFile(file,contents);
    await assert.rejects(new Store(directory).saveProfile(profile('new')),/连接数据/);
    assert.equal(await fs.readFile(file,'utf8'),contents);
  }
}));

test('catalog sanitizes malformed entries and rejects invalid group and mutation arguments',async()=>fixture(async directory=>{
  const file=path.join(directory,'connections.json');const store=new Store(directory);
  await fs.writeFile(file,JSON.stringify({version:1,records:[
    {profile:{...profile('safe'),groupId:'deleted',password:'discard'},favorite:true},
    {profile:profile('not-boolean'),favorite:'true'},
    {profile:{...profile('bad-id'),id:''},favorite:true},
    null,
  ],history:[{connectionId:'missing',connectedAt:300},{connectionId:'safe',connectedAt:20},{connectionId:'safe',connectedAt:10}],groups:[null,group('valid'),{...group('bad'),order:-1}]}));
  assert.deepEqual(await store.connections(),[cleanProfile(profile('safe'))]);
  assert.deepEqual((await store.history()).map(({profile,connectedAt})=>({id:profile.id,connectedAt})),[{id:'safe',connectedAt:20}]);
  assert.deepEqual(await store.groups(),[group('valid')]);
  for(const method of ['deleteHistory','deleteConnection','deleteProfile','deleteGroup'] as const)await assert.rejects(store[method]('bad\nidentifier'),/标识无效/);
  await assert.rejects(store.saveConnection(profile('bad'),1 as unknown as boolean),/收藏/);
  assert.throws(()=>cleanProfile({...profile('bad'),icon:'rainbow' as any}),/图标/);
  assert.throws(()=>cleanGroup({...group('bad'),name:'   '}),/分组名称/);
  assert.throws(()=>cleanGroup({...group('bad'),order:1.5}),/排序/);
  await store.saveConnection(profile('new'),false);
  assert.ok(!(await fs.readFile(file,'utf8')).includes('discard'));
}));

test('new reconnect and sudo shortcuts leave existing user bindings intact when defaults conflict',()=>{
  const old=cleanSettings({...defaultSettings,shortcuts:{copy:'Ctrl+Shift+R',paste:'Ctrl+Alt+P'}});
  assert.equal(old.shortcuts.copy,'Ctrl+Shift+R');assert.equal(old.shortcuts.paste,'Ctrl+Alt+P');
  assert.equal(old.shortcuts.reconnect,'');assert.equal(old.shortcuts.sudoPassword,'');
  const custom=cleanSettings({...defaultSettings,shortcuts:{reconnect:'F7',sudoPassword:'MouseMiddle'}});
  assert.equal(custom.shortcuts.reconnect,'F7');assert.equal(custom.shortcuts.sudoPassword,'MouseMiddle');
  assert.equal(cleanSettings({...defaultSettings,sudoPasswordSubmit:true}).sudoPasswordSubmit,true);
  assert.equal(cleanSettings({...defaultSettings,sudoPasswordSubmit:'true' as any}).sudoPasswordSubmit,false);
});
