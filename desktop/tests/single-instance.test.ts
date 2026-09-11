import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';

test('real Electron processes sharing userData initialize once and activate the first window; different userData stays independent',{
  skip:process.env.GOOESHELL_SINGLE_INSTANCE_TEST==='1'?false:'Set GOOESHELL_SINGLE_INSTANCE_TEST=1 after building the desktop app',timeout:60000,
},async t=>{
  const root=process.cwd(),artifactsRoot=path.resolve('test-output');await fs.mkdir(artifactsRoot,{recursive:true});
  const artifacts=await fs.mkdtemp(path.join(artifactsRoot,'single-instance-'));
  const executable=process.platform==='darwin'?path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'):path.join(root,'node_modules/electron/dist',process.platform==='win32'?'electron.exe':'electron');
  const env={...process.env,GOOESHELL_INSTANCE_ARTIFACTS:artifacts,GOOESHELL_INSTANCE_ROLE:'primary'};delete env.ELECTRON_RUN_AS_NODE;delete env.GOOESHELL_DEV_URL;
  const child=spawn(executable,[path.join(root,'tests/fixtures/single-instance-electron.cjs'),...(process.platform==='linux'&&process.env.CI?['--no-sandbox']:[])],{env,cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',bytes=>logs+=bytes.toString());child.stderr.on('data',bytes=>logs+=bytes.toString());
  const timeout=setTimeout(()=>child.kill(),50000);timeout.unref();child.once('close',()=>clearTimeout(timeout));
  t.after(()=>{if(child.exitCode===null)child.kill();});
  const exit=await new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
  const result=JSON.parse(await fs.readFile(path.join(artifacts,'primary.json'),'utf8').catch(()=>{throw new Error('No single-instance report: '+logs);}));
  t.diagnostic('single-instance artifacts: '+artifacts);
  assert.equal(exit,0,JSON.stringify(result,null,2)+logs);assert.equal(result.success,true,JSON.stringify(result,null,2));
  for(const check of ['primaryInitialized','duplicateExitedBeforeInit','existingWindowActivated','separateUserDataAllowed'])assert.equal(result.checks[check],true,'Missing check: '+check);
});
