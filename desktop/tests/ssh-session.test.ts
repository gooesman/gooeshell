import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Server} from 'ssh2';
import {SshService} from '../src/main/ssh-service';
import type {AppEvent,HostProfile} from '../src/shared/types';
const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
test('real SSH verifies trust before authentication and preserves initial terminal output', {timeout:20000}, async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gooeshell-ssh-test-'));
 const knownFile=path.join(root,'known.json');let passwords=0;
 const connections=new Set<any>();
 const server=new Server({hostKeys:[key]},client=>{
  connections.add(client);client.on('close',()=>connections.delete(client));client.on('error',()=>{});
  client.on('authentication',ctx=>{if(ctx.method==='password'){passwords++;ctx.username==='test-user'&&ctx.password==='loopback-test-only'?ctx.accept():ctx.reject();}else ctx.reject(['password']);});
  client.on('ready',()=>client.on('session',accept=>{const channel=accept();channel.on('pty',accept=>accept?.());channel.on('window-change',accept=>accept?.());channel.on('shell',accept=>{const stream=accept();stream.write('INITIAL-PROMPT> ');stream.on('data',(data:Buffer)=>stream.write(Buffer.concat([Buffer.from('ECHO:'),data])));});}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as {port:number}).port;
 const profile:HostProfile={id:'fixture',name:'Fixture',host:'127.0.0.1',port,username:'test-user',auth:'password',rememberHost:true,encoding:'utf8'};
 let question:Extract<AppEvent,{type:'hostKey'}>|undefined;let notify:(()=>void)|undefined;const events:AppEvent[]=[];
 const service=new SshService(event=>{events.push(event);if(event.type==='hostKey'){question=event;notify?.();}},knownFile);
 try{
  let ready=new Promise<void>(resolve=>notify=resolve);
  const declined=service.connect({profile,password:'loopback-test-only'});
  await ready;assert.equal(passwords,0,'password must not reach an untrusted peer');
  service.confirmHostKey(question!.requestId,'reject');await assert.rejects(declined);assert.equal(passwords,0);
  ready=new Promise<void>(resolve=>notify=resolve);
  const connecting=service.connect({profile,password:'loopback-test-only'});await ready;
  service.confirmHostKey(question!.requestId,'save');const connected=await connecting;
  const trust=JSON.parse(await fs.readFile(knownFile,'utf8'));assert.match(trust.hosts[`[127.0.0.1]:${port}`].fingerprint,/^SHA256:/);
  assert.equal(events.filter(e=>e.type==='terminal').length,0,'output held until renderer subscribes');
  service.terminalResize(connected.id,100,30);
  const waitFor=async(predicate:()=>boolean)=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw new Error('Timed out waiting for SSH output');await new Promise(r=>setTimeout(r,10));}};
  const text=()=>events.filter((e):e is Extract<AppEvent,{type:'terminal'}>=>e.type==='terminal').map(e=>Buffer.from(e.data,'base64').toString('utf8')).join('');
  await waitFor(()=>text().includes('INITIAL-PROMPT>'));
  service.terminalInput(connected.id,'typing-test\r');await waitFor(()=>text().includes('ECHO:typing-test'));
  for(const event of events)if(event.type==='terminal')service.terminalAck(connected.id,event.bytes);
  await service.disconnect(connected.id);assert(events.some(e=>e.type==='sessionClosed'&&e.sessionId===connected.id));
  await service.shutdown();
  const fake='SHA256:'+'A'.repeat(43);trust.hosts[`[127.0.0.1]:${port}`].fingerprint=fake;await fs.writeFile(knownFile,JSON.stringify(trust));
  const changedService=new SshService(event=>{if(event.type==='hostKey'){assert.equal(event.previousFingerprint,fake);changedService.confirmHostKey(event.requestId,'reject');}},knownFile);
  const count=passwords;await assert.rejects(changedService.connect({profile,password:'loopback-test-only'}));assert.equal(passwords,count);await changedService.shutdown();
 }finally{
  await service.shutdown();for(const c of connections)c.end();await new Promise<void>(resolve=>server.close(()=>resolve()));
  await fs.unlink(knownFile).catch(()=>{});await fs.rmdir(root);
 }
});
