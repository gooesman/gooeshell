import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {Server,type Connection} from 'ssh2';
import {SshService} from '../src/main/ssh-service';

test('bridge commands reuse SSH authentication, isolate foreground input and bound output/cancellation',async t=>{
  const base=path.resolve('test-output');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'bridge-command-'));
  const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
  const peers=new Set<Connection>();let authentications=0,shells=0,foreground='',lastCommand='',lastInput='';
  const server=new Server({hostKeys:[key]},client=>{
    peers.add(client);client.on('close',()=>peers.delete(client));client.on('error',()=>{});
    client.on('authentication',context=>{if(context.method==='password'&&context.password==='isolated-secret'){authentications++;context.accept();}else context.reject();});
    client.on('ready',()=>client.on('session',accept=>{
      const channel=accept();channel.on('pty',accept=>accept?.());channel.on('window-change',accept=>accept?.());
      channel.on('shell',accept=>{shells++;const stream=accept();stream.write('PROMPT>');stream.on('data',bytes=>foreground+=bytes.toString());});
      channel.on('exec',(accept,_reject,info)=>{
        lastCommand=info.command;lastInput='';const stream=accept();stream.on('data',bytes=>lastInput+=bytes.toString());
        stream.on('end',()=>{
          if(info.command.includes('HOLD'))return;
          if(info.command.includes('BULK'))stream.write(Buffer.alloc(100000,65));
          else{stream.write('中文 output\n');stream.stderr.write('stderr\n');}
          stream.exit(7);stream.end();
        });
      });
    }));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const service=new SshService(event=>{if(event.type==='hostKey')service.confirmHostKey(event.requestId,'once');},path.join(root,'known-hosts.json'));
  t.after(async()=>{await service.shutdown();for(const peer of peers)peer.end();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const profile={id:'fixture',name:'Fixture',host:'127.0.0.1',port:(server.address() as {port:number}).port,username:'fixture',auth:'password' as const,rememberHost:false,encoding:'utf8' as const};
  const session=await service.connect({profile,password:'isolated-secret'});service.terminalResize(session.id,80,24);
  const request={sessionId:session.id,requestId:'first',command:"printf '中文'",sudo:false,timeoutMs:5000};
  const result=await service.bridgeExec(request);
  assert.deepEqual(result,{stdout:'中文 output\n',stderr:'stderr\n',exitCode:7,signal:null,truncated:false});
  assert.equal(authentications,1);assert.equal(shells,1);assert.equal(foreground,'');
  const sudo=await service.bridgeExec({...request,requestId:'sudo',sudo:true,password:'isolated-sudo-secret',cwd:"/tmp/path ' quoted"});
  assert.equal(sudo.exitCode,7);assert.equal(lastInput,'isolated-sudo-secret\n');assert(!lastCommand.includes('isolated-sudo-secret'));assert.match(lastCommand,/sudo -S -p '' --/);assert.match(lastCommand,/< \/dev\/null/);
  await service.bridgeExec({...request,requestId:'nopass',sudo:true});assert.match(lastCommand,/sudo -n --/);assert.equal(lastInput,'');
  const bulk=await service.bridgeExec({...request,requestId:'bulk',command:'BULK'});assert.equal(Buffer.byteLength(bulk.stdout)+Buffer.byteLength(bulk.stderr),65536);assert.equal(bulk.truncated,true);
  await assert.rejects(service.bridgeExec({...request,requestId:'timeout',command:'HOLD',timeoutMs:100}),/超时/);
  const cancellation=service.bridgeExec({...request,requestId:'cancel',command:'HOLD'});await new Promise(resolve=>setTimeout(resolve,50));service.cancelBridgeExec('cancel');await assert.rejects(cancellation,/取消/);
  assert.equal((await service.bridgeExec({...request,requestId:'after'})).exitCode,7);assert.equal(authentications,1);
  await assert.rejects(service.bridgeExec({...request,requestId:'bad',command:'bad\0command'}),/无效/);
  const background=await service.connect({profile,password:'isolated-secret',bridgeOnly:true});assert.equal(shells,1,'MCP background connections do not create an unused interactive shell');
  assert.equal((await service.bridgeExec({...request,sessionId:background.id,requestId:'background'})).exitCode,7);
  await service.disconnect(background.id);assert.equal((await service.bridgeExec({...request,requestId:'survives'})).exitCode,7);
});
