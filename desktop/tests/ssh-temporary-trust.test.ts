import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {Server,type Connection} from 'ssh2';
import {SshService} from '../src/main/ssh-service';
import type {AppEvent,HostProfile,SessionInfo} from '../src/shared/types';

const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
type HostQuestion=Extract<AppEvent,{type:'hostKey'}>;
async function fixture(run:(f:{knownFile:string;profile:HostProfile;passwords:()=>number;replaceIdentity:()=>Promise<void>;service:()=>{service:SshService;questions:HostQuestion[]}})=>Promise<void>){
  const base=path.resolve('test-output');await fs.mkdir(base,{recursive:true});
  const directory=await fs.mkdtemp(path.join(base,'temporary-trust-'));
  const knownFile=path.join(directory,'known.json');
  const connections=new Set<Connection>();const services:SshService[]=[];let passwords=0;
  const servers:Server[]=[];
  const createServer=(hostKey:string|Buffer)=>{const server=new Server({hostKeys:[hostKey]},client=>{
    connections.add(client);client.on('error',()=>{});client.on('close',()=>connections.delete(client));
    client.on('authentication',context=>{
      if(context.method==='password'){passwords++;context.username==='fixture'&&context.password==='loopback-test-only'?context.accept():context.reject();}
      else context.reject(['password']);
    });
    client.on('ready',()=>client.on('session',accept=>{
      const session=accept();session.on('pty',accept=>accept?.());
      session.on('shell',accept=>{const stream=accept();stream.on('error',()=>{});stream.write('fixture> ');});
    }));
  });servers.push(server);return server;};
  const server=createServer(key);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const profile:HostProfile={id:'fixture',name:'fixture',host:'127.0.0.1',port:(server.address() as {port:number}).port,username:'fixture',auth:'password',rememberHost:false,encoding:'utf8'};
  try{
    await run({knownFile,profile,passwords:()=>passwords,replaceIdentity:async()=>{
      server.close();
      const changedKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
      const replacement=createServer(changedKey);
      await new Promise<void>((resolve,reject)=>{replacement.once('error',reject);replacement.listen(profile.port,'127.0.0.1',resolve);});
    },service:()=>{
      const questions:HostQuestion[]=[];
      const service=new SshService(event=>{if(event.type==='hostKey')questions.push(event);},knownFile);
      services.push(service);return{service,questions};
    }});
  }finally{
    for(const service of services)service.shutdown();
    for(const connection of connections)connection.end();
    await Promise.all(servers.map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));
    assert.ok(directory.startsWith(base+path.sep));await fs.rm(directory,{recursive:true,force:true});
  }
}
async function pendingQuestion(service:SshService,questions:HostQuestion[],profile:HostProfile){
  const index=questions.length;
  const result=service.connect({profile,password:'loopback-test-only'}).then(
    session=>({session,error:undefined}),error=>({session:undefined,error:error as Error}),
  );
  const deadline=Date.now()+4000;
  while(questions.length===index){
    if(Date.now()>deadline)throw new Error('Expected a host identity question before authentication');
    await Promise.race([
      new Promise(resolve=>setTimeout(resolve,10)),
      result.then(outcome=>{throw outcome.error??new Error('Connected without the expected identity confirmation');}),
    ]);
  }
  return{question:questions[index],result};
}
function trustRecord(profile:HostProfile,fingerprint='SHA256:'+'A'.repeat(43)){
  return JSON.stringify({version:1,hosts:{[`[${profile.host}]:${profile.port}`]:{fingerprint,savedAt:'2020-01-01T00:00:00.000Z'}}},null,2);
}

test('temporary trust ignores a different saved identity, requires confirmation and never saves even a save decision',{timeout:15000},async()=>fixture(async f=>{
  const existing=trustRecord(f.profile);await fs.writeFile(f.knownFile,existing);
  const {service,questions}=f.service();
  for(const decision of ['reject','once','save'] as const){
    const passwordCount=f.passwords();
    const {question,result}=await pendingQuestion(service,questions,f.profile);
    assert.equal(question.previousFingerprint,undefined);
    assert.equal(question.saveAllowed,false);
    assert.match(question.fingerprint,/^SHA256:/);
    assert.equal(f.passwords(),passwordCount,'no password can be sent before this connection is confirmed');
    service.confirmHostKey(question.requestId,decision);
    const outcome=await result;
    if(decision==='reject'){
      assert.ok(outcome.error);assert.equal(f.passwords(),passwordCount);
    }else{
      assert.equal(outcome.error,undefined);assert.ok(outcome.session);assert.equal(f.passwords(),passwordCount+1);
      service.disconnect(outcome.session.id);
    }
    assert.equal(await fs.readFile(f.knownFile,'utf8'),existing,'temporary trust must neither replace nor delete saved identities');
  }
}));

test('temporary trust still confirms matching saved keys and works without reading corrupt saved data',{timeout:15000},async()=>fixture(async f=>{
  const {service,questions}=f.service();
  const first=await pendingQuestion(service,questions,f.profile);
  const matching=trustRecord(f.profile,first.question.fingerprint);
  service.confirmHostKey(first.question.requestId,'once');
  const firstResult=await first.result;assert.ok(firstResult.session);service.disconnect(firstResult.session.id);
  await assert.rejects(fs.stat(f.knownFile),{code:'ENOENT'});
  for(const contents of [matching,'{corrupt saved file that temporary mode must not read']){
    await fs.writeFile(f.knownFile,contents);
    const fresh=f.service();const passwordCount=f.passwords();
    const next=await pendingQuestion(fresh.service,fresh.questions,f.profile);
    assert.equal(next.question.previousFingerprint,undefined);assert.equal(next.question.saveAllowed,false);
    assert.equal(f.passwords(),passwordCount);
    fresh.service.confirmHostKey(next.question.requestId,'once');
    const outcome=await next.result;assert.ok(outcome.session);fresh.service.disconnect(outcome.session.id);
    assert.equal(await fs.readFile(f.knownFile,'utf8'),contents);
  }
}));

test('saved trust still autoaccepts a matching identity and warns before authenticating a changed identity',{timeout:15000},async()=>fixture(async f=>{
  const profile={...f.profile,rememberHost:true};const first=f.service();
  const attempt=await pendingQuestion(first.service,first.questions,profile);
  assert.equal(attempt.question.saveAllowed,true);assert.equal(f.passwords(),0);
  first.service.confirmHostKey(attempt.question.requestId,'save');
  const connected=await attempt.result;assert.ok(connected.session);first.service.disconnect(connected.session.id);
  const original=await fs.readFile(f.knownFile,'utf8');
  const matching=f.service();
  const again:SessionInfo=await matching.service.connect({profile,password:'loopback-test-only'});
  assert.equal(matching.questions.length,0);matching.service.disconnect(again.id);
  assert.equal(await fs.readFile(f.knownFile,'utf8'),original);
  const fake='SHA256:'+'B'.repeat(43);const changed=trustRecord(profile,fake);await fs.writeFile(f.knownFile,changed);
  const replacement=f.service();const passwordCount=f.passwords();
  const changedAttempt=await pendingQuestion(replacement.service,replacement.questions,profile);
  assert.equal(changedAttempt.question.previousFingerprint,fake);assert.equal(changedAttempt.question.saveAllowed,true);
  assert.equal(f.passwords(),passwordCount);
  replacement.service.confirmHostKey(changedAttempt.question.requestId,'reject');
  assert.ok((await changedAttempt.result).error);assert.equal(f.passwords(),passwordCount);
  assert.equal(await fs.readFile(f.knownFile,'utf8'),changed);
}));

test('temporary trust pins the confirmed identity for later connections in the same session',{timeout:15000},async()=>fixture(async f=>{
  const {service,questions}=f.service();
  const attempt=await pendingQuestion(service,questions,f.profile);
  service.confirmHostKey(attempt.question.requestId,'once');
  const connected=await attempt.result;assert.ok(connected.session);
  await f.replaceIdentity();
  const passwordCount=f.passwords();
  await assert.rejects(service.remoteList({sessionId:connected.session.id,path:'/'}),/后续连接返回了不同的服务器指纹/);
  assert.equal(questions.length,1,'a changed key cannot replace the identity already confirmed for this session');
  assert.equal(f.passwords(),passwordCount,'the replacement server must not receive the session password');
  await assert.rejects(fs.stat(f.knownFile),{code:'ENOENT'});
}));

test('opt-in automatic identity mode skips prompts and saved trust but still requires a valid password',{timeout:15000},async()=>fixture(async f=>{
  const profile={...f.profile,rememberHost:true};
  for(const contents of [trustRecord(profile),'{corrupt saved identity file']){
    await fs.writeFile(f.knownFile,contents);
    const {service,questions}=f.service();const passwordCount=f.passwords();
    const session=await service.connect({profile,password:'loopback-test-only',skipHostKeyVerification:true});
    assert.equal(questions.length,0);assert.equal(f.passwords(),passwordCount+1);service.disconnect(session.id);
    assert.equal(await fs.readFile(f.knownFile,'utf8'),contents);
    await assert.rejects(service.connect({profile,password:'wrong-password',skipHostKeyVerification:true}),/authentication|认证|methods failed/i);
    assert.equal(questions.length,0);assert.equal(await fs.readFile(f.knownFile,'utf8'),contents);
  }
}));

test('automatic identity mode accepts a replacement on a new session but refuses a changed key inside the existing session',{timeout:15000},async()=>fixture(async f=>{
  const {service,questions}=f.service();
  const connected=await service.connect({profile:f.profile,password:'loopback-test-only',skipHostKeyVerification:true});
  assert.equal(questions.length,0);
  await f.replaceIdentity();
  const passwordCount=f.passwords();
  await assert.rejects(service.remoteList({sessionId:connected.id,path:'/'}),/后续连接返回了不同的服务器指纹/);
  assert.equal(f.passwords(),passwordCount);assert.equal(questions.length,0);
  const replacement=await service.connect({profile:f.profile,password:'loopback-test-only',skipHostKeyVerification:true});
  assert.equal(f.passwords(),passwordCount+1);assert.equal(questions.length,0);service.disconnect(replacement.id);
  await assert.rejects(fs.stat(f.knownFile),{code:'ENOENT'});
}));
