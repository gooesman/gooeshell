import assert from 'node:assert/strict';
import {generateKeyPairSync, randomBytes} from 'node:crypto';
import {promises as fs} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {test, type TestContext} from 'node:test';
import {Server, type Connection} from 'ssh2';
import {SshService} from '../src/main/ssh-service';
import type {AppEvent, ConnectRequest, HostProfile} from '../src/shared/types';

const hostKey = generateKeyPairSync('rsa', {modulusLength:2048}).privateKey.export({type:'pkcs1', format:'pem'});
const otherHostKey = generateKeyPairSync('rsa', {modulusLength:2048}).privateKey.export({type:'pkcs1', format:'pem'});
const destination = 'private-target.fixture.invalid'; // Cannot resolve/connect without the jump's mapping.
const targetPassword = 'target-loopback-only';
const jumpPassword = 'jump-loopback-only';
type Question = Extract<AppEvent, {type:'hostKey'}>;
const waitFor = async (predicate:()=>boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Loopback jump fixture timed out'); await new Promise(resolve=>setTimeout(resolve,10)); }
};

// A small real SFTP endpoint: all bytes still pass through both encrypted SSH connections.
function serveFiles(sftp:any, files:Map<string,Buffer>, writeReply:(reply:()=>void)=>void) {
  const handles = new Map<string,{name:string; listed?:boolean}>(); let sequence=0;
  const attrs=(name:string)=>({mode:name==='/'?0o040755:0o100644,uid:1000,gid:1000,size:files.get(name)?.length??0,atime:1700000000,mtime:1700000000});
  const handle=(id:number,name:string)=>{const token=String(++sequence);handles.set(token,{name});sftp.handle(id,Buffer.from(token));};
  sftp.on('error',()=>{});
  sftp.on('REALPATH',(id:number,name:string)=>sftp.name(id,[{filename:name==='.'?'/':name,longname:name,attrs:attrs(name)}]));
  for(const event of ['LSTAT','STAT'])sftp.on(event,(id:number,name:string)=>name==='/'||files.has(name)?sftp.attrs(id,attrs(name)):sftp.status(id,2));
  sftp.on('FSTAT',(id:number,token:Buffer)=>{const item=handles.get(token.toString());item?sftp.attrs(id,attrs(item.name)):sftp.status(id,4);});
  sftp.on('OPENDIR',(id:number,name:string)=>name==='/'?handle(id,name):sftp.status(id,2));
  sftp.on('READDIR',(id:number,token:Buffer)=>{
    const item=handles.get(token.toString());if(!item||item.listed)return sftp.status(id,1);
    item.listed=true;sftp.name(id,[...files.keys()].map(name=>({filename:name.slice(1),longname:name,attrs:attrs(name)})));
  });
  sftp.on('OPEN',(id:number,name:string,flags:number)=>{
    if((flags&32)&&files.has(name))return sftp.status(id,4);
    if(!files.has(name)){if(!(flags&8))return sftp.status(id,2);files.set(name,Buffer.alloc(0));}
    handle(id,name);
  });
  sftp.on('READ',(id:number,token:Buffer,offset:number,length:number)=>{
    const item=handles.get(token.toString());const data=item&&files.get(item.name);
    if(!data)return sftp.status(id,4);if(offset>=data.length)return sftp.status(id,1);
    sftp.data(id,data.subarray(offset,offset+length));
  });
  sftp.on('WRITE',(id:number,token:Buffer,offset:number,data:Buffer)=>{
    const item=handles.get(token.toString());const before=item&&files.get(item.name);if(!item||!before)return sftp.status(id,4);
    const after=Buffer.alloc(Math.max(before.length,offset+data.length));before.copy(after);data.copy(after,offset);files.set(item.name,after);writeReply(()=>sftp.status(id,0));
  });
  sftp.on('CLOSE',(id:number,token:Buffer)=>{handles.delete(token.toString());sftp.status(id,0);});
  sftp.on('RENAME',(id:number,from:string,to:string)=>{
    const data=files.get(from);if(!data||files.has(to))return sftp.status(id,4);
    files.set(to,data);files.delete(from);sftp.status(id,0);
  });
}

async function fixture(t:TestContext) {
  const base=path.resolve('test-output');await fs.mkdir(base,{recursive:true});
  const root=await fs.mkdtemp(path.join(base,'jump-transport-'));
  const servers:Server[]=[];const targets=new Set<Connection>();const gateways=new Set<Connection>();const sockets=new Set<net.Socket>();
  const events:AppEvent[]=[];const services:SshService[]=[];const files=new Map([['/hello.txt',randomBytes(96*1024+13)]]);
  let targetConnections=0,jumpConnections=0,targetAuth=0,jumpAuth=0,forwards=0,sftpConnections=0;
  let denied=false,holdForward=false,holdJumpAuth=false,holdTargetAuth=false;
  let holdWrites=false;const heldWriteReplies:(()=>void)[]=[];
  const routeRequests:{host:string;port:number}[]=[];
  const targetServer=(key:string|Buffer)=>{
    const server=new Server({hostKeys:[key]},client=>{
      targetConnections++;targets.add(client);client.on('error',()=>{});client.on('close',()=>targets.delete(client));
      client.on('authentication',context=>{
        if(context.method!=='password')return context.reject(['password']);targetAuth++;
        if(holdTargetAuth)return;
        context.username==='target-user'&&context.password===targetPassword?context.accept():context.reject();
      });
      client.on('ready',()=>client.on('session',accept=>{
        const session=accept();session.on('pty',accept=>accept?.());session.on('window-change',accept=>accept?.());
        session.on('shell',accept=>{const stream=accept();stream.on('error',()=>{});stream.write('TARGET-READY>');stream.on('data',(data:Buffer)=>stream.write(Buffer.concat([Buffer.from('ECHO:'),data])));});
        session.on('sftp',accept=>{sftpConnections++;serveFiles(accept(),files,reply=>holdWrites?heldWriteReplies.push(reply):reply());});
      }));
    });servers.push(server);return server;
  };
  let target=targetServer(hostKey);
  await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));
  const targetPort=(target.address() as net.AddressInfo).port;
  const addJump=async(key:string|Buffer=hostKey)=>{
    const server=new Server({hostKeys:[key]},client=>{
      jumpConnections++;gateways.add(client);client.on('error',()=>{});client.on('close',()=>gateways.delete(client));
      client.on('authentication',context=>{
        if(context.method!=='password')return context.reject(['password']);jumpAuth++;
        if(holdJumpAuth)return;
        context.username==='gateway-user'&&context.password===jumpPassword?context.accept():context.reject();
      });
      client.on('ready',()=>client.on('tcpip',(accept,reject,info)=>{
        forwards++;routeRequests.push({host:info.destIP,port:info.destPort});
        if(holdForward)return;
        if(denied||info.destIP!==destination||info.destPort!==22)return reject();
        const socket=net.createConnection({host:'127.0.0.1',port:targetPort});sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
        socket.once('error',()=>reject());
        socket.once('connect',()=>{
          const stream=accept();stream.on('error',()=>socket.destroy());stream.on('close',()=>socket.destroy());
          socket.removeAllListeners('error');socket.on('error',()=>stream.destroy());socket.pipe(stream).pipe(socket);
        });
      }));
    });servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return(server.address() as net.AddressInfo).port;
  };
  const jumpPort=await addJump();
  const profile:HostProfile={id:'target-fixture',name:'Loopback target',host:destination,port:22,username:'target-user',auth:'password',rememberHost:true,encoding:'utf8',
    jumpHost:{id:'jump-fixture',name:'Loopback gateway',host:'127.0.0.1',port:jumpPort,username:'gateway-user',auth:'password',rememberHost:true,reuseConnection:true}};
  const knownFile=path.join(root,'known.json');
  const service=new SshService(event=>events.push(event),knownFile);services.push(service);
  const request=(extra:Partial<ConnectRequest>={}):ConnectRequest=>({profile,password:targetPassword,jumpPassword,...extra});
  const automatic=(extra:Partial<ConnectRequest>={}):ConnectRequest=>request({skipHostKeyVerification:true,skipJumpHostKeyVerification:true,...extra});
  const counters=()=>({targetConnections,jumpConnections,targetAuth,jumpAuth,forwards,sftpConnections});
  const questions=()=>events.filter((event):event is Question=>event.type==='hostKey');
  const output=(id:string)=>events.filter((event):event is Extract<AppEvent,{type:'terminal'}>=>event.type==='terminal'&&event.sessionId===id).map(event=>Buffer.from(event.data,'base64').toString()).join('');
  const idle=()=>{
    const internal=service as any;
    assert.equal(internal.sessions.size,0);assert.equal(internal.jumps.size,0);assert.equal(internal.jumpPool.size,0);assert.equal(internal.questions.size,0);
  };
  t.after(async()=>{
    for(const service of services)service.shutdown();for(const client of [...targets,...gateways])client.end();for(const socket of sockets)socket.destroy();
    await Promise.all(servers.map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));
    const absolute=path.resolve(root);assert(absolute.startsWith(base+path.sep));await fs.rm(absolute,{recursive:true,force:true});
  });
  return {root,profile,service,events,request,automatic,counters,questions,output,idle,files,knownFile,routeRequests,targets,gateways,addJump,
    holdWrites:(value:boolean)=>{holdWrites=value;if(!value)for(const reply of heldWriteReplies.splice(0))reply();},heldWrites:()=>heldWriteReplies.length,
    denied:(value:boolean)=>denied=value,holdForward:(value:boolean)=>holdForward=value,holdJumpAuth:(value:boolean)=>holdJumpAuth=value,holdTargetAuth:(value:boolean)=>holdTargetAuth=value,
    rotateTarget:async()=>{target.close();target=targetServer(otherHostKey);await new Promise<void>((resolve,reject)=>{target.once('error',reject);target.listen(targetPort,'127.0.0.1',resolve);});},
  };
}

test('jump and target trust precede their own credentials; shell, SFTP and resumed transfers all use the jump', {timeout:20000}, async t=>{
  const f=await fixture(t);const pending=f.service.connect(f.request());
  await waitFor(()=>f.questions().length===1);assert.equal(f.questions()[0].role,'jump');assert.equal(f.counters().jumpAuth,0);assert.equal(f.counters().targetAuth,0);
  f.service.confirmHostKey(f.questions()[0].requestId,'save');
  await waitFor(()=>f.questions().length===2);const target=f.questions()[1];assert.equal(target.role,'target');assert.match(target.via!,/gateway-user@\[127\.0\.0\.1\]/);
  assert.equal(f.counters().jumpAuth,1);assert.equal(f.counters().targetAuth,0);
  f.service.confirmHostKey(target.requestId,'save');const connected=await pending;
  const trust=JSON.parse(await fs.readFile(f.knownFile,'utf8'));
  assert(trust.hosts[`[127.0.0.1]:${f.profile.jumpHost!.port}`]);assert(!trust.hosts[`[${destination}]:22`]);
  assert.equal(Object.keys(trust.hosts).filter(key=>key.startsWith('via:')).length,1);
  assert.equal(f.output(connected.id),'');f.service.terminalResize(connected.id,100,30);await waitFor(()=>f.output(connected.id).includes('TARGET-READY>'));
  f.service.terminalInput(connected.id,'through-jump\r');await waitFor(()=>f.output(connected.id).includes('ECHO:through-jump\r'));
  const listing=await f.service.remoteList({sessionId:connected.id,path:'/'});assert.equal(listing.entries[0].name,'hello.txt');
  const upload=randomBytes(128*1024+29);const uploadPath=path.join(f.root,'upload.bin');await fs.writeFile(uploadPath,upload);
  f.files.set('/upload.bin.gooeshell.part',upload.subarray(0,71003));
  const download=f.files.get('/hello.txt')!;await fs.writeFile(path.join(f.root,'hello.txt.gooeshell.part'),download.subarray(0,37009));
  f.holdWrites(true);
  const jobs=[f.service.transfer({sessionId:connected.id,direction:'upload',source:uploadPath,destinationDir:'/',resume:true}),
    f.service.transfer({sessionId:connected.id,direction:'download',source:'/hello.txt',destinationDir:f.root,resume:true})];
  await waitFor(()=>f.heldWrites()>0);f.service.terminalInput(connected.id,'typing-during-upload\r');await waitFor(()=>f.output(connected.id).includes('ECHO:typing-during-upload'));
  assert(!f.events.some(event=>event.type==='transfer'&&event.transfer.id===jobs[0]&&event.transfer.state==='completed'));
  f.holdWrites(false);
  await waitFor(()=>jobs.every(id=>f.events.some(event=>event.type==='transfer'&&event.transfer.id===id&&['failed','completed'].includes(event.transfer.state))));
  for(const id of jobs){const final=f.events.filter((event):event is Extract<AppEvent,{type:'transfer'}>=>event.type==='transfer'&&event.transfer.id===id).at(-1)!;assert.equal(final.transfer.state,'completed',final.transfer.error);}
  assert.deepEqual(f.files.get('/upload.bin'),upload);assert.deepEqual(await fs.readFile(path.join(f.root,'hello.txt')),download);
  assert.equal(f.counters().jumpConnections,1);assert.equal(f.counters().jumpAuth,1);assert.equal(f.counters().targetAuth,4);assert.equal(f.counters().sftpConnections,3);
  assert(f.routeRequests.every(route=>route.host===destination&&route.port===22));
  f.service.disconnect(connected.id);f.idle();await waitFor(()=>f.gateways.size===0);
  const reconnect=await f.service.connect(f.request());assert.equal(f.questions().length,2,'saved route identities allow a later fresh connection');
  assert.equal(f.counters().jumpConnections,2,'last close releases the pooled hop');f.service.disconnect(reconnect.id);f.idle();
});

test('concurrent reusable connections share one hop; closing or failing one target leaves the other usable', {timeout:15000}, async t=>{
  const f=await fixture(t);const [first,second]=await Promise.all([f.service.connect(f.automatic()),f.service.connect(f.automatic())]);
  assert.equal(f.counters().jumpConnections,1);assert.equal(f.counters().jumpAuth,1);assert.equal(f.counters().targetAuth,2);
  f.service.disconnect(first.id);assert(!f.events.some(event=>event.type==='sessionClosed'&&event.sessionId===second.id));
  await assert.rejects(f.service.connect(f.automatic({password:'wrong-target-password'})),/authentication|认证/i);
  assert.equal(f.counters().jumpConnections,1);assert.equal((await f.service.remoteList({sessionId:second.id,path:'/'})).entries.length,1);
  f.service.terminalResize(second.id,100,30);f.service.terminalInput(second.id,'still-alive\r');await waitFor(()=>f.output(second.id).includes('ECHO:still-alive'));
  f.service.disconnect(second.id);f.idle();await waitFor(()=>f.gateways.size===0);
});

test('disabled reuse gives each target its own hop while retaining one hop for its file operations', {timeout:15000}, async t=>{
  const f=await fixture(t);const profile={...f.profile,jumpHost:{...f.profile.jumpHost!,reuseConnection:false}};
  const sessions=await Promise.all([f.service.connect(f.automatic({profile})),f.service.connect(f.automatic({profile}))]);
  await Promise.all(sessions.map(session=>f.service.remoteList({sessionId:session.id,path:'/'})));
  assert.equal(f.counters().jumpConnections,2);assert.equal(f.counters().jumpAuth,2);assert.equal(f.counters().targetAuth,4);
  f.service.disconnect(sessions[0].id);await waitFor(()=>f.gateways.size===1);f.service.disconnect(sessions[1].id);f.idle();
});

test('a changed jump password or trust policy cannot borrow an already authenticated transport', {timeout:15000}, async t=>{
  const f=await fixture(t);const original=await f.service.connect(f.automatic());
  await assert.rejects(f.service.connect(f.automatic({jumpPassword:'wrong-jump-password'})),/JUMP_AUTH_FAILED/);
  assert.equal(f.counters().jumpConnections,2);assert.equal(f.counters().targetAuth,1,'wrong jump credential never reaches target');
  const shared=await f.service.connect(f.automatic());assert.equal(f.counters().jumpConnections,2);
  const changed=f.service.connect(f.automatic({skipJumpHostKeyVerification:false}));
  await waitFor(()=>f.questions().length===1);assert.equal(f.questions()[0].role,'jump');assert.equal(f.counters().jumpAuth,2);
  f.service.confirmHostKey(f.questions()[0].requestId,'once');const separate=await changed;
  assert.equal(f.counters().jumpConnections,3);
  for(const session of [original,shared,separate])f.service.disconnect(session.id);f.idle();
});

test('missing and encrypted jump private keys report the jump authentication stage and leave no live route', {timeout:15000}, async t=>{
  const f=await fixture(t);const profile={...f.profile,jumpHost:{...f.profile.jumpHost!,auth:'key' as const,privateKeyPath:path.join(f.root,'missing-key')}};
  await assert.rejects(f.service.connect(f.automatic({profile})),/JUMP_AUTH_FAILED.*跳板机/);f.idle();
  const encrypted=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem',cipher:'aes-256-cbc',passphrase:'fixture-key-passphrase'});
  profile.jumpHost.privateKeyPath=path.join(f.root,'encrypted-key');await fs.writeFile(profile.jumpHost.privateKeyPath,encrypted);
  await assert.rejects(f.service.connect(f.automatic({profile,jumpPassphrase:'wrong-passphrase'})),/JUMP_AUTH_FAILED.*跳板机/);f.idle();
  assert.equal(f.counters().targetConnections,0);assert.equal(f.counters().jumpAuth,0);
  const retry=await f.service.connect(f.automatic());f.service.disconnect(retry.id);f.idle();
});

test('cancelling one pending consumer preserves the shared trust prompt; cancelling the last dismisses it', {timeout:15000}, async t=>{
  const f=await fixture(t);const first=f.service.connect(f.request({attemptId:'first',skipHostKeyVerification:true}));const rejected=assert.rejects(first,/CONNECTION_CANCELLED/);
  const second=f.service.connect(f.request({attemptId:'second',skipHostKeyVerification:true}));
  await waitFor(()=>f.questions().length===1);const question=f.questions()[0];f.service.cancelConnect('first');await rejected;
  assert(!f.events.some(event=>event.type==='hostKeyCancelled'&&event.requestId===question.requestId));assert.equal(f.counters().jumpConnections,1);
  f.service.confirmHostKey(question.requestId,'once');const connected=await second;assert.equal(f.counters().jumpAuth,1);
  f.service.disconnect(connected.id);f.idle();
  const third=f.service.connect(f.request({attemptId:'last'}));const lastRejected=assert.rejects(third,/CONNECTION_CANCELLED/);
  await waitFor(()=>f.questions().length===2);const last=f.questions()[1];f.service.cancelConnect('last');await lastRejected;
  assert(f.events.some(event=>event.type==='hostKeyCancelled'&&event.requestId===last.requestId));f.idle();
  const retry=await f.service.connect(f.automatic({attemptId:'last'}));f.service.disconnect(retry.id);f.idle();
});

test('rejected jump trust never sends passwords and rejected target trust never sends its password', {timeout:15000}, async t=>{
  const f=await fixture(t);const first=f.service.connect(f.request());const rejected=assert.rejects(first);
  await waitFor(()=>f.questions().length===1);f.service.confirmHostKey(f.questions()[0].requestId,'reject');await rejected;
  assert.equal(f.counters().jumpAuth,0);assert.equal(f.counters().targetAuth,0);f.idle();
  const next=f.service.connect(f.request({skipJumpHostKeyVerification:true}));const targetRejected=assert.rejects(next);
  await waitFor(()=>f.questions().length===2);assert.equal(f.questions()[1].role,'target');f.service.confirmHostKey(f.questions()[1].requestId,'reject');await targetRejected;
  assert.equal(f.counters().jumpAuth,1);assert.equal(f.counters().targetAuth,0);f.idle();
});

test('denied forwarding has no direct fallback; cancelled forwarding and authentication release the last hop', {timeout:15000}, async t=>{
  const f=await fixture(t);f.denied(true);await assert.rejects(f.service.connect(f.automatic()),/转发/);assert.equal(f.counters().targetConnections,0);f.idle();
  f.denied(false);f.holdForward(true);
  const pending=f.service.connect(f.automatic({attemptId:'forward'}));const cancelled=assert.rejects(pending,/CONNECTION_CANCELLED/);
  await waitFor(()=>f.counters().forwards===2);f.service.cancelConnect('forward');await cancelled;f.idle();
  f.holdForward(false);f.holdJumpAuth(true);
  const auth=f.service.connect(f.automatic({attemptId:'authentication'}));const authCancelled=assert.rejects(auth,/CONNECTION_CANCELLED/);
  await waitFor(()=>f.counters().jumpAuth===3);f.service.cancelConnect('authentication');await authCancelled;f.idle();
  f.holdJumpAuth(false);f.holdTargetAuth(true);
  const target=f.service.connect(f.automatic({attemptId:'target-auth'}));const targetCancelled=assert.rejects(target,/CONNECTION_CANCELLED/);
  await waitFor(()=>f.counters().targetAuth===1);f.service.cancelConnect('target-auth');await targetCancelled;f.idle();
  f.holdTargetAuth(false);const retry=await f.service.connect(f.automatic());f.service.disconnect(retry.id);f.idle();
});

test('jump loss disconnects every dependent target and reconnect creates a fresh transport', {timeout:15000}, async t=>{
  const f=await fixture(t);const sessions=await Promise.all([f.service.connect(f.automatic()),f.service.connect(f.automatic())]);
  for(const gateway of f.gateways)gateway.end();
  await waitFor(()=>sessions.every(session=>f.events.some(event=>event.type==='sessionClosed'&&event.sessionId===session.id)));
  f.idle();for(const session of sessions)assert.throws(()=>f.service.transfer({sessionId:session.id,direction:'download',source:'/hello.txt',destinationDir:f.root,resume:true}),/已断开/);
  const retry=await f.service.connect(f.automatic());assert.equal(f.counters().jumpConnections,2);f.service.disconnect(retry.id);f.idle();
});

test('target private-IP trust is scoped to the jump route and target fingerprint stays pinned for later SFTP channels', {timeout:20000}, async t=>{
  const f=await fixture(t);
  const connectWithSavedTarget=async(profile:HostProfile)=>{
    const index=f.questions().length;const pending=f.service.connect(f.request({profile,skipJumpHostKeyVerification:true}));
    await waitFor(()=>f.questions().length===index+1);const question=f.questions()[index];assert.equal(question.role,'target');assert.equal(question.previousFingerprint,undefined);
    f.service.confirmHostKey(question.requestId,'save');return pending;
  };
  const original=await connectWithSavedTarget(f.profile);
  const otherPort=await f.addJump();const other=await connectWithSavedTarget({...f.profile,jumpHost:{...f.profile.jumpHost!,port:otherPort}});
  assert.equal(Object.keys(JSON.parse(await fs.readFile(f.knownFile,'utf8')).hosts).filter(key=>key.startsWith('via:')).length,2);
  const authBefore=f.counters().targetAuth;await f.rotateTarget();
  await assert.rejects(f.service.remoteList({sessionId:original.id,path:'/'}),/后续连接返回了不同的服务器指纹/);
  assert.equal(f.counters().targetAuth,authBefore,'changed target receives no stored password');assert.equal(f.questions().length,2);
  f.service.disconnect(original.id);f.service.disconnect(other.id);f.idle();
});

test('cancelling a file connection does not disconnect its shell or another session sharing the jump', {timeout:15000}, async t=>{
  const f=await fixture(t);const [first,second]=await Promise.all([f.service.connect(f.automatic()),f.service.connect(f.automatic())]);
  f.holdForward(true);const id=f.service.transfer({sessionId:first.id,direction:'download',source:'/hello.txt',destinationDir:f.root,resume:true});
  await waitFor(()=>f.counters().forwards===3);f.service.cancelTransfer(id);
  await waitFor(()=>f.events.some(event=>event.type==='transfer'&&event.transfer.id===id&&event.transfer.state==='cancelled'));
  f.holdForward(false);assert.equal((await f.service.remoteList({sessionId:second.id,path:'/'})).entries.length,1);
  assert(!f.events.some(event=>event.type==='sessionClosed'));
  f.service.disconnect(first.id);f.service.disconnect(second.id);f.idle();
});
