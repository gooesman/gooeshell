import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

test('isolated Electron settings check updates and export/import encrypted configuration',{skip:process.env.GOOESHELL_MAINTENANCE_MAIN_TEST!=='1'&&'Set GOOESHELL_MAINTENANCE_MAIN_TEST=1 after building the app',timeout:60000},async t=>{
 const root=process.cwd(),base=path.resolve('../.build');await fs.mkdir(base,{recursive:true});const artifacts=await fs.mkdtemp(path.join(base,'maintenance-main-'));
 const executable=process.platform==='darwin'?path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'):path.join(root,'node_modules/electron/dist',process.platform==='win32'?'electron.exe':'electron');
 const env={...process.env,GOOESHELL_MAINTENANCE_DIR:artifacts};delete env.ELECTRON_RUN_AS_NODE;delete env.GOOESHELL_DEV_URL;
 const child=spawn(executable,[...(process.platform==='linux'&&process.env.CI?['--no-sandbox']:[]),path.join(root,'tests/fixtures/maintenance-main-electron.cjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',value=>stderr+=value);
 const timeout=setTimeout(()=>child.kill(),55000);timeout.unref();t.after(()=>{if(child.exitCode===null)child.kill();});const exit=await new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});clearTimeout(timeout);
 const result=JSON.parse(await fs.readFile(path.join(artifacts,'result.json'),'utf8').catch(()=>{throw new Error('Missing maintenance report: '+stderr);}));t.diagnostic(`maintenance artifacts: ${artifacts}`);assert.equal(exit,0,JSON.stringify(result));assert.equal(result.checks.update,true);assert.equal(result.checks.backup,true);
});
