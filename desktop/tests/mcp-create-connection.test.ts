import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/main/store';
import {IdentityStore} from '../src/main/identity-store';
import {parseMcpCall} from '../src/main/mcp-tools';
import {createBridgeConnection} from '../src/main/bridge-create-connection';
import {McpBridge} from '../src/main/mcp-bridge';
import {cli} from '../src/main/cli';

test('MCP connection creation keeps credentials private, resolves identities and never overwrites duplicates',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gooeshell-mcp-create-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new Store(root),identities=new IdentityStore(root,{available:async()=>false,encrypt:async()=>{throw new Error('unexpected secret access');},decrypt:async()=>{throw new Error('unexpected secret access');}});
  const identity=await identities.save({name:'共享身份',username:'alice',password:'fixture-only-secret',remember:'session'});
  await store.saveGroup({id:'group',name:'测试',icon:'folder',order:0});
  await store.setHostKeyPreference({host:'a.invalid',port:22,skipVerification:true});
  const parse=(value:unknown)=>parseMcpCall('create_connection',value).args;
  assert.throws(()=>parse({host:'a.invalid',username:'alice',password:'secret'}));
  assert.throws(()=>parse({host:'a.invalid',username:'alice',jumpHost:{host:'hop.invalid',username:'bob',password:'secret'}}));
  assert.throws(()=>parse({host:'a.invalid',username:'alice',port:70000}));
  const signal=new AbortController().signal;
  const hidden=await createBridgeConnection(store,identities,parse({name:'不收藏',host:'hidden.invalid',loginIdentityId:identity.id}),signal);
  assert.equal(hidden.created,true);assert.equal((await store.profiles()).length,0);assert((await store.connections()).some(item=>item.id===hidden.connectionId));
  const request=parse({name:'主机',host:'a.invalid',loginIdentityId:identity.id,groupId:'group',favorite:true});
  const created=await createBridgeConnection(store,identities,request,signal);
  assert.equal(created.created,true);assert.equal(created.username,'alice');
  assert.equal((await store.profiles()).length,1);assert.equal((await store.profiles())[0].groupId,'group');
  const same=await createBridgeConnection(store,identities,parse({...request,name:'不覆盖',favorite:false}),signal);
  assert.equal(same.created,false);assert.equal(same.connectionId,created.connectionId);assert.equal(same.name,'主机');
  assert.equal((await store.profiles()).length,1,'duplicate never clears the existing sidebar favorite');
  const concurrent=await Promise.all(Array.from({length:5},()=>createBridgeConnection(store,identities,parse({host:'parallel.invalid',username:'bob'}),signal)));
  assert.equal(concurrent.filter(item=>item.created).length,1);assert.equal(new Set(concurrent.map(item=>item.connectionId)).size,1);
  const jump=await createBridgeConnection(store,identities,parse({host:'target.invalid',username:'bob',auth:'agent',jumpHost:{host:'hop.invalid',loginIdentityId:identity.id}}),signal);
  const saved=(await store.connections()).find(profile=>profile.id===jump.connectionId)!;
  assert.equal(saved.jumpHost?.username,'alice');assert.equal(saved.jumpHost?.reuseConnection,true);
  await assert.rejects(createBridgeConnection(store,identities,parse({host:'x.invalid',username:'wrong',loginIdentityId:identity.id}),signal),/用户名与所选登录身份不一致/);
  await assert.rejects(createBridgeConnection(store,identities,parse({host:'x.invalid',username:'alice',auth:'key'}),signal),/私钥路径/);
  await assert.rejects(createBridgeConnection(store,identities,parse({host:'x.invalid',username:'alice',auth:'key',privateKeyPath:'relative-key'}),signal),/本机绝对路径/);
  await assert.rejects(createBridgeConnection(store,identities,parse({host:'x.invalid',username:'alice',groupId:'missing'}),signal),/分组不存在/);
  await assert.rejects(createBridgeConnection(store,identities,parse({host:'x.invalid',loginIdentityId:'missing'}),signal),/LOGIN_IDENTITY_NOT_FOUND/);
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(createBridgeConnection(store,identities,parse({host:'never.invalid',username:'x'}),cancelled.signal));
  assert(!(await store.connections()).some(item=>item.host==='never.invalid'));
  assert(!(await fs.readFile(path.join(root,'connections.json'),'utf8')).includes('fixture-only-secret'));
  assert.deepEqual(await store.hostKeyPreferences(),[{host:'a.invalid',port:22,skipVerification:true}]);
});

test('CLI creates a connection through the shared bridge without exposing credentials',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gooeshell-mcp-cli-create-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new Store(root),identities=new IdentityStore(root,{available:async()=>false,encrypt:async()=>{throw new Error('unexpected');},decrypt:async()=>{throw new Error('unexpected');}});
  const bridge=new McpBridge(root,{command:process.execPath,args:[],env:{}},async(name,args,signal)=>{
    assert.equal(name,'create_connection');return createBridgeConnection(store,identities,args,signal);
  },async()=>{});
  t.after(()=>bridge.stop());await bridge.setEnabled(true);const output:string[]=[];
  const code=await cli(['--bridge',bridge.file,'create-connection',JSON.stringify({host:'cli.invalid',username:'alice'})],new AbortController().signal,value=>output.push(value));
  assert.equal(code,0);assert.equal(JSON.parse(output[0]).created,true);assert.equal((await store.profiles()).length,0);assert.equal((await store.connections())[0].host,'cli.invalid');
});
