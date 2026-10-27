const {app,BrowserWindow,safeStorage,clipboard}=require('electron');
const {promises:fs,mkdirSync}=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {generateKeyPairSync,randomUUID}=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {Server}=require('ssh2');
const {Client}=require('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
const artifacts=process.env.GOOESHELL_MCP_MAIN_ARTIFACTS;
if(!artifacts||!path.isAbsolute(artifacts)||!path.basename(artifacts).startsWith('mcp-main-'))throw new Error('Isolated MCP fixture directory required');
const userData=path.join(artifacts,'user-data');mkdirSync(userData,{recursive:true});app.setPath('userData',userData);
// Replace only this process's keyring and clipboard functions; never read real credentials.
safeStorage.isEncryptionAvailable=()=>false;safeStorage.isAsyncEncryptionAvailable=async()=>false;
let copied='';clipboard.writeText=text=>{copied=text;};
const report={success:false,checks:{},errors:[]},peers=new Set(),children=new Set(),commands=[];
let window,client,transport,foreground='',authentications=0,shells=0,lastInput='',holdAuth=false,heldAuth=false,phase='startup';
const progress=setInterval(()=>{void fs.writeFile(path.join(artifacts,'progress.json'),JSON.stringify({phase,lastScript:report.lastScript,window:!!window}));},1000);progress.unref();
process.on('unhandledRejection',error=>{report.errors.push(String(error));void fs.writeFile(path.join(artifacts,'unexpected-error.json'),JSON.stringify(report));});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(check,label)=>{const deadline=Date.now()+10000;while(!await check()){if(Date.now()>deadline)throw new Error('Timeout: '+label);await delay(20);}};
const evaluate=async code=>{try{return await window.webContents.executeJavaScript(code);}catch(error){report.lastScript=code;throw error;}};
const call=(method,...args)=>evaluate(`window.gooeshell[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
const linux=(program,args)=>process.platform==='win32'?{program:'wsl.exe',args:['--exec',program,...args]}:{program,args};
const linuxSync=(program,args)=>{const run=linux(program,args);return execFileSync(run.program,run.args,{encoding:'utf8',timeout:10000,windowsHide:true});};
const temporaryRoot=process.platform==='darwin'?'/private/tmp':'/tmp';
let realShell=false,linuxRoot=temporaryRoot+'/gooeshell-mcp-'+randomUUID(),tmux=false;
try{realShell=linuxSync('/bin/sh',['-c','printf SHELL_READY'])==='SHELL_READY';}catch{}
if(realShell){
  const sudo=`#!/bin/sh
if [ "$1" = '-S' ]; then
  shift; [ "$1" = '-p' ] && shift 2
  if [ ! -f "$MCP_FIXTURE_ROOT/cached" ]; then
    IFS= read -r secret
    case "$secret" in fixture-secret|fixture-sudo-secret) ;; *) printf 'Denied\\n' >&2; exit 1;; esac
  fi
elif [ "$1" = '-n' ]; then
  shift; [ -f "$MCP_FIXTURE_ROOT/cached" ] || exit 1
fi
[ "$1" = '--' ] && shift
exec "$@"
`;
  linuxSync('/usr/bin/env',['python3','-c','import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.mkdir(mode=0o700); (p/"bin").mkdir(); f=p/"bin"/"sudo"; f.write_text(sys.argv[2]); f.chmod(0o700); (p/"dir\u0027s 中文").mkdir()',linuxRoot,sudo]);
  try{tmux=linuxSync('/bin/sh',['-c','command -v tmux']).trim().length>0;}catch{}
}
report.realShell=realShell;report.tmuxAvailable=tmux;
const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
const server=new Server({hostKeys:[key]},peer=>{
  peers.add(peer);peer.on('close',()=>peers.delete(peer));peer.on('error',()=>{});
  peer.on('authentication',context=>{if(context.method!=='password')return context.reject();authentications++;if(holdAuth){heldAuth=true;return;}context.username==='fixture-user'&&context.password==='fixture-secret'?context.accept():context.reject();});
  peer.on('ready',()=>peer.on('session',accept=>{
    const session=accept();session.on('pty',accept=>accept?.());session.on('window-change',accept=>accept?.());
    session.on('shell',accept=>{shells++;const stream=accept();stream.write('FIXTURE>');stream.on('data',bytes=>foreground+=bytes.toString());});
    session.on('exec',(accept,_reject,info)=>{
      commands.push(info.command);lastInput='';const stream=accept();stream.on('data',bytes=>lastInput+=bytes.toString());
      if(realShell){
        const run=linux('/usr/bin/env',[`MCP_FIXTURE_ROOT=${linuxRoot}`,`PATH=${linuxRoot}/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,'/bin/sh','-c',info.command]);
        const child=spawn(run.program,run.args,{windowsHide:true,stdio:['pipe','pipe','pipe']});children.add(child);
        child.stdin.on('error',()=>{});stream.pipe(child.stdin);child.stdout.on('data',bytes=>stream.write(bytes));child.stderr.on('data',bytes=>stream.stderr.write(bytes));
        stream.on('close',()=>{if(child.exitCode===null)child.kill();});child.on('error',error=>{stream.stderr.write(error.message);stream.exit(1);stream.end();});
        child.on('close',code=>{children.delete(child);if(!stream.destroyed){stream.exit(code??1);stream.end();}});
      }else stream.on('end',()=>{stream.write(info.command.includes('MCP_中文')?'MCP_中文\n':'OK\n');stream.stderr.write('stderr\n');stream.exit(info.command.includes('MCP_中文')?7:0);stream.end();});
    });
  }));
});
async function tool(name,args={}){const result=await client.callTool({name,arguments:args});if(result.isError)throw new Error(result.content[0].text);return JSON.parse(result.content[0].text);}
async function run(){
  await until(()=>evaluate('Boolean(window.gooeshell && document.querySelector(".connection-home"))'),'home');
  phase='MCP settings and copied configuration';
  assert.equal((await call('mcpStatus')).enabled,false);
  await evaluate(`document.querySelector('.titlebar [aria-label="设置"]').click()`);
  phase='MCP settings tab';
  await until(()=>evaluate('Boolean(document.querySelector(".settings-tabs"))'),'settings');
  await evaluate(`[...document.querySelectorAll('.settings-tabs button')].find(button=>button.textContent==='AI 与 MCP').click()`);
  await until(()=>evaluate('Boolean(document.querySelector("#mcp-config"))'),'MCP page');
  phase='MCP settings switch';
  assert.equal(await evaluate(`document.querySelector('[aria-label="启用本机 MCP 桥接"]').getAttribute('aria-checked')`),'false');
  await evaluate(`document.querySelector('[aria-label="启用本机 MCP 桥接"]').click()`);
  await until(async()=>await evaluate(`document.querySelector('[aria-label="启用本机 MCP 桥接"]').getAttribute('aria-checked')`)==='true','enabled');
  phase='MCP settings copy';
  await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent==='复制 Codex 配置').click()`);
  await until(()=>copied.includes('[mcp_servers.gooeshell]'),'Codex configuration');
  assert(copied.includes('ELECTRON_RUN_AS_NODE'));assert(!copied.includes('Bearer'));
  const image=await Promise.race([window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}),delay(2000)]);
  if(image)await fs.writeFile(path.join(artifacts,'settings.png'),image.toPNG());
  await evaluate(`[...document.querySelectorAll('.settings-dialog .modal-footer button')].find(button=>button.textContent==='关闭').click()`);
  report.checks.settingsAndConfig=true;
  await evaluate(`window.gooeshell.onEvent(event=>{if(event.type==='hostKey')window.gooeshell.confirmHostKey(event.requestId,'save');});true`);
  const identity=await call('saveLoginIdentity',{name:'Fixture identity',username:'fixture-user',password:'fixture-secret',remember:'session'});
  const profile={id:'mcp-fixture',name:'MCP fixture',host:'127.0.0.1',port:server.address().port,username:'ignored',auth:'password',loginIdentityId:identity.id,rememberHost:true,encoding:'utf8'};
  await call('saveConnection',{profile,favorite:true,credentials:{remember:'session',sudoUsesLogin:true}});
  const foregroundSession=await call('connect',{profile,attemptId:'foreground'});
  await evaluate(`window.gooeshell.terminalResize(${JSON.stringify(foregroundSession.id)},80,24);true`);
  const config=(await call('mcpStatus')).config;
  transport=new StdioClientTransport({...config,env:{...config.env},stderr:'pipe'});
  let stderr='';transport.stderr.on('data',bytes=>stderr+=bytes.toString());
  client=new Client({name:'gooeshell-packaged-fixture',version:'1.0.0'});await client.connect(transport);
  phase='stored identity and existing SSH transport reuse';
  const connections=await tool('list_connections');assert.equal(connections[0].identityName,'Fixture identity');assert(!JSON.stringify(connections).includes('fixture-secret'));
  const reused=await tool('connect',{connectionId:profile.id});assert.equal(reused.id,foregroundSession.id);assert.equal(reused.reused,true);assert.equal(authentications,1);
  const sessions=await tool('list_sessions');assert.equal(sessions[0].source,'terminal');
  const result=await tool('run_command',{sessionId:reused.id,command:"printf 'MCP_中文\\n'; printf 'stderr\\n' >&2; exit 7"});
  assert.equal(result.stdout,'MCP_中文\n');assert.equal(result.stderr,'stderr\n');assert.equal(result.exitCode,7);assert.equal(foreground,'');assert.equal(authentications,1);
  report.checks.identityAndTransportReuse=true;report.checks.foregroundPreserved=true;
  phase='managed sudo password';
  await tool('run_command',{sessionId:reused.id,command:'printf SUDO_OK',sudo:true});assert.equal(lastInput,'fixture-secret\n');
  await call('saveCredentials',{profile,credentials:{remember:'session',sudoUsesLogin:false,sudoPassword:'fixture-sudo-secret'}});
  await tool('run_command',{sessionId:reused.id,command:'printf SUDO_OK',sudo:true});assert.equal(lastInput,'fixture-sudo-secret\n');
  for(const secret of ['fixture-secret','fixture-sudo-secret'])assert(!commands.join('\n').includes(secret));
  report.checks.managedSudo=true;
  if(realShell){
    const cwd=await tool('run_command',{sessionId:reused.id,cwd:linuxRoot+"/dir's 中文",command:'pwd'});assert.equal(cwd.stdout.trim(),linuxRoot+"/dir's 中文");
    await tool('run_command',{sessionId:reused.id,command:`touch '${linuxRoot}/cached'`});
    const cached=await tool('run_command',{sessionId:reused.id,command:'cat',sudo:true});assert.equal(cached.stdout,'','cached sudo must not expose an unread password to the command');
    report.checks.realShellCwdAndCachedSudo=true;
  }
  if(tmux){
    phase='parallel tmux panes and detached log inspection';
    const prefix=`tmux -S '${linuxRoot}/tmux.sock'`;
    await tool('run_command',{sessionId:reused.id,command:`${prefix} -f /dev/null new-session -d -s gooeshell -x 100 -y 30 /bin/sh`});
    const first=(await tool('run_command',{sessionId:reused.id,command:`${prefix} display-message -p -t gooeshell:0 '#{pane_id}'`})).stdout.trim();
    const second=(await tool('run_command',{sessionId:reused.id,command:`${prefix} split-window -d -P -F '#{pane_id}' -t '${first}' /bin/sh`})).stdout.trim();
    assert.match(first,/^%\d+$/);assert.match(second,/^%\d+$/);assert.notEqual(first,second);
    for(const [pane,text] of [[first,'TASK_A_中文'],[second,'TASK_B_中文']])await tool('run_command',{sessionId:reused.id,command:`${prefix} send-keys -t '${pane}' -l "printf '${text}\\n'"; ${prefix} send-keys -t '${pane}' Enter`});
    await until(async()=>{
      const captures=await Promise.all([first,second].map(pane=>tool('run_command',{sessionId:reused.id,command:`${prefix} capture-pane -p -t '${pane}'`})));
      return captures[0].stdout.includes('TASK_A_中文')&&captures[1].stdout.includes('TASK_B_中文');
    },'both task logs');
    report.checks.realTmuxParallelPanes=true;
  }
  phase='disable keeps foreground connection';
  await call('setMcpEnabled',false);assert.equal((await client.callTool({name:'list_sessions',arguments:{}})).isError,true);
  await evaluate(`window.gooeshell.terminalInput(${JSON.stringify(foregroundSession.id)},'USER_STILL_CONNECTED');true`);await until(()=>foreground.includes('USER_STILL_CONNECTED'),'user terminal');
  report.checks.disableKeepsForeground=true;
  await call('disconnect',foregroundSession.id);await until(()=>peers.size===0,'foreground disconnect');
  await call('setMcpEnabled',true);
  const background=await tool('connect',{connectionId:profile.id});assert.equal(background.reused,false);assert.equal(background.source,'mcp');assert.equal(shells,1);
  await tool('run_command',{sessionId:background.id,command:'printf BACKGROUND_OK'});report.checks.backgroundUsesStoredIdentity=true;
  const missing={...profile,id:'missing',loginIdentityId:undefined,username:'fixture-user'};await call('saveConnection',{profile:missing,favorite:true});
  const noPassword=await client.callTool({name:'connect',arguments:{connectionId:'missing'}});assert.equal(noPassword.isError,true);assert.match(noPassword.content[0].text,/AUTH_REQUIRED/);report.checks.missingPasswordStaysInApp=true;
  phase='revoking pending connection releases bridge-owned transports';
  const pendingIdentity=await call('saveLoginIdentity',{name:'Pending fixture identity',username:'fixture-user',password:'fixture-secret',remember:'session'});
  const pendingProfile=await call('saveConnection',{profile:{...profile,id:'pending',loginIdentityId:pendingIdentity.id},favorite:true});holdAuth=true;
  const pending=client.callTool({name:'connect',arguments:{connectionId:pendingProfile.id}});await until(()=>heldAuth,'pending authentication');
  await call('setMcpEnabled',false);assert.equal((await pending).isError,true);await until(()=>peers.size===0,'bridge transports released');
  report.checks.revokePendingAndOwnedConnections=true;assert.equal(stderr,'');report.success=true;
}
app.on('browser-window-created',(_event,created)=>{window=created;phase='loading app';window.on('show',()=>window.hide());window.webContents.once('did-finish-load',()=>void run().catch(error=>{report.errors.push(error.stack||String(error));}).finally(async()=>{
  report.phase=phase;
  if(!report.success)try{report.body=await window.webContents.executeJavaScript('document.body.innerText');}catch{}
  if(client)await client.close().catch(()=>{});
  for(const child of children)child.kill();for(const peer of peers)peer.end();server.close();
  if(realShell){
    if(tmux)try{linuxSync('/bin/sh',['-c',`tmux -S '${linuxRoot}/tmux.sock' kill-server 2>/dev/null || true`]);}catch{}
    try{linuxSync('/usr/bin/env',['python3','-c','import pathlib,shutil,sys; p=pathlib.Path(sys.argv[1]); assert p.parent==pathlib.Path(sys.argv[2]) and p.name.startswith("gooeshell-mcp-") and p.resolve()==p; shutil.rmtree(p)',linuxRoot,temporaryRoot]);}catch(error){report.errors.push('Fixture cleanup: '+error.message);}
  }
  await fs.writeFile(path.join(artifacts,'result.json'),JSON.stringify(report,null,2));app.exit(report.success&&!report.errors.length?0:1);
}));});
server.listen(0,'127.0.0.1',()=>require('../../dist-main/main/main.js'));
