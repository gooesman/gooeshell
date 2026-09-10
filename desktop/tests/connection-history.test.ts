import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {Store,cleanProfile} from '../src/main/store.ts';
import {defaultSettings} from '../src/shared/defaults.ts';
import type {AppSettings,HostProfile,HostKeyPreference} from '../src/shared/types.ts';

async function fixture(run:(directory:string)=>Promise<void>){
  const base=path.resolve('test-output');
  await fs.mkdir(base,{recursive:true});
  const directory=await fs.mkdtemp(path.join(base,'connection-history-'));
  try{await run(directory);}
  finally{assert.ok(directory.startsWith(base+path.sep));await fs.rm(directory,{recursive:true,force:true});}
}
const profile=(name:string,overrides:Partial<HostProfile>={}):HostProfile=>({
  id:name,name,host:`${name}.example.test`,port:22,username:'fixture',auth:'agent',rememberHost:false,encoding:'utf8',...overrides,
});

test('history stores reconnect details without credentials and stays separate from saved servers',async()=>fixture(async directory=>{
  const store=new Store(directory);
  const saved=profile('saved');
  await store.saveProfile(saved);
  const transient={...profile('temporary',{auth:'key',privateKeyPath:'C:\\keys\\fixture.key'}),password:'password-never-store',passphrase:'passphrase-never-store',privateKey:'key-contents-never-store'};
  const before=Date.now();
  await store.recordConnection(transient);
  const history=await new Store(directory).history();
  assert.equal(history.length,1);
  assert.deepEqual(history[0].profile,cleanProfile(transient));
  assert.ok(history[0].connectedAt>=before&&history[0].connectedAt<=Date.now());
  const serialized=await fs.readFile(path.join(directory,'connection-history.json'),'utf8');
  for(const secret of ['password-never-store','passphrase-never-store','key-contents-never-store'])assert.ok(!serialized.includes(secret));
  assert.deepEqual(await store.profiles(),[cleanProfile(saved)]);
  await store.clearHistory();
  assert.deepEqual(await new Store(directory).history(),[]);
  assert.deepEqual(await store.profiles(),[cleanProfile(saved)]);
}));

test('history sanitizes malformed persisted data and deduplicates by endpoint using the newest entry',async()=>fixture(async directory=>{
  const file=path.join(directory,'connection-history.json');
  const store=new Store(directory);
  for(const invalid of ['{broken',JSON.stringify({items:[]}),JSON.stringify(null)]){
    await fs.writeFile(file,invalid);
    assert.deepEqual(await store.history(),[]);
  }
  const older=profile('older',{host:'HOST.example.test'});
  const newer={...profile('newer',{host:'host.example.test',encoding:'big5'}),password:'discard-me'};
  await fs.writeFile(file,JSON.stringify([
    null,{}, {profile:older,connectedAt:0},{profile:older,connectedAt:'123'},
    {profile:older,connectedAt:1.5},{profile:{...older,port:0},connectedAt:99},
    {profile:older,connectedAt:100}, {profile:newer,connectedAt:300,passphrase:'discard-me'},
    {profile:profile('second'),connectedAt:200},
  ]));
  assert.deepEqual(await store.history(),[
    {profile:cleanProfile(newer),connectedAt:300},
    {profile:cleanProfile(profile('second')),connectedAt:200},
  ]);
  await store.recordConnection(profile('third'));
  assert.ok(!(await fs.readFile(file,'utf8')).includes('discard-me'));
}));

test('concurrent successful connections retain the newest 30 endpoints and reconnection refreshes details',async()=>fixture(async directory=>{
  const store=new Store(directory);
  await Promise.all(Array.from({length:40},(_,index)=>store.recordConnection(profile(`host-${index}`))));
  let history=await store.history();
  assert.equal(history.length,30);
  assert.deepEqual(history.map(entry=>entry.profile.id),Array.from({length:30},(_,index)=>`host-${39-index}`));
  assert.ok(history.every((entry,index)=>index===0||history[index-1].connectedAt>=entry.connectedAt));
  const reconnected=profile('updated',{host:'HOST-20.example.test',auth:'password',encoding:'gb18030'});
  await store.recordConnection(reconnected);
  history=await store.history();
  assert.equal(history.length,30);
  assert.deepEqual(history[0].profile,cleanProfile(reconnected));
  assert.equal(history.filter(entry=>entry.profile.host.toLowerCase()==='host-20.example.test').length,1);
  await store.recordConnection({...reconnected,id:'another-port',port:2222});
  await store.recordConnection({...reconnected,id:'another-user',username:'other'});
  history=await store.history();
  assert.deepEqual(history.slice(0,3).map(entry=>entry.profile.id),['another-user','another-port','updated']);
  assert.deepEqual((await fs.readdir(directory)).filter(name=>name.endsWith('.tmp')),[]);
}));

test('history clear and subsequent reconnect serialize without restoring earlier entries',async()=>fixture(async directory=>{
  const store=new Store(directory);
  await Promise.all([
    store.recordConnection(profile('before-clear')),
    store.clearHistory(),
    store.recordConnection(profile('after-clear')),
  ]);
  assert.deepEqual((await store.history()).map(entry=>entry.profile.id),['after-clear']);
  await assert.rejects(store.recordConnection(profile('invalid',{host:''})),/连接|主机/);
  assert.deepEqual((await store.history()).map(entry=>entry.profile.id),['after-clear']);
}));

test('a failed history write does not poison a later record or affect saved servers',async()=>fixture(async directory=>{
  const store=new Store(directory);
  await store.saveProfile(profile('saved'));
  const blocker=path.join(directory,'connection-history.json');
  await fs.mkdir(blocker);
  await assert.rejects(store.recordConnection(profile('failed')));
  await fs.rmdir(blocker);
  await store.recordConnection(profile('recovered'));
  assert.deepEqual((await store.history()).map(entry=>entry.profile.id),['recovered']);
  assert.deepEqual((await store.profiles()).map(entry=>entry.id),['saved']);
}));

test('history display, compact files button, and font weight migrate and persist independently',async()=>fixture(async directory=>{
  const file=path.join(directory,'settings.json');
  const store=new Store(directory);
  await fs.writeFile(file,JSON.stringify({fontFamily:'Consolas',fontSize:18}));
  const legacy=await store.settings();
  assert.equal(legacy.showConnectionHistory,true);
  assert.equal(legacy.filesToggleIconOnly,defaultSettings.filesToggleIconOnly);
  assert.equal(legacy.fontWeight,400);
  assert.equal(legacy.fontFamily,'Consolas');
  await store.saveSettings({...legacy,showConnectionHistory:false,filesToggleIconOnly:true,fontWeight:700});
  const persisted=await new Store(directory).settings();
  assert.deepEqual(persisted,{...legacy,showConnectionHistory:false,filesToggleIconOnly:true,fontWeight:700});
  await fs.writeFile(file,JSON.stringify({...persisted,showConnectionHistory:'false',filesToggleIconOnly:1,fontWeight:650} as unknown as AppSettings));
  const invalid=await store.settings();
  assert.equal(invalid.showConnectionHistory,defaultSettings.showConnectionHistory);
  assert.equal(invalid.filesToggleIconOnly,defaultSettings.filesToggleIconOnly);
  assert.equal(invalid.fontWeight,defaultSettings.fontWeight);
}));

test('host key preferences are isolated by address and port and never add saved servers',async()=>fixture(async directory=>{
  const store=new Store(directory);
  await store.saveProfile(profile('saved'));
  await store.recordConnection(profile('temporary',{rememberHost:true}));
  const originalHistory=await store.history();
  await store.setHostKeyPreference({host:' TEMPORARY.example.test ',port:22,skipVerification:true});
  await store.setHostKeyPreference({host:'temporary.example.test',port:2222,skipVerification:true});
  await store.setHostKeyPreference({host:'other.example.test',port:22,skipVerification:true});
  assert.deepEqual(await new Store(directory).hostKeyPreferences(),[
    {host:'temporary.example.test',port:22,skipVerification:true},
    {host:'temporary.example.test',port:2222,skipVerification:true},
    {host:'other.example.test',port:22,skipVerification:true},
  ]);
  await store.setHostKeyPreference({host:'TEMPORARY.example.test',port:22,skipVerification:false});
  assert.deepEqual(await new Store(directory).hostKeyPreferences(),[
    {host:'temporary.example.test',port:2222,skipVerification:true},
    {host:'other.example.test',port:22,skipVerification:true},
  ]);
  assert.deepEqual((await store.profiles()).map(value=>value.id),['saved']);
  assert.deepEqual(await store.history(),originalHistory);
  assert.equal((await store.history())[0].profile.rememberHost,true);
}));

test('host key preferences sanitize malformed data and serialize simultaneous endpoint changes',async()=>fixture(async directory=>{
  const file=path.join(directory,'host-key-preferences.json');const store=new Store(directory);
  for(const contents of ['{broken',JSON.stringify({host:'invalid.example.test',port:22,skipVerification:true})]){
    await fs.writeFile(file,contents);assert.deepEqual(await store.hostKeyPreferences(),[]);
  }
  await fs.writeFile(file,JSON.stringify([
    null,{}, {host:'bad\naddress',port:22,skipVerification:true},
    {host:'bad.example.test',port:0,skipVerification:true},
    {host:'bad.example.test',port:22,skipVerification:'true'},
    {host:'same.example.test',port:22,skipVerification:true},
    {host:'SAME.example.test',port:22,skipVerification:false},
    {host:'safe.example.test',port:22,skipVerification:true,password:'must-not-survive'},
  ]));
  assert.deepEqual(await store.hostKeyPreferences(),[{host:'safe.example.test',port:22,skipVerification:true}]);
  await Promise.all([
    ...Array.from({length:20},(_,index)=>store.setHostKeyPreference({host:`host-${index}.example.test`,port:22,skipVerification:true})),
    store.setHostKeyPreference({host:'HOST-2.example.test',port:22,skipVerification:false}),
    store.setHostKeyPreference({host:'host-7.example.test',port:22,skipVerification:false}),
  ]);
  const all=await new Store(directory).hostKeyPreferences();assert.equal(all.length,19);
  assert.ok(!all.some(value=>['host-2.example.test','host-7.example.test'].includes(value.host)));
  assert.ok(!(await fs.readFile(file,'utf8')).includes('must-not-survive'));
  for(const input of [{host:'',port:22,skipVerification:true},{host:'valid',port:65536,skipVerification:true},{host:'valid',port:22,skipVerification:1}]){
    await assert.rejects(store.setHostKeyPreference(input as unknown as HostKeyPreference),/地址、端口和指纹选项/);
  }
  assert.deepEqual(await store.hostKeyPreferences(),all);
  assert.deepEqual((await fs.readdir(directory)).filter(name=>name.endsWith('.tmp')),[]);
}));

test('new shortcut defaults migrate once while custom bindings and existing conflicts stay intact',async()=>fixture(async directory=>{
  const file=path.join(directory,'settings.json');
  const store=new Store(directory);
  const old={connect:'Ctrl+Shift+N',settings:'Ctrl+,',paste:'MouseMiddle'};
  await fs.writeFile(file,JSON.stringify({shortcuts:old}));
  const migrated=await store.settings();
  assert.equal(migrated.shortcuts.connect,'Ctrl+Shift+P');
  assert.equal(migrated.shortcuts.settings,'Ctrl+Shift+F1');
  assert.equal(migrated.shortcuts.previousTab,'Ctrl+Shift+ArrowLeft');
  assert.equal(migrated.shortcuts.nextTab,'Ctrl+Shift+ArrowRight');
  assert.equal(migrated.shortcuts.paste,'MouseMiddle');
  assert.equal(migrated.shortcutSchemaVersion,2);
  await fs.writeFile(file,JSON.stringify({shortcuts:{...old,connect:'F2',settings:'MouseRight'}}));
  const custom=await store.settings();
  assert.equal(custom.shortcuts.connect,'F2');
  assert.equal(custom.shortcuts.settings,'MouseRight');
  await fs.writeFile(file,JSON.stringify({shortcuts:{...old,files:'Ctrl+Shift+P',search:'Ctrl+Shift+F1'}}));
  const conflicting=await store.settings();
  assert.equal(conflicting.shortcuts.connect,old.connect);
  assert.equal(conflicting.shortcuts.settings,old.settings);
  await fs.writeFile(file,JSON.stringify({shortcuts:{...old,files:'Ctrl+Shift+ArrowLeft',paste:'Ctrl+Shift+ArrowRight'}}));
  const occupiedTabKeys=await store.settings();
  assert.equal(occupiedTabKeys.shortcuts.files,'Ctrl+Shift+ArrowLeft');
  assert.equal(occupiedTabKeys.shortcuts.paste,'Ctrl+Shift+ArrowRight');
  assert.equal(occupiedTabKeys.shortcuts.previousTab,'');
  assert.equal(occupiedTabKeys.shortcuts.nextTab,'');
  await store.saveSettings(occupiedTabKeys);
  assert.deepEqual((await new Store(directory).settings()).shortcuts,occupiedTabKeys.shortcuts);
  await store.saveSettings({...migrated,shortcuts:{...migrated.shortcuts,connect:old.connect,settings:old.settings}});
  const reverted=await new Store(directory).settings();
  assert.equal(reverted.shortcuts.connect,old.connect);
  assert.equal(reverted.shortcuts.settings,old.settings);
}));
