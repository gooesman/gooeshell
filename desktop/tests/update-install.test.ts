import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {prepareWindowsUpdate,launchWindowsUpdate} from '../src/main/update-install';

for(const detached of [false,true])test(`Windows update preserves the old version after the app exits (${detached?'detached':'attached'} helper)`,{skip:process.platform!=='win32',timeout:90000},async t=>{
 const root=await fs.mkdtemp(path.join(process.cwd(),'.build','update-test-中文 & ! % '));
 t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200}));
 const old=path.join(root,'application'),source=path.join(root,'source'),data=path.join(root,'data'),archive=path.join(root,'update.zip');
 await fs.mkdir(path.join(old,'resources'),{recursive:true});await fs.mkdir(path.join(source,'resources'),{recursive:true});
 const quickExit=path.join(process.env.SystemRoot!,'System32','findstr.exe');
 await fs.copyFile(quickExit,path.join(old,'GooeShell.exe'));await fs.copyFile(quickExit,path.join(source,'GooeShell.exe'));
 await fs.writeFile(path.join(old,'resources','app.asar'),'old');await fs.writeFile(path.join(source,'resources','app.asar'),'new');
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Compress-Archive -Path (Join-Path $env:GOOESHELL_FIXTURE "*") -DestinationPath $env:GOOESHELL_ZIP'],{windowsHide:true,env:{...process.env,GOOESHELL_FIXTURE:source,GOOESHELL_ZIP:archive}});
 const bytes=await fs.readFile(archive),asset={name:'update.zip',url:'https://example.invalid',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 await assert.rejects(prepareWindowsUpdate(archive,{...asset,sha256:'0'.repeat(64)},path.join(old,'GooeShell.exe'),data),/更新包已改变/);
 const malicious=path.join(root,'malicious.zip');
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open($env:GOOESHELL_ZIP, [IO.Compression.ZipArchiveMode]::Create); try { $null=$z.CreateEntry('../escape.txt') } finally { $z.Dispose() }"],{windowsHide:true,env:{...process.env,GOOESHELL_ZIP:malicious}});
 const badBytes=await fs.readFile(malicious),badAsset={...asset,size:badBytes.length,sha256:createHash('sha256').update(badBytes).digest('hex')};
 await assert.rejects(prepareWindowsUpdate(malicious,badAsset,path.join(old,'GooeShell.exe'),data),/准备更新失败/);
 await assert.rejects(fs.stat(path.join(root,'escape.txt')),{code:'ENOENT'});
 const plan=await prepareWindowsUpdate(archive,asset,path.join(old,'GooeShell.exe'),data);
 const child=spawn(process.execPath,['-e',"process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"],{windowsHide:true,stdio:['pipe','ignore','ignore']});
 if(detached){
  child.kill();
  const owner=spawn(process.execPath,['-e',"const {launchWindowsUpdate}=require(process.argv[1]);launchWindowsUpdate(JSON.parse(process.argv[2]));",path.resolve('dist-main/main/update-install.js'),JSON.stringify(plan)],{windowsHide:true,stdio:'ignore'});
  await new Promise<void>((resolve,reject)=>{owner.once('error',reject);owner.once('exit',code=>code===0?resolve():reject(new Error(`test app exited ${code}`)));});
 }else{
  assert(child.pid);const helper=launchWindowsUpdate(plan,child.pid,false);helper.ref();const helperExit=new Promise<number|null>((resolve,reject)=>{helper.once('exit',resolve);helper.once('error',reject);});await new Promise<void>((resolve,reject)=>{helper.once('spawn',resolve);helper.once('error',reject);});
  await new Promise(resolve=>setTimeout(resolve,1500));
  assert.equal(child.exitCode,null,'the simulated application is still running');
  assert.equal(await fs.readFile(path.join(old,'resources','app.asar'),'utf8'),'old');
  child.stdin!.end();await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  assert.equal(await helperExit,0,await fs.readFile(plan.helper+'.log','utf8'));
 }
 for(let attempt=0;attempt<300;attempt++){
  try{if(await fs.readFile(path.join(old,'resources','app.asar'),'utf8')==='new')break;}catch{}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 assert.equal(await fs.readFile(path.join(old,'resources','app.asar'),'utf8'),'new',await fs.readFile(plan.helper+'.log','utf8'));
 assert.equal(await fs.readFile(path.join(plan.backup,'resources','app.asar'),'utf8'),'old');
 const blockedStage=path.join(root,'blocked-stage'),blockedBackup=path.join(root,'existing-backup');
 await fs.mkdir(path.join(blockedStage,'resources'),{recursive:true});await fs.mkdir(blockedBackup);
 await fs.copyFile(quickExit,path.join(blockedStage,'GooeShell.exe'));await fs.writeFile(path.join(blockedStage,'resources','app.asar'),'next');
 const blocker=launchWindowsUpdate({...plan,stage:blockedStage,backup:blockedBackup},999999,false);blocker.ref();
 const failed=await new Promise<number|null>((resolve,reject)=>{blocker.once('error',reject);blocker.once('exit',resolve);});
 assert.equal(failed,1);assert.equal(await fs.readFile(path.join(old,'resources','app.asar'),'utf8'),'new');
 assert.match(await fs.readFile(path.join(data,'updates','last-error.txt'),'utf8'),/Update failed/);
});
