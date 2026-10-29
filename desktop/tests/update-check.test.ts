import test from 'node:test';
import assert from 'node:assert/strict';
import {checkForUpdate,parseLatestRelease} from '../src/main/update-check';

const root='https://github.com/gooesman/gooeshell/releases';
const asset=(name:string)=>({name,state:'uploaded',size:1024,digest:'sha256:'+'ab'.repeat(32),browser_download_url:`${root}/download/v1.5.0/${name}`});
const release=()=>({tag_name:'v1.5.0',draft:false,prerelease:false,html_url:`${root}/tag/v1.5.0`,body:'更新',assets:[asset('GooeShell-1.5.0-win-x64.zip'),asset('GooeShell-1.5.0-linux-x64.AppImage'),asset('GooeShell-1.5.0-linux-x64.deb')]});
test('only stable official releases and matching platform assets are accepted',()=>{
  const result=parseLatestRelease(release(),'1.4.1','win32','x64'); assert.equal(result.newer,true);assert.equal(result.assets.length,1);assert.equal(result.assets[0].name,'GooeShell-1.5.0-win-x64.zip');
  assert.equal(parseLatestRelease(release(),'1.5.0','linux','x64').newer,false);
  assert.equal(parseLatestRelease(release(),'2.0.0','linux','x64').newer,false);
  assert.equal(parseLatestRelease(release(),'1.0.0','linux','x64').assets.length,2);
  assert.equal(parseLatestRelease(release(),'1.0.0','darwin','arm64').assets.length,0);
  assert.throws(()=>parseLatestRelease({...release(),prerelease:true},'1.0.0','win32','x64'));
  const bad=release();bad.assets[0].browser_download_url='https://example.com/malware';assert.throws(()=>parseLatestRelease(bad,'1.0.0','win32','x64'));
  const duplicate=release();duplicate.assets.push(duplicate.assets[0]);assert.throws(()=>parseLatestRelease(duplicate,'1.0.0','win32','x64'));
  const missing=release();missing.assets[0].digest='';assert.throws(()=>parseLatestRelease(missing,'1.0.0','win32','x64'));
});
test('network errors and oversized metadata cannot be reported as up to date',async()=>{
  await assert.rejects(checkForUpdate('1.0.0','win32','x64',async()=>new Response('',{status:503})));
  await assert.rejects(checkForUpdate('1.0.0','win32','x64',async()=>new Response('x'.repeat(1024*1024+1))));
  const result=await checkForUpdate('1.0.0','win32','x64',async()=>new Response(JSON.stringify(release())));assert.equal(result.newer,true);
});
