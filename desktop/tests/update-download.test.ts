import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {downloadUpdate} from '../src/main/update-download';

test('verified downloads follow only trusted redirects, preserve existing files and clean partials',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gooeshell-update-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const content=Buffer.from('fixture update'),name='GooeShell-1.5.0-win-x64.zip',destination=path.join(dir,name);
  const asset={name,url:'https://github.com/gooesman/gooeshell/releases/download/v1.5.0/'+name,size:content.length,sha256:createHash('sha256').update(content).digest('hex')};
  let requests=0;const request:typeof fetch=async()=>++requests===1?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/fixture'}}):new Response(content);
  await downloadUpdate(asset,destination,new AbortController().signal,()=>{},request);assert.deepEqual(await fs.readFile(destination),content);
  await assert.rejects(downloadUpdate(asset,destination,new AbortController().signal,()=>{},async()=>new Response(content)),/已存在/);assert.deepEqual(await fs.readFile(destination),content);
  const broken={...asset,name:'broken.zip',sha256:'0'.repeat(64)};
  await assert.rejects(downloadUpdate(broken,path.join(dir,broken.name),new AbortController().signal,()=>{},async()=>new Response(content)),/校验失败/);
  const cancelled={...asset,name:'cancelled.zip'},controller=new AbortController();
  await assert.rejects(downloadUpdate(cancelled,path.join(dir,cancelled.name),controller.signal,()=>controller.abort(),async()=>new Response(content)));
  await assert.rejects(downloadUpdate(asset,destination,new AbortController().signal,()=>{},async()=>new Response(null,{status:302,headers:{location:'https://example.com/evil'}})),/不可信/);
  assert.deepEqual(await fs.readdir(dir),[name]);
});
