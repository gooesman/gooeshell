import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';

test('Electron update closes, replaces an isolated application and preserves the previous directory',{
 skip:process.platform!=='win32'||process.env.GOOESHELL_UPDATE_ELECTRON_TEST!=='1',timeout:120000,
},async t=>{
 const base=path.resolve('../.build');await fs.mkdir(base,{recursive:true});
 const root=await fs.mkdtemp(path.join(base,'update-electron-'));t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
 const application=path.join(root,'application'),source=path.join(root,'fixture-source');
 await fs.cp(path.resolve('node_modules/electron/dist'),application,{recursive:true});
 await fs.rename(path.join(application,'electron.exe'),path.join(application,'GooeShell.exe'));
 const appSource=path.join(root,'packaged-source');await fs.mkdir(appSource);
 await fs.copyFile(path.resolve('tests/fixtures/update-packaged-electron.cjs'),path.join(appSource,'main.cjs'));
 await fs.writeFile(path.join(appSource,'package.json'),JSON.stringify({name:'update-fixture',version:'1.4.1',main:'main.cjs'}));
 execFileSync(process.execPath,[path.resolve('node_modules/@electron/asar/bin/asar.js'),'pack',appSource,path.join(application,'resources','app.asar')],{windowsHide:true});
 await fs.copyFile(path.resolve('assets/icon.png'),path.join(application,'resources','icon.png'));
 await fs.mkdir(path.join(source,'resources'),{recursive:true});
 await fs.copyFile(path.join(process.env.SystemRoot!,'System32','findstr.exe'),path.join(source,'GooeShell.exe'));
 const asarSource=path.join(root,'asar-source');await fs.mkdir(asarSource);await fs.writeFile(path.join(asarSource,'fixture.txt'),'updated-fixture');
 execFileSync(process.execPath,[path.resolve('node_modules/@electron/asar/bin/asar.js'),'pack',asarSource,path.join(source,'resources','app.asar')],{windowsHide:true});
 const expected=await fs.readFile(path.join(source,'resources','app.asar'));
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Compress-Archive -Path (Join-Path $env:GOOESHELL_FIXTURE "*") -DestinationPath $env:GOOESHELL_ZIP'],{windowsHide:true,env:{...process.env,GOOESHELL_FIXTURE:source,GOOESHELL_ZIP:path.join(root,'fixture.zip')}});
 const env={...process.env,GOOESHELL_UPDATE_FIXTURE:root,GOOESHELL_UPDATE_MAIN:path.resolve('dist-main/main/main.js')};delete env.ELECTRON_RUN_AS_NODE;delete env.GOOESHELL_DEV_URL;
 const app=spawn(path.join(application,'GooeShell.exe'),[],{windowsHide:true,env,stdio:['ignore','ignore','pipe']});let errors='';app.stderr.on('data',chunk=>errors+=chunk);
 t.after(()=>{if(app.exitCode===null)app.kill();});
 const exit=await new Promise<number|null>((resolve,reject)=>{app.once('error',reject);app.once('exit',resolve);});
 const fixtureError=await fs.readFile(path.join(root,'error.txt'),'utf8').catch(()=>'');assert.equal(exit,0,fixtureError||errors);
 assert.equal(await fs.readFile(path.join(root,'install-started'),'utf8'),'yes');
 for(let i=0;i<300;i++){
  try{if((await fs.readFile(path.join(application,'resources','app.asar'))).equals(expected))break;}catch{}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 const result=await fs.readFile(path.join(application,'resources','app.asar')).catch(()=>Buffer.alloc(0));
 const updateFiles=await fs.readdir(path.join(root,'data','updates')).catch(()=>[]);
 const logs=await Promise.all(updateFiles.filter(name=>name.endsWith('.log')||name.endsWith('.pid')).map(async name=>`${name}: ${await fs.readFile(path.join(root,'data','updates',name),'utf8')}`));
 assert.deepEqual(result,expected,logs.join('\n'));
 const backups=(await fs.readdir(root)).filter(name=>name.startsWith('.gooeshell-previous-'));
 assert.equal(backups.length,1);assert((await fs.stat(path.join(root,backups[0],'GooeShell.exe'))).size>1000000);
});
