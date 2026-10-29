import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {McpBridge} from '../src/main/mcp-bridge';
import {cli,cliArguments} from '../src/main/cli';
import {parseMcpCall} from '../src/main/mcp-tools';

test('CLI shares validation, follows refreshed descriptors and propagates command exit codes',async t=>{
  const base=path.resolve('test-output');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'cli-'));
  const calls:any[]=[];let offset=0;
  const bridge=new McpBridge(root,{command:process.execPath,args:[],env:{}},async(name,args)=>{calls.push({name,args});if(name==='run_command')return{exitCode:7,stdout:'中文',stderr:'',signal:null,truncated:false};if(name==='read_log')return{output:'新增日志',nextOffset:++offset,cursor:'cursor',state:'exited'};return[{id:'fixture'}];},async()=>{});
  t.after(()=>bridge.stop());await bridge.setEnabled(true);
  const output:string[]=[];const signal=new AbortController().signal;
  const params=path.join(root,'参数 with spaces.json');await fs.writeFile(params,'\uFEFF{"sessionId":"s","command":"uname -a"}');assert.equal(cliArguments(['run-command','@'+params]).input.command,'uname -a');
  assert.equal(await cli(['--bridge',bridge.file,'list-sessions'],signal,value=>output.push(value)),0);assert.deepEqual(JSON.parse(output.pop()!),[{id:'fixture'}]);
  assert.equal(await cli(['--bridge',bridge.file,'run-command',JSON.stringify({sessionId:'s',command:'exit 7'})],signal,value=>output.push(value)),7);assert.equal(JSON.parse(output.pop()!).stdout,'中文');
  await assert.rejects(cli(['--bridge',bridge.file,'connect','{"connectionId":"x","password":"do-not-accept"}'],signal),/password/);
  assert.throws(()=>cliArguments(['run-command','{}','--watch']),/仅用于/);
  assert.throws(()=>parseMcpCall('read_log',{sessionId:'s',path:'/x',offset:-1}));
  await bridge.setEnabled(false);await bridge.setEnabled(true);
  assert.equal(await cli(['--bridge',bridge.file,'read-log','{"sessionId":"s","path":"/log"}','--watch'],signal,value=>output.push(value)),0);
  assert(calls.every(call=>!('password' in call.args)));
  const child=spawn(process.execPath,['--import','tsx','src/main/cli.ts','--bridge',bridge.file,'run-command','{"sessionId":"s","command":"exit 7"}'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  assert.equal(await new Promise(resolve=>child.once('close',resolve)),7);assert.equal(JSON.parse(stdout).exitCode,7);assert.equal(stderr,'');
});
