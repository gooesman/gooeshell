import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';

test('actual Electron MCP edits over isolated SFTP', {skip:process.env.GOOESHELL_MCP_TEXT_MAIN_TEST!=='1'&&'Requires built app and isolated Python SSH fixture',timeout:90000}, async t=>{
  const base=path.resolve('test-output');await fs.mkdir(base,{recursive:true});const artifacts=await fs.mkdtemp(path.join(base,'mcp-text-main-'));
  const ready=path.join(artifacts,'fixture.ready');
  const server=spawn(process.env.GOOESHELL_TEST_PYTHON||'python',['../test-support/ssh/sftp_fixture.py','--root',path.join(artifacts,'sftp'),'--ready',ready,'--lifetime','120'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let serverError='',spawnError=false;server.on('error',error=>{spawnError=true;serverError+=error.message;});server.stderr.on('data',data=>serverError+=data.toString());server.stdout.resume();
  t.after(async()=>{await fs.writeFile(ready+'.stop','').catch(()=>{});if(server.exitCode===null){await Promise.race([new Promise(resolve=>server.once('close',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);if(server.exitCode===null)server.kill();}});
  const deadline=Date.now()+20000;
  while(!await fs.stat(ready).then(()=>true,()=>false)){if(spawnError||server.exitCode!==null||Date.now()>deadline)throw new Error('SFTP fixture did not start: '+serverError);await new Promise(resolve=>setTimeout(resolve,50));}
  const exe=path.resolve('node_modules/electron/dist',process.platform==='win32'?'electron.exe':process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron');
  const env={...process.env,GOOESHELL_MCP_TEXT_ARTIFACTS:artifacts,GOOESHELL_MCP_TEXT_READY:ready};delete env.ELECTRON_RUN_AS_NODE;delete env.GOOESHELL_DEV_URL;
  const child=spawn(exe,[...(process.platform==='linux'&&process.env.CI?['--no-sandbox']:[]),path.resolve('tests/fixtures/mcp-text-main-electron.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',data=>logs+=data.toString());child.stderr.on('data',data=>logs+=data.toString());
  const timer=setTimeout(()=>child.kill(),70000);timer.unref();t.after(()=>{clearTimeout(timer);if(child.exitCode===null)child.kill();});
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  const report=JSON.parse(await fs.readFile(path.join(artifacts,'result.json'),'utf8').catch(()=>{throw new Error('Missing test result: '+logs);}));
  assert.equal(code,0,JSON.stringify(report)+logs);assert.equal(report.success,true);t.diagnostic('MCP text fixture: '+artifacts);
});
