import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,cleanProfile,cleanSettings} from '../src/main/store';
import {defaultSettings} from '../src/shared/defaults';
import {connectionIdentity,connectionConfigurationIdentity} from '../src/shared/connections';
const profile={id:'test',name:'test host',host:'example.com',port:22,username:'alice',auth:'password' as const,rememberHost:true,encoding:'utf8' as const};
test('command mark placement defaults right and persists each display mode',async()=>{
 assert.equal(cleanSettings({} as any).commandMarks,'right');
 for(const commandMarks of [undefined,null,true,'',0,'both',{},[]])assert.equal(cleanSettings({...defaultSettings,commandMarks} as any).commandMarks,'right');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gooeshell-command-marks-settings-'));
 try{
  for(const commandMarks of ['hidden','left','right'] as const){
   await new Store(root).saveSettings({...defaultSettings,commandMarks});
   assert.equal((await new Store(root).settings()).commandMarks,commandMarks);
  }
 }finally{await fs.unlink(path.join(root,'settings.json'));await fs.rmdir(root);}
});
test('command navigation defaults never replace existing custom bindings or explicit unbound choices',()=>{
 const legacy=structuredClone(defaultSettings) as any;
 delete legacy.shortcuts.previousCommand;delete legacy.shortcuts.nextCommand;
 assert.equal(cleanSettings(legacy).shortcuts.previousCommand,'Ctrl+ArrowUp');
 assert.equal(cleanSettings(legacy).shortcuts.nextCommand,'Ctrl+ArrowDown');
 legacy.shortcuts.search='ctrl+arrowup';legacy.shortcuts.copy='Ctrl+ArrowDown';
 const migrated=cleanSettings(legacy);
 assert.equal(migrated.shortcuts.previousCommand,'');assert.equal(migrated.shortcuts.nextCommand,'');
 assert.equal(migrated.shortcuts.search,'ctrl+arrowup');assert.equal(migrated.shortcuts.copy,'Ctrl+ArrowDown');
 const explicit=cleanSettings({...defaultSettings,shortcuts:{...defaultSettings.shortcuts,previousCommand:'F7',nextCommand:''}});
 assert.equal(explicit.shortcuts.previousCommand,'F7');assert.equal(explicit.shortcuts.nextCommand,'');
 assert.deepEqual(cleanSettings(migrated).shortcuts,migrated.shortcuts);
});
test('maximize shortcut upgrades without stealing custom bindings and persists custom or unbound choices',async()=>{
 const legacy=structuredClone(defaultSettings) as any;delete legacy.shortcuts.maximize;
 assert.equal(cleanSettings(legacy).shortcuts.maximize,'Ctrl+Shift+F10');
 assert.equal(cleanSettings(legacy).shortcuts.fullscreen,'F11');
 legacy.shortcuts.search='ctrl+shift+f10';
 const migrated=cleanSettings(legacy);
 assert.equal(migrated.shortcuts.maximize,'');
 assert.equal(migrated.shortcuts.search,'ctrl+shift+f10');
 assert.deepEqual(cleanSettings(migrated).shortcuts,migrated.shortcuts);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gooeshell-maximize-settings-'));
 try{
  for(const maximize of ['Ctrl+Alt+F10','']){
   await new Store(root).saveSettings({...defaultSettings,shortcuts:{...defaultSettings.shortcuts,maximize}});
   assert.equal((await new Store(root).settings()).shortcuts.maximize,maximize);
  }
 }finally{await fs.unlink(path.join(root,'settings.json'));await fs.rmdir(root);}
});
test('Bash integration is opt-in, persists per connection, and does not change credential identity',async()=>{
 for(const shellIntegration of [undefined,false,null,0,1,'true','false',{},[]])assert.equal(Object.hasOwn(cleanProfile({...profile,shellIntegration} as any),'shellIntegration'),false);
 const enabled={...profile,shellIntegration:true};
 assert.equal(cleanProfile(enabled).shellIntegration,true);
 assert.equal(connectionIdentity(enabled),connectionIdentity(profile));
 assert.equal(connectionConfigurationIdentity(enabled),connectionConfigurationIdentity(profile));
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gooeshell-shell-integration-store-'));
 try{
  await new Store(root).saveConnection(enabled,true);
  assert.equal((await new Store(root).profiles())[0].shellIntegration,true);
  await new Store(root).saveConnection({...profile,shellIntegration:false},true);
  assert.equal(Object.hasOwn((await new Store(root).profiles())[0],'shellIntegration'),false);
  assert.equal((await fs.readFile(path.join(root,'connections.json'),'utf8')).includes('shellIntegration'),false);
 }finally{await fs.unlink(path.join(root,'connections.json'));await fs.rmdir(root);}
});
test('terminal palette and bold preferences migrate independently and persist valid values',async()=>{
 const legacy={...defaultSettings,terminalPalette:undefined,terminalBold:undefined,shortcuts:{...defaultSettings.shortcuts,commands:undefined,search:'Ctrl+Shift+M'}} as unknown as typeof defaultSettings;
 assert.equal(cleanSettings(legacy).terminalPalette,'follow-interface');
 assert.equal(defaultSettings.terminalBold,false);
 assert.equal(cleanSettings(legacy).terminalBold,false);
 assert.equal(cleanSettings(legacy).shortcuts.commands,'');
 assert.equal(cleanSettings(legacy).shortcuts.search,'Ctrl+Shift+M');
 assert.equal(cleanSettings({...defaultSettings,terminalPalette:'unknown'}).terminalPalette,'follow-interface');
 for(const terminalBold of [null,'true','false',0,1,{},[]])assert.equal(cleanSettings({...defaultSettings,terminalBold} as any).terminalBold,false);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gooeshell-palette-store-'));
 try{for(const terminalBold of [true,false]){const store=new Store(root);await store.saveSettings({...defaultSettings,theme:'light',terminalPalette:'soft',terminalBold});const restored=await new Store(root).settings();assert.equal(restored.theme,'light');assert.equal(restored.terminalPalette,'soft');assert.equal(restored.terminalBold,terminalBold);}}
 finally{await fs.unlink(path.join(root,'settings.json'));await fs.rmdir(root);}
});
test('profiles persist only intended fields and never credentials',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gooeshell-store-test-'));
 const store=new Store(root);
 await store.saveProfile({...profile,password:'must-not-persist',passphrase:'must-not-persist',sudoPassword:'must-not-persist'} as any);
 const content=await fs.readFile(path.join(root,'connections.json'),'utf8');
 assert.equal(content.includes('must-not-persist'),false);
 assert.deepEqual(await store.profiles(),[{...profile,privateKeyPath:''}]);
 await store.deleteProfile('test');assert.deepEqual(await store.profiles(),[]);
 // Delete only the exact catalog and this freshly created empty test directory.
 await fs.unlink(path.join(root,'connections.json'));await fs.rmdir(root);
});
test('invalid SSH destinations and out-of-range settings fail predictably',()=>{
 assert.throws(()=>cleanProfile({...profile,host:'bad\0host'}));
 assert.throws(()=>cleanProfile({...profile,port:0}));
 assert.throws(()=>cleanProfile({...profile,username:''}));
 const settings=cleanSettings({...defaultSettings,fontSize:200,lineHeight:NaN,backgroundOpacity:-1});
 assert.equal(settings.fontSize,40);assert.equal(settings.lineHeight,defaultSettings.lineHeight);assert.equal(settings.backgroundOpacity,0);
});
