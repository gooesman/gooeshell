import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
test('key push UI separates installation, verified login, temporary credentials and cancellation', {skip:process.env.GOOESHELL_KEY_PUSH_UI_TEST!=='1'&&'Set GOOESHELL_KEY_PUSH_UI_TEST=1 with Electron installed',timeout:70_000},async t=>{
 const root=process.cwd(),base=path.resolve('../.build');await fs.mkdir(base,{recursive:true});const artifacts=await fs.mkdtemp(path.join(base,'key-push-ui-')),report=path.join(artifacts,'result.json');
 const vite=await createServer({configFile:false,root,cacheDir:path.join(artifacts,'vite-cache'),plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false}});await vite.listen();t.after(()=>vite.close());const port=(vite.httpServer!.address() as {port:number}).port;
 const executable=process.platform==='darwin'?path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'):path.join(root,'node_modules/electron/dist',process.platform==='win32'?'electron.exe':'electron');
 const env={...process.env,GOOESHELL_KEY_PUSH_UI_URL:`http://127.0.0.1:${port}/tests/fixtures/key-push-render.html`,GOOESHELL_KEY_PUSH_UI_REPORT:report,GOOESHELL_KEY_PUSH_UI_DATA:path.join(artifacts,'data')};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(executable,[...(process.platform==='linux'&&process.env.CI?['--no-sandbox']:[]),path.join(root,'tests/fixtures/key-push-render-electron.cjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',value=>{stderr+=value;});child.stdout.on('data',()=>{});const timer=setTimeout(()=>child.kill(),60_000);timer.unref();child.once('close',()=>clearTimeout(timer));t.after(()=>{if(child.exitCode===null)child.kill();});
 const exit=await new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});const result=JSON.parse(await fs.readFile(report,'utf8').catch(()=>{throw new Error(stderr);}));t.diagnostic(`key push artifacts: ${artifacts}`);assert.equal(exit,0,JSON.stringify(result,null,2)+stderr);assert.equal(result.success,true);for(const name of ['readKeyAndClearPassphrase','temporaryCredentialsAndExplicitApply','verifiedSwitch','publicOnlyCannotSwitch','changeInvalidatesVerification','cancelLocksAndCannotApply'])assert.equal(result.checks[name],true,name);assert.deepEqual(result.errors,[]);
});
