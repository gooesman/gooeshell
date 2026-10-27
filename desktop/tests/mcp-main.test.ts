import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';

test('actual desktop MCP settings bridge stored identities, sudo, SSH reuse and tmux commands',{
  skip:process.env.GOOESHELL_MCP_MAIN_TEST!=='1'&&'Set GOOESHELL_MCP_MAIN_TEST=1 after building the app',timeout:150000,
},async t=>{
  const base=path.resolve('test-output');await fs.mkdir(base,{recursive:true});const artifacts=await fs.mkdtemp(path.join(base,'mcp-main-'));
  const executable=path.resolve('node_modules/electron/dist',process.platform==='win32'?'electron.exe':process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron');
  const env={...process.env,GOOESHELL_MCP_MAIN_ARTIFACTS:artifacts};delete env.ELECTRON_RUN_AS_NODE;delete env.GOOESHELL_DEV_URL;
  const child=spawn(executable,[...(process.platform==='linux'&&process.env.CI?['--no-sandbox']:[]),path.resolve('tests/fixtures/mcp-main-electron.cjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',bytes=>logs+=bytes.toString());child.stderr.on('data',bytes=>logs+=bytes.toString());
  const timer=setTimeout(()=>child.kill(),140000);timer.unref();t.after(()=>{clearTimeout(timer);if(child.exitCode===null)child.kill();});
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  const result=JSON.parse(await fs.readFile(path.join(artifacts,'result.json'),'utf8').catch(()=>{throw new Error('Missing MCP report: '+logs);}));
  t.diagnostic('MCP desktop artifacts: '+artifacts);assert.equal(code,0,JSON.stringify(result,null,2)+logs);
  for(const check of ['settingsAndConfig','identityAndTransportReuse','foregroundPreserved','managedSudo','disableKeepsForeground','backgroundUsesStoredIdentity','missingPasswordStaysInApp','revokePendingAndOwnedConnections'])assert.equal(result.checks[check],true,check);
  if(result.realShell)assert.equal(result.checks.realShellCwdAndCachedSudo,true);
  if(result.tmuxAvailable)assert.equal(result.checks.realTmuxParallelPanes,true);
  assert.equal(result.success,true);
});
