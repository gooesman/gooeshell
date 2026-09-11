import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateKeyPairSync} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Server} from 'ssh2';
import {SshService} from '../src/main/ssh-service';
import type {AppEvent,HostProfile} from '../src/shared/types';

const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
const waitFor=async(predicate:()=>boolean)=>{const deadline=Date.now()+4000;while(!predicate()){if(Date.now()>deadline)throw new Error('Fixture timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
async function fixture(t:{after:(callback:()=>Promise<void>)=>void},mode:'auth'|'shell'|'normal'){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'gooeshell-connect-cancel-'));const clients=new Set<any>();const events:AppEvent[]=[];let auth=0,shellRequests=0;
  const server=new Server({hostKeys:[key]},client=>{
    clients.add(client);client.on('close',()=>clients.delete(client));client.on('error',()=>{});
    client.on('authentication',context=>{if(context.method==='none')return context.reject(['password']);auth++;if(mode!=='auth')context.accept();});
    client.on('ready',()=>client.on('session',accept=>{
      const channel=accept();channel.on('pty',accept=>accept?.());channel.on('window-change',accept=>accept?.());
      channel.on('shell',accept=>{shellRequests++;if(mode!=='shell'){const stream=accept();stream.write('READY>');stream.on('data',(bytes:Buffer)=>stream.write(bytes));}});
    }));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const profile:HostProfile={id:'fixture',name:'Fixture',host:'127.0.0.1',port:(server.address() as {port:number}).port,username:'test-user',auth:'password',rememberHost:true,encoding:'utf8'};
  const service=new SshService(event=>events.push(event),path.join(root,'known.json'));
  t.after(async()=>{service.shutdown();for(const client of clients)client.end();await new Promise<void>(resolve=>server.close(()=>resolve()));for(const file of await fs.readdir(root))await fs.unlink(path.join(root,file));await fs.rmdir(root);});
  return{root,service,profile,events,auth:()=>auth,shellRequests:()=>shellRequests};
}
test('cancelled host-key confirmation dismisses its question and never sends credentials', {timeout:10000},async t=>{
  const f=await fixture(t,'normal');const connecting=f.service.connect({profile:f.profile,password:'fixture-password',attemptId:'trust-attempt'});
  const rejected=assert.rejects(connecting,/CONNECTION_CANCELLED/);
  await waitFor(()=>f.events.some(event=>event.type==='hostKey'));
  const question=f.events.find((event):event is Extract<AppEvent,{type:'hostKey'}>=>event.type==='hostKey')!;
  f.service.cancelConnect('trust-attempt');await rejected;
  assert.equal(f.auth(),0);assert(f.events.some(event=>event.type==='hostKeyCancelled'&&event.requestId===question.requestId));
  const retry=await f.service.connect({profile:f.profile,password:'fixture-password',attemptId:'trust-attempt',skipHostKeyVerification:true});
  assert(retry.id);f.service.disconnect(retry.id);
});
test('cancel closes an authentication handshake that the server never answers', {timeout:10000},async t=>{
  const f=await fixture(t,'auth');const connecting=f.service.connect({profile:f.profile,password:'fixture-password',attemptId:'auth-attempt',skipHostKeyVerification:true});
  const rejected=assert.rejects(connecting,/CONNECTION_CANCELLED/);
  await waitFor(()=>f.auth()>0);f.service.cancelConnect('auth-attempt');await rejected;
  assert.equal(f.events.filter(event=>event.type==='sessionClosed').length,1);
});
test('cancel closes a shell request that the server never answers', {timeout:10000},async t=>{
  const f=await fixture(t,'shell');const connecting=f.service.connect({profile:f.profile,password:'fixture-password',attemptId:'shell-attempt',skipHostKeyVerification:true});
  const rejected=assert.rejects(connecting,/CONNECTION_CANCELLED/);
  await waitFor(()=>f.shellRequests()>0);f.service.cancelConnect('shell-attempt');await rejected;
});
test('cancelling while a private key is read cannot leave a new connection behind', {timeout:10000},async t=>{
  const f=await fixture(t,'normal');const privateKeyPath=path.join(f.root,'fixture-key');await fs.writeFile(privateKeyPath,key);
  const connecting=f.service.connect({profile:{...f.profile,auth:'key',privateKeyPath},attemptId:'key-attempt',skipHostKeyVerification:true});
  f.service.cancelConnect('key-attempt');await assert.rejects(connecting,/CONNECTION_CANCELLED/);
  assert.equal(f.auth(),0);assert.equal(f.events.length,0);
});
test('secret input is acknowledged, reaches only its live SSH session, and fails after disconnect', {timeout:10000},async t=>{
  const f=await fixture(t,'normal');const connected=await f.service.connect({profile:f.profile,password:'fixture-password',attemptId:'successful',skipHostKeyVerification:true});
  f.service.terminalResize(connected.id,100,30);
  const text=()=>f.events.filter((event):event is Extract<AppEvent,{type:'terminal'}>=>event.type==='terminal').map(event=>Buffer.from(event.data,'base64').toString('utf8')).join('');
  await waitFor(()=>text().includes('READY>'));
  f.service.cancelConnect('successful');
  await f.service.terminalSecretInput(connected.id,'fixture-sudo\r');await waitFor(()=>text().includes('fixture-sudo\r'));
  assert(!f.events.some(event=>event.type==='notice'));
  f.service.disconnect(connected.id);await assert.rejects(f.service.terminalSecretInput(connected.id,'fixture-sudo\r'),/已断开/);
  const legacy=await f.service.connect({profile:{...f.profile,encoding:'big5'},password:'fixture-password',skipHostKeyVerification:true});
  await assert.rejects(f.service.terminalSecretInput(legacy.id,'unrepresentable-🪿'),/无法完整表示密码/);f.service.disconnect(legacy.id);
});
