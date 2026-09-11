const {app,BrowserWindow,dialog,safeStorage}=require('electron');
const {promises:fs,mkdirSync,writeFileSync}=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {randomBytes,createCipheriv,createDecipheriv,generateKeyPairSync}=require('node:crypto');
const {Server}=require('ssh2');
const net=require('node:net');
const {Worker}=require('node:worker_threads');
const artifacts=process.env.GOOESHELL_CONNECTION_MAIN_ARTIFACTS;
if(!artifacts||!path.isAbsolute(artifacts)||!path.basename(artifacts).startsWith('connection-main-'))throw new Error('Explicit isolated fixture directory required');
const userData=path.join(artifacts,'user-data');mkdirSync(userData,{recursive:true});app.setPath('userData',userData);
const report={success:false,checks:{},errors:[]};const saveReport=()=>writeFileSync(path.join(artifacts,'result.json'),JSON.stringify(report,null,2));
const fail=error=>{report.errors.push(error?.stack||String(error));saveReport();app.exit(1);};
process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
const cipherKey=randomBytes(32);let encryptionAvailable=true;
const encrypt=text=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',cipherKey,iv);const bytes=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]);};
const decrypt=bytes=>{const decipher=createDecipheriv('aes-256-gcm',cipherKey,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');};
// These replace only the fixture process's cipher. No real OS keyring is read or changed.
safeStorage.isEncryptionAvailable=()=>encryptionAvailable;safeStorage.isAsyncEncryptionAvailable=async()=>encryptionAvailable;
safeStorage.getSelectedStorageBackend=()=>encryptionAvailable?'gnome_libsecret':'basic_text';
safeStorage.encryptString=encrypt;safeStorage.decryptString=decrypt;safeStorage.encryptStringAsync=async value=>encrypt(value);safeStorage.decryptStringAsync=async value=>({result:decrypt(value),shouldReEncrypt:false});
const hostKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
let connectionWorker;const workerPost=Worker.prototype.postMessage;
Worker.prototype.postMessage=function(message,...rest){if(message?.method==='connect')connectionWorker=this;return workerPost.call(this,message,...rest);};
let window,holdAuth=false,authRequests=0,pendingAuth;let received='';const peers=new Set(),targetAccounts=[];
const server=new Server({hostKeys:[hostKey]},client=>{
  peers.add(client);client.on('close',()=>peers.delete(client));client.on('error',()=>{});
  client.on('authentication',context=>{
    if(context.method!=='password')return context.reject(['password']);authRequests++;targetAccounts.push(context.username);
    if(holdAuth){pendingAuth=context;return;}
    context.password==='fixture-login-secret'?context.accept():context.reject(['password']);
  });
  client.on('ready',()=>client.on('session',accept=>{const session=accept();session.on('pty',accept=>accept?.());session.on('window-change',accept=>accept?.());session.on('shell',accept=>{const stream=accept();stream.write('FIXTURE>');stream.on('data',bytes=>received+=bytes.toString('utf8'));});}));
});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate){const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw new Error('Fixture timeout');await delay(10);}}
const call=(method,value)=>window.webContents.executeJavaScript(`window.gooeshell[${JSON.stringify(method)}](${JSON.stringify(value)})`);
const startConnect=async request=>{await window.webContents.executeJavaScript(`window.fixtureConnect=window.gooeshell.connect(${JSON.stringify(request)}).then(value=>({value}),error=>({error:String(error)})); true`);};
const finishConnect=()=>window.webContents.executeJavaScript('window.fixtureConnect');
app.on('browser-window-created',(_event,created)=>{window=created;window.on('show',()=>window.hide());window.webContents.once('did-finish-load',()=>void run().catch(fail));});
async function checkJumpCredentials(){
  let jumpAuthRequests=0,forwardRequests=0;
  const jumpPeers=new Set(),sockets=new Set();
  const jumpKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
  const jumpServer=new Server({hostKeys:[jumpKey]},client=>{
    jumpPeers.add(client);client.on('close',()=>jumpPeers.delete(client));client.on('error',()=>{});
    client.on('authentication',context=>{
      if(context.method!=='password')return context.reject(['password']);jumpAuthRequests++;
      context.username==='gateway-user'&&context.password==='fixture-jump-secret'?context.accept():context.reject(['password']);
    });
    client.on('ready',()=>client.on('tcpip',(accept,reject,info)=>{
      // This deliberately differs from the target's actual bound address, so a
      // mistaken direct connection cannot satisfy the fixture.
      if(info.destIP!=='127.0.0.2'||info.destPort!==server.address().port)return reject();
      forwardRequests++;
      const socket=net.connect({host:'127.0.0.1',port:server.address().port});sockets.add(socket);
      socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
      socket.once('connect',()=>{const stream=accept();stream.on('error',()=>{});stream.on('close',()=>socket.destroy());socket.on('close',()=>stream.destroy());stream.pipe(socket).pipe(stream);});
    }));
  });
  await new Promise(resolve=>jumpServer.listen(0,'127.0.0.1',resolve));
  const jump={id:'fixture-shared-jump',name:'Loopback gateway',host:'127.0.0.1',port:jumpServer.address().port,username:'gateway-user',auth:'password',rememberHost:true,reuseConnection:false};
  let target={id:'fixture-via-jump',name:'Private target',host:'127.0.0.2',port:server.address().port,username:'target-user',auth:'password',rememberHost:true,encoding:'utf8',jumpHost:jump};
  const targetAuthBefore=authRequests;
  target=await call('saveConnection',{profile:{...target,password:'profile-secret-must-be-removed',jumpHost:{...jump,password:'hop-profile-secret-must-be-removed'}},favorite:true,credentials:{remember:'persistent',password:'fixture-login-secret',sudoUsesLogin:true,jump:{remember:'persistent',password:'fixture-jump-secret'}}});
  assert.equal(authRequests,targetAuthBefore);assert.equal(jumpAuthRequests,0);
  const status=await call('credentialStatus',target);
  assert.equal(status.remember,'persistent');assert.equal(status.hasPassword,true);assert.equal(status.jump.remember,'persistent');assert.equal(status.jump.hasPassword,true);
  const state=await call('connections');assert.deepEqual(state.connections.find(value=>value.id===target.id).jumpHost,target.jumpHost);
  const catalogText=await fs.readFile(path.join(userData,'connections.json'),'utf8');
  const secretText=await fs.readFile(path.join(userData,'credentials.encrypted.json'),'utf8');
  for(const secret of ['fixture-login-secret','fixture-jump-secret','profile-secret-must-be-removed','hop-profile-secret-must-be-removed']){
    assert(!catalogText.includes(secret));assert(!secretText.includes(secret));assert(!JSON.stringify(status).includes(secret));
  }
  const encryptedRecords=JSON.parse(secretText).records;
  assert(encryptedRecords.some(value=>value.id===target.id));assert.equal(encryptedRecords.filter(value=>value.id.startsWith('jump:')).length,1);
  report.checks.jumpSaveOnlyEncrypted=true;

  await window.webContents.executeJavaScript("window.fixtureJumpEvents=[];window.fixtureJumpErrors=[];window.fixtureJumpListener=window.gooeshell.onEvent(event=>{window.fixtureJumpEvents.push(event);if(event.type==='hostKey')window.gooeshell.confirmHostKey(event.requestId,'once').catch(error=>window.fixtureJumpErrors.push(String(error)));});true");
  // The IPC caller cannot bypass the independently stored fingerprint policies.
  const connected=await call('connect',{profile:target,attemptId:'jump-main-first',skipHostKeyVerification:true,skipJumpHostKeyVerification:true,jumpPassword:'wrong-caller-secret'});
  assert(connected.id);assert.equal(jumpAuthRequests,1);assert.equal(forwardRequests,1);assert.equal(targetAccounts.at(-1),'target-user');
  let events=await window.webContents.executeJavaScript('window.fixtureJumpEvents');
  assert.deepEqual(events.filter(event=>event.type==='hostKey').map(event=>event.role).sort(),['jump','target']);
  assert.deepEqual(await window.webContents.executeJavaScript('window.fixtureJumpErrors'),[]);
  const marker='main-jump-terminal-marker';const receivedBefore=received.length;
  await window.webContents.executeJavaScript(`window.gooeshell.terminalResize(${JSON.stringify(connected.id)},100,30);window.gooeshell.terminalInput(${JSON.stringify(connected.id)},${JSON.stringify(marker)});true`);
  await waitFor(()=>received.slice(receivedBefore).includes(marker));
  await call('disconnect',connected.id);report.checks.jumpSeparateAuthentication=true;report.checks.jumpBothHostKeyRoles=true;

  await call('saveCredentials',{profile:target,credentials:{remember:'persistent',sudoUsesLogin:true,jump:{remember:'session'}}});
  let changed=await call('credentialStatus',target);assert.equal(changed.remember,'persistent');assert.equal(changed.jump.remember,'session');
  const mixedRecords=JSON.parse(await fs.readFile(path.join(userData,'credentials.encrypted.json'),'utf8')).records;
  assert(mixedRecords.some(value=>value.id===target.id));assert(!mixedRecords.some(value=>value.id.startsWith('jump:')));
  report.checks.jumpIndependentRemember=true;

  const other=await call('saveConnection',{profile:{...target,id:'fixture-via-shared-jump',name:'Other private target',username:'other-target-user'},favorite:true,credentials:{remember:'session',password:'fixture-login-secret',sudoUsesLogin:true}});
  assert.notEqual(other.id,target.id);assert.equal(other.jumpHost.id,target.jumpHost.id);
  changed=await call('credentialStatus',other);assert.equal(changed.remember,'session');assert.equal(changed.jump.hasPassword,true);assert.equal(changed.jump.remember,'session');
  await call('setHostKeyPreference',{host:jump.host,port:jump.port,skipVerification:true});
  await window.webContents.executeJavaScript('window.fixtureJumpEvents=[];true');
  const shared=await call('connect',{profile:other,attemptId:'jump-main-shared'});assert(shared.id);assert.equal(targetAccounts.at(-1),'other-target-user');await call('disconnect',shared.id);
  events=await window.webContents.executeJavaScript('window.fixtureJumpEvents');
  assert.deepEqual(events.filter(event=>event.type==='hostKey').map(event=>event.role),['target']);
  report.checks.jumpSharedPreset=true;report.checks.jumpIndependentHostKeyPolicy=true;

  await call('forgetJumpCredentials',jump);
  changed=await call('credentialStatus',target);assert.equal(changed.hasPassword,true);assert.equal(changed.jump.hasPassword,false);
  assert.equal((await call('credentialStatus',other)).jump.hasPassword,false);
  const requestsBefore=jumpAuthRequests;
  await assert.rejects(call('connect',{profile:target,attemptId:'jump-main-missing'}),/JUMP_AUTH_REQUIRED/);assert.equal(jumpAuthRequests,requestsBefore);
  await call('saveCredentials',{profile:target,credentials:{remember:'persistent',sudoUsesLogin:true,jump:{remember:'persistent',password:'fixture-jump-secret'}}});
  await call('forgetCredentials',target.id);
  changed=await call('credentialStatus',target);assert.equal(changed.hasPassword,false);assert.equal(changed.jump.hasPassword,true);
  assert.equal((await call('credentialStatus',other)).hasPassword,true);
  report.checks.jumpForgetIsolation=true;

  await call('saveCredentials',{profile:target,credentials:{remember:'persistent',password:'fixture-login-secret',sudoUsesLogin:true}});
  await call('setHostKeyPreference',{host:target.host,port:target.port,skipVerification:true});
  holdAuth=true;pendingAuth=undefined;
  await startConnect({profile:target,attemptId:'jump-main-forget-during-auth',credentials:{remember:'persistent',password:'fixture-login-secret',sudoUsesLogin:true,jump:{remember:'persistent',password:'fixture-jump-secret'}}});
  await waitFor(()=>!!pendingAuth);await call('forgetJumpCredentials',jump);pendingAuth.accept();holdAuth=false;
  const completed=(await finishConnect()).value;assert(completed?.id);
  changed=await call('credentialStatus',target);assert.equal(changed.hasPassword,true);assert.equal(changed.jump.hasPassword,false);
  assert.equal((await call('credentialStatus',other)).jump.hasPassword,false);await call('disconnect',completed.id);
  report.checks.jumpForgetDuringAuth=true;
  await window.webContents.executeJavaScript('window.fixtureJumpListener();true');
  for(const peer of jumpPeers)peer.end();for(const socket of sockets)socket.destroy();
  await new Promise(resolve=>jumpServer.close(resolve));
}
async function run(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let profile={id:'fixture',name:'Fixture',host:'127.0.0.1',port:server.address().port,username:'tester',auth:'password',rememberHost:false,encoding:'utf8'};
  assert.equal((await call('credentialStatus',{...profile,host:''})).secureStorageAvailable,true);report.checks.emptyDraftStatus=true;
  await call('saveGroup',{id:'fixture-group',name:'测试连接',icon:'folder',order:0});
  profile=await call('saveConnection',{profile:{...profile,groupId:'fixture-group'},favorite:false,credentials:{remember:'session',password:'fixture-login-secret',sudoPassword:'fixture-sudo-secret',sudoUsesLogin:false}});
  const state=await call('connections');assert.equal(state.connections.length,1);assert.equal(state.profiles.length,0);assert.equal(state.history.length,0);assert.equal(authRequests,0);
  const status=await call('credentialStatus',profile);assert.equal(status.hasPassword,true);assert.equal(status.hasSudoPassword,true);assert(!JSON.stringify(status).includes('fixture-login-secret'));report.checks.saveWithoutConnecting=true;
  await call('setHostKeyPreference',{host:profile.host,port:profile.port,skipVerification:true});
  await window.webContents.executeJavaScript('window.fixtureEvents=[];window.gooeshell.onEvent(event=>window.fixtureEvents.push(event));true');
  const connected=await call('connect',{profile,attemptId:'direct'});assert(connected.id);assert.equal((await call('connectionHistory')).length,1);report.checks.directConnect=true;
  await window.webContents.executeJavaScript(`window.gooeshell.terminalResize(${JSON.stringify(connected.id)},100,30)`);
  const result=await call('sendSudoPassword',{sessionId:connected.id,submit:false});assert.equal(result,undefined);await waitFor(()=>received==='fixture-sudo-secret');report.checks.sudoPrivateInput=true;
  await call('disconnect',connected.id);await assert.rejects(call('sendSudoPassword',{sessionId:connected.id,submit:true}),/已断开/);
  const reconnected=await call('connect',{profile,attemptId:'retry'});assert.notEqual(reconnected.id,connected.id);await call('disconnect',reconnected.id);report.checks.reconnect=true;
  await assert.rejects(call('connect',{profile,attemptId:'bad-password',credentials:{remember:'persistent',password:'fixture-wrong-secret',sudoUsesLogin:true}}),/authentication|认证/i);
  assert.equal((await call('credentialStatus',profile)).remember,'session');
  const stillWorks=await call('connect',{profile,attemptId:'correct-password'});await call('disconnect',stillWorks.id);report.checks.failedAuthPreservesSecret=true;
  holdAuth=true;pendingAuth=undefined;await startConnect({profile,attemptId:'cancelled'});await waitFor(()=>!!pendingAuth);await call('cancelConnect','cancelled');assert.match((await finishConnect()).error,/CONNECTION_CANCELLED/);report.checks.cancelHandshake=true;
  pendingAuth=undefined;await startConnect({profile,attemptId:'renamed'});await waitFor(()=>!!pendingAuth);
  const renamed=await call('saveConnection',{profile:{...profile,name:'Renamed during handshake',icon:'cloud'},favorite:true});pendingAuth.accept();holdAuth=false;
  const finalConnection=(await finishConnect()).value;assert(finalConnection?.id);
  const latest=await call('connections');assert.equal(latest.profiles[0].name,renamed.name);assert.equal(latest.history[0].profile.name,renamed.name);report.checks.renameDuringConnect=true;
  const replacement=await call('saveConnection',{profile:{...renamed,username:'other-device-user'},favorite:true});assert.equal((await call('credentialStatus',replacement)).hasPassword,false);
  await assert.rejects(call('saveCredentials',{profile:renamed,credentials:{remember:'session',password:'old-tab-password',sudoUsesLogin:true}}),/CONNECTION_IDENTITY_CHANGED/);
  await assert.rejects(call('connect',{profile:replacement,attemptId:'missing'}),/AUTH_REQUIRED/);
  await assert.rejects(call('sendSudoPassword',{sessionId:finalConnection.id,submit:false}),/SUDO_PASSWORD_REQUIRED/);await call('disconnect',finalConnection.id);report.checks.identityInvalidates=true;
  await call('saveCredentials',{profile:replacement,credentials:{remember:'persistent',password:'fixture-login-secret',sudoUsesLogin:true}});
  const encrypted=await fs.readFile(path.join(userData,'credentials.encrypted.json'),'utf8');assert(!encrypted.includes('fixture-login-secret'));assert.equal(JSON.parse(encrypted).records.length,1);report.checks.encryptedDisk=true;
  encryptionAvailable=false;await call('saveCredentials',{profile:replacement,credentials:{remember:'never',sudoUsesLogin:true}});assert.equal((await call('credentialStatus',replacement)).hasPassword,false);report.checks.forgetEvenLocked=true;
  encryptionAvailable=true;profile=await call('saveConnection',{profile:renamed,favorite:true,credentials:{remember:'session',password:'fixture-login-secret',sudoUsesLogin:true}});
  holdAuth=true;pendingAuth=undefined;
  await startConnect({profile,attemptId:'forget-during-auth',credentials:{remember:'persistent',password:'fixture-login-secret',sudoUsesLogin:true}});await waitFor(()=>!!pendingAuth);
  await call('forgetCredentials',profile.id);pendingAuth.accept();holdAuth=false;
  const forgottenConnection=(await finishConnect()).value;assert(forgottenConnection?.id);assert.equal((await call('credentialStatus',profile)).hasPassword,false);await call('disconnect',forgottenConnection.id);report.checks.forgetDuringAuth=true;
  await call('saveCredentials',{profile,credentials:{remember:'session',password:'fixture-login-secret',sudoUsesLogin:true}});
  holdAuth=true;pendingAuth=undefined;
  await startConnect({profile,attemptId:'identity-round-trip',credentials:{remember:'persistent',password:'fixture-login-secret',sudoUsesLogin:true}});await waitFor(()=>!!pendingAuth);
  await call('saveConnection',{profile:{...profile,username:'temporary-replacement'},favorite:true});await call('saveConnection',{profile,favorite:true});pendingAuth.accept();holdAuth=false;
  const identityConnection=(await finishConnect()).value;assert(identityConnection?.id);assert.equal((await call('credentialStatus',profile)).hasPassword,false);await call('disconnect',identityConnection.id);report.checks.identityRoundTripDuringAuth=true;
  await call('saveCredentials',{profile,credentials:{remember:'session',password:'fixture-login-secret',sudoUsesLogin:true}});
  holdAuth=true;pendingAuth=undefined;await startConnect({profile,credentials:{remember:'persistent',password:'fixture-login-secret',sudoUsesLogin:true}});await waitFor(()=>!!pendingAuth);
  await call('deleteConnection',profile.id);assert.match((await finishConnect()).error,/CONNECTION_CANCELLED/);holdAuth=false;
  const removed=await call('connections');assert(!removed.connections.some(candidate=>candidate.id===profile.id));assert(!removed.history.some(entry=>entry.profile.id===profile.id));assert.equal((await call('credentialStatus',profile)).hasPassword,false);report.checks.deleteDuringAuth=true;
  profile=await call('saveConnection',{profile,favorite:true,credentials:{remember:'session',password:'fixture-login-secret',sudoUsesLogin:true}});
  const crashSession=await call('connect',{profile,attemptId:'worker-crash'});assert(crashSession.id);await connectionWorker.terminate();
  const crashEvents=await window.webContents.executeJavaScript('window.fixtureEvents');assert(crashEvents.some(event=>event.type==='sessionClosed'&&event.sessionId===crashSession.id));
  const afterCrash=await call('connect',{profile,attemptId:'worker-restarted'});assert(afterCrash.id);await call('disconnect',afterCrash.id);report.checks.workerRecovery=true;
  await checkJumpCredentials();
  let guarded=false;dialog.showMessageBoxSync=()=>{guarded=true;return 0;};await call('editorState',{dirty:true,busy:false});await call('initial');window.close();await delay(200);assert(guarded);assert.equal(window.isDestroyed(),false);report.checks.editorGuardIntact=true;
  await call('editorState',{dirty:false,busy:false});for(const peer of peers)peer.end();await new Promise(resolve=>server.close(resolve));
  report.success=true;saveReport();app.exit(0);
}
require(path.resolve(__dirname,'../../dist-main/main/main.js'));
