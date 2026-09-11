import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,cleanProfile,cleanSettings} from '../src/main/store';
import {defaultSettings} from '../src/shared/defaults';
const profile={id:'test',name:'test host',host:'example.com',port:22,username:'alice',auth:'password' as const,rememberHost:true,encoding:'utf8' as const};
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
