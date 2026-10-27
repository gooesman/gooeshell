import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {taskLaunch,readBridgeTask} from '../src/main/bridge-task';

test('background task bootstrap gates execution and never serializes sudo credentials',async()=>{
  const id='a1234567-1234-4123-8123-123456789abc';
  const launch=taskLaunch({sessionId:'session',command:"printf 'quoted 中文'; exit 7",cwd:"/tmp/dir's 中文",sudo:true},id,'PRIVATE_PASSWORD');
  assert(!launch.includes('PRIVATE_PASSWORD'));assert.match(launch,/umask 077/);assert.match(launch,/mkfifo/);assert.match(launch,/remain-on-exit on/);assert.match(launch,/@gooeshell_mcp_task/);assert.match(launch,/<&3 3<&-/);assert.match(launch,/< \/dev\/null/);
  assert.throws(()=>taskLaunch({sessionId:'s',command:'true',sudo:true},id,'bad\npassword'),/换行/);
  assert.throws(()=>taskLaunch({sessionId:'s',command:'true',sudo:false},'bad; kill-server'),/无效/);
  await assert.rejects(readBridgeTask({} as any,{sessionId:'s',taskId:id,tailLines:0},'utf8',new AbortController().signal),/无效/);
});

test('task status waits for a real completion code and supports older tmux without signal fields',async()=>{
  const request={sessionId:'s',taskId:'a1234567-1234-4123-8123-123456789abc',tailLines:2};
  const read=(meta:string,output='')=>{
    const client={exec(_command:string,accept:Function){const channel=new EventEmitter() as any;channel.stderr=new EventEmitter();channel.destroy=()=>{};channel.end=()=>queueMicrotask(()=>{channel.emit('data',Buffer.from('GOOESHELL_STATE @1 %1 '+meta+'\n'+output));channel.emit('exit',0);channel.emit('close');});accept(null,channel);}};
    return readBridgeTask(client as any,request,'utf8',new AbortController().signal);
  };
  assert.equal((await read('0 -  ')).state,'running');
  const pending=await read('1 -  ');assert.equal(pending.state,'finishing');assert.equal(pending.exitCode,null);
  const zero=await read('0 0  ');assert.equal(zero.state,'exited');assert.equal(zero.exitCode,0);
  const signal=await read('1 143 143 ');assert.equal(signal.exitCode,143);assert.equal(signal.signal,null);
  const lines=await read('1 7 7 ','first   \n  second   \nthird\n\n');assert.equal(lines.output,'  second\nthird');assert.equal(lines.truncated,true);
  const padded=await read('1 7 7 ','first\nsecond\n\n\nPane is dead (status 7, Tue Oct 27 2026)\n');assert.equal(padded.output,'first\nsecond');assert.equal(padded.truncated,false);
});
