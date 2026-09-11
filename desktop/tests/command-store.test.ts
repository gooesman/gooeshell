import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {CommandStore,cleanCommandText,cleanSavedCommand,maxCommandBytes} from '../src/main/command-store';
import type {CommandGroup,SavedCommand,SendCommandRequest} from '../src/shared/types';

const group=(id='group',connectionId?:string):CommandGroup=>({id,name:'运维命令',order:0,...(connectionId?{connectionId,connectionName:'测试服务器'}:{})});
const command=(id='command',overrides:Partial<SavedCommand>={}):SavedCommand=>({id,groupId:'group',name:'查看目录',command:'ls -la',description:'查看隐藏文件',mode:'insert',confirmBeforeRun:false,order:0,...overrides});
const request=(overrides:Partial<SendCommandRequest>={}):SendCommandRequest=>({sessionId:'session',commandId:'command',mode:'insert',allowOtherConnection:false,bracketedPaste:false,expectedCommand:'ls -la',expectedGroupId:'group',expectedConfirmBeforeRun:false,...overrides});
async function fixture(run:(directory:string,store:CommandStore)=>Promise<void>){
  const base=path.resolve('test-output');await fs.mkdir(base,{recursive:true});
  const directory=await fs.mkdtemp(path.join(base,'command-store-'));
  try{await run(directory,new CommandStore(directory));}
  finally{assert.ok(directory.startsWith(base+path.sep));await fs.rm(directory,{recursive:true,force:true});}
}

test('command library starts empty and persists groups, command text, scope and ordering independently of connections',async()=>fixture(async(directory,store)=>{
  assert.deepEqual(await store.library(),{groups:[],commands:[]});
  await store.saveGroup(group('group','deleted-connection'));
  await store.saveGroup({...group('global'),name:'全局',order:4});
  await store.saveCommand(command('first',{command:'  printf "中文"\r\nprintf "next"  ',order:8}));
  await store.saveCommand(command('second',{groupId:'global',order:2,mode:'execute',confirmBeforeRun:true}));
  const reopened=await new CommandStore(directory).library();
  assert.deepEqual(reopened.groups,[group('group','deleted-connection'),{...group('global'),name:'全局',order:4}]);
  assert.deepEqual(reopened.commands.map(value=>value.id),['second','first']);
  assert.equal(reopened.commands[1].command,'  printf "中文"\nprintf "next"  ');
  assert.deepEqual((await fs.readdir(directory)).sort(),['command-library.json']);
}));

test('parallel command writes and edits preserve every record, and deleting a group deletes only its commands',async()=>fixture(async(_directory,store)=>{
  await Promise.all([store.saveGroup(group()),store.saveGroup(group('other'))]);
  await Promise.all(Array.from({length:35},(_,index)=>store.saveCommand(command(`command-${index}`,{order:index}))));
  await store.saveCommand(command('retained',{groupId:'other'}));
  await store.saveCommand(command('command-4',{name:'重命名',command:'pwd',order:4}));
  assert.equal((await store.library()).commands.length,36);
  assert.equal((await store.library()).commands.find(value=>value.id==='command-4')?.command,'pwd');
  await store.deleteCommand('command-5');assert.equal((await store.library()).commands.length,35);
  await store.deleteGroup('group');
  assert.deepEqual(await store.library(),{groups:[group('other')],commands:[command('retained',{groupId:'other'})]});
}));

test('failed mutation does not poison the queue or create commands in missing groups',async()=>fixture(async(_directory,store)=>{
  await assert.rejects(store.saveCommand(command()),/分组不存在/);
  await store.saveGroup(group());await store.saveCommand(command());
  assert.equal((await store.library()).commands.length,1);
  assert.throws(()=>store.saveCommand(command('invalid',{name:'\x1b坏'})),/名称无效/);
  await store.saveCommand(command('valid'));
  assert.equal((await store.library()).commands.length,2);
}));

test('corrupt, duplicate or orphaned persisted data is never silently overwritten',async()=>fixture(async(directory,store)=>{
  const file=path.join(directory,'command-library.json');
  for(const source of ['{broken',JSON.stringify({version:99,groups:[],commands:[]}),JSON.stringify({version:1,groups:[group(),group()],commands:[]}),JSON.stringify({version:1,groups:[],commands:[command()]}),JSON.stringify({version:1,groups:[group()],commands:[{...command(),command:'\x1b[31m'}]})]){
    await fs.writeFile(file,source);
    await assert.rejects(store.library(),/原文件已保留/);
    await assert.rejects(store.saveGroup(group('new')),/原文件已保留/);
    assert.equal(await fs.readFile(file,'utf8'),source);
  }
  await fs.writeFile(file,JSON.stringify({version:1,groups:[group()],commands:[]}));
  await store.saveCommand(command());assert.equal((await store.library()).commands.length,1);
}));

test('command validation preserves shell whitespace and rejects controls and UTF-8 byte overflow',()=>{
  assert.equal(cleanCommandText('  echo x\r\n\techo y\n'),'  echo x\n\techo y\n');
  assert.equal(cleanCommandText('x'.repeat(maxCommandBytes)).length,maxCommandBytes);
  for(const invalid of ['\x1b[200~evil','x\ry','x\x00y','x\x03y','x\x7fy','x\x9by',' \n\t ', '鹅'.repeat(Math.floor(maxCommandBytes/3)+1)])assert.throws(()=>cleanCommandText(invalid));
  const raw={...command(),password:'not-persisted',unknown:'not-persisted'};
  assert.deepEqual(cleanSavedCommand(raw),command());
});

test('send authorization checks live connection scope and exact command, group and confirmation snapshots',async()=>fixture(async(_directory,store)=>{
  await store.saveGroup(group('group','server-a'));await store.saveCommand(command());
  await assert.rejects(store.commandForSend(request({expectedConnectionId:'server-a'}),'server-b'),/属于其他连接/);
  assert.equal((await store.commandForSend(request({expectedConnectionId:'server-a',allowOtherConnection:true}),'server-b')).command,'ls -la');
  assert.equal((await store.commandForSend(request({expectedConnectionId:'server-a'}),'server-a')).id,'command');
  await assert.rejects(store.commandForSend(request({expectedConnectionId:'server-a',expectedCommand:'rm -rf /'}),'server-a'),/已修改/);
  await assert.rejects(store.commandForSend(request({expectedConnectionId:'server-a',expectedConfirmBeforeRun:true}),'server-a'),/已修改/);
  await assert.rejects(store.commandForSend(request({expectedConnectionId:'server-a',expectedGroupId:'old-group'}),'server-a'),/已修改/);
  await store.saveGroup(group('group','server-b'));
  await assert.rejects(store.commandForSend(request({expectedConnectionId:'server-a',allowOtherConnection:true}),'server-b'),/适用连接已修改/);
  await store.saveGroup(group());
  assert.equal((await store.commandForSend(request(),'any-server')).id,'command');
  await store.deleteCommand('command');await assert.rejects(store.commandForSend(request(),'any-server'),/已删除/);
}));
