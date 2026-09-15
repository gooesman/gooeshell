import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';

test('native reload accelerators are removed without swallowing terminal keys', {
  skip:process.env.GOOESHELL_RELOAD_SHORTCUTS_TEST==='1'?false:'Set GOOESHELL_RELOAD_SHORTCUTS_TEST=1 after building the desktop app', timeout:45000,
}, async t=>{
  const root=process.cwd(),artifactsRoot=path.resolve('test-output');
  await fs.mkdir(artifactsRoot,{recursive:true});
  const artifacts=await fs.mkdtemp(path.join(artifactsRoot,'reload-shortcuts-'));
  const executable=process.platform==='darwin'?path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'):path.join(root,'node_modules/electron/dist',process.platform==='win32'?'electron.exe':'electron');
  const env={...process.env,GOOESHELL_RELOAD_SHORTCUTS_ARTIFACTS:artifacts};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(executable,[path.join(root,'tests/fixtures/reload-shortcuts-electron.cjs'),...(process.platform==='linux'&&process.env.CI?['--no-sandbox']:[])],{env,cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',bytes=>logs+=bytes.toString());child.stderr.on('data',bytes=>logs+=bytes.toString());
  const timeout=setTimeout(()=>child.kill(),35000);timeout.unref();child.once('close',()=>clearTimeout(timeout));
  t.after(()=>{if(child.exitCode===null)child.kill();});
  const exit=await new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
  const result=JSON.parse(await fs.readFile(path.join(artifacts,'result.json'),'utf8').catch(()=>{throw new Error('No reload shortcut report: '+logs);}));
  t.diagnostic('reload shortcut artifacts: '+artifacts);
  assert.equal(exit,0,JSON.stringify(result,null,2)+logs);assert.equal(result.success,true,JSON.stringify(result,null,2));
  for(const check of ['defaultMenuReproducesReload','defaultMenuReproducesForceReload','noReloadRoles','terminalKeysPreserved','rendererStatePreserved','singleLoadAfterProtection'])assert.equal(result.checks[check],true,'Missing check: '+check);
});
