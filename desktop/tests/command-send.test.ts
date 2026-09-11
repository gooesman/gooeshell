import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generateKeyPairSync} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {Server} from 'ssh2';
import {SshService} from '../src/main/ssh-service';
import type {HostProfile} from '../src/shared/types';

const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
const waitFor=async(predicate:()=>boolean)=>{const deadline=Date.now()+4000;while(!predicate()){if(Date.now()>deadline)throw new Error('Fixture timed out');await new Promise(resolve=>setTimeout(resolve,10));}};

test('command input reaches only its captured SSH session, preserves bracketed paste and rejects unsafe plain multiline and lossy encoding',{timeout:15000},async t=>{
  const base=path.resolve('test-output');await fs.mkdir(base,{recursive:true});const directory=await fs.mkdtemp(path.join(base,'command-send-'));
  const clients=new Set<any>();const received:Buffer[][]=[];
  const server=new Server({hostKeys:[key]},client=>{
    const bytes:Buffer[]=[];received.push(bytes);clients.add(client);client.on('close',()=>clients.delete(client));client.on('error',()=>{});
    client.on('authentication',context=>context.method==='password'?context.accept():context.reject(['password']));
    client.on('ready',()=>client.on('session',accept=>{
      const session=accept();session.on('pty',accept=>accept?.());session.on('window-change',accept=>accept?.());
      session.on('shell',accept=>{const channel=accept();channel.on('data',(data:Buffer)=>bytes.push(Buffer.from(data)));});
    }));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const service=new SshService(()=>{},path.join(directory,'known.json'));
  t.after(async()=>{service.shutdown();for(const client of clients)client.end();await new Promise<void>(resolve=>server.close(()=>resolve()));assert.ok(directory.startsWith(base+path.sep));await fs.rm(directory,{recursive:true,force:true});});
  const profile:HostProfile={id:'fixture',name:'Fixture',host:'127.0.0.1',port:(server.address() as {port:number}).port,username:'fixture',auth:'password',rememberHost:false,encoding:'utf8'};
  const first=await service.connect({profile,password:'fixture',skipHostKeyVerification:true});
  const second=await service.connect({profile:{...profile,id:'second'},password:'fixture',skipHostKeyVerification:true});
  await service.terminalCommandInput(first.id,'printf "中文"','insert',false);
  await service.terminalCommandInput(first.id,'echo first\r\necho\tsecond','execute',true);
  const expected='printf "中文"\x1b[200~echo first\recho\tsecond\x1b[201~\r';
  await waitFor(()=>Buffer.concat(received[0]).toString('utf8')===expected);
  assert.equal(Buffer.concat(received[1]).length,0);
  for(const command of ['echo one\necho two','echo\ttwo'])await assert.rejects(service.terminalCommandInput(first.id,command,'insert',false),/未启用括号粘贴/);
  await assert.rejects(service.terminalCommandInput(first.id,'echo x\x1b[201~\rmalicious','execute',true),/终端控制字符/);
  assert.equal(Buffer.concat(received[0]).toString('utf8'),expected);
  await service.terminalCommandInput(second.id,'pwd','execute',false);
  await waitFor(()=>Buffer.concat(received[1]).toString('utf8')==='pwd\r');
  service.disconnect(first.id);await assert.rejects(service.terminalCommandInput(first.id,'pwd','execute',false),/已断开/);
  const legacy=await service.connect({profile:{...profile,id:'big5',encoding:'big5'},password:'fixture',skipHostKeyVerification:true});
  await assert.rejects(service.terminalCommandInput(legacy.id,'printf "🪿"','execute',false),/无法完整表示/);
  assert.equal(Buffer.concat(received[2]).length,0);
});
