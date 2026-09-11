const {app,BrowserWindow,ipcMain}=require('electron');
const {promises:fs}=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const url=process.env.GOOESHELL_RECONNECT_RENDER_URL,reportFile=process.env.GOOESHELL_RECONNECT_RENDER_REPORT,userData=process.env.GOOESHELL_RECONNECT_RENDER_DATA;
if(!url||new URL(url).hostname!=='127.0.0.1'||!reportFile||!userData)throw new Error('Explicit isolated fixture paths and a loopback URL are required');
app.setPath('userData',userData);app.commandLine.appendSwitch('force-device-scale-factor','1');
const metrics={checks:{},calls:[],rendererErrors:[],console:[]};const started=Date.now();let window,phase='initialization';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evaluate=code=>window.webContents.executeJavaScript(code);
async function until(predicate,label,timeout=8_000){const deadline=Date.now()+timeout;while(!(await predicate())){if(Date.now()>deadline)throw new Error(`Timed out: ${label}`);await delay(20);}}
const inspect=()=>evaluate(String.raw`(()=>{
  const terminal=window.__fixtureTerminal;if(!terminal)return null;
  const text=buffer=>Array.from({length:buffer.length},(_,index)=>buffer.getLine(index)?.translateToString(true)||'').join('\n');
  return {type:terminal.buffer.active.type,text:text(terminal.buffer.active),normal:text(terminal.buffer.normal),rendered:window.__fixtureRenderedText,
    cols:terminal.cols,rows:terminal.rows,modes:terminal.modes,count:window.__fixtureTerminalCount,renderCount:window.__fixtureRenderCount,
    sameTerminal:window.__fixtureOriginalTerminal===terminal,connection:window.__fixtureConnection,attempts:window.__fixtureReconnectAttempts,
    pendingCallbacks:window.__fixtureDeferredWriteCallbacks.length,keyDecisions:window.__fixtureKeyDecisions,reconnectVisible:!!document.querySelector('.terminal-reconnect'),domRendered:document.querySelector('.xterm-rows')?.textContent||'',canvas:document.querySelectorAll('canvas').length};
})()`);
const terminalCalls=method=>metrics.calls.filter(call=>call.method===method);
const commandRequest={commandId:'fixture-command',mode:'insert',allowOtherConnection:false,expectedCommand:'echo fixture',expectedGroupId:'fixture-group',expectedConfirmBeforeRun:false};
const sendCommand=id=>evaluate(`window.__fixtureCommandSenders.get(${JSON.stringify(id)})(${JSON.stringify(commandRequest)})`);
function emit(event){window.webContents.send('reconnect-fixture:event',event);}
function output(id,text){const bytes=Buffer.byteLength(text);emit({type:'terminal',sessionId:id,data:Buffer.from(text).toString('base64'),bytes});return bytes;}
async function flush(){await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await delay(30);}
async function key(keyCode,modifiers=[]){
  await evaluate('window.__fixtureTerminal.focus()');
  window.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});window.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(40);
}
async function replace(id){
  await evaluate(`window.__fixtureSetConnection({id:${JSON.stringify(id)},disconnected:false,reconnecting:false})`);
  await until(async()=>(await inspect())?.connection.id===id,'new transport rendered');
  await until(()=>terminalCalls('terminalResize').some(call=>call.args[0]===id),'new transport receives terminal dimensions');
  await flush();
}
const alternateModes='\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1h';
function assertReset(state){assert.equal(state.type,'normal');assert.equal(state.modes.mouseTrackingMode,'none');assert.equal(state.modes.bracketedPasteMode,false);assert.equal(state.modes.applicationCursorKeysMode,false);}

async function run(){
  await app.whenReady();
  ipcMain.on('reconnect-fixture:call',(event,method,args)=>{if(event.sender===window.webContents)metrics.calls.push({method,args});});
  window=new BrowserWindow({show:false,width:1050,height:700,webPreferences:{preload:path.resolve('tests/fixtures/terminal-reconnect-preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  window.webContents.on('render-process-gone',(_event,details)=>metrics.rendererErrors.push(details));
  window.webContents.on('console-message',(_event,details,message)=>metrics.console.push(typeof details==='object'?details.message:message));
  await window.loadURL(url);
  window.setMenu(null);window.webContents.focus();
  await until(async()=>(await inspect())?.cols>0&&terminalCalls('terminalResize').length>0,'initial renderer and size');
  await until(()=>evaluate('window.__fixtureCommandSenders.has("transport-old")'),'initial command sender registered');
  await sendCommand('transport-old');await until(()=>terminalCalls('sendCommand').length===1,'initial command send bridge');
  assert.deepEqual(terminalCalls('sendCommand')[0].args,[{...commandRequest,sessionId:'transport-old',bracketedPaste:false}]);
  await evaluate('void(window.__fixtureOriginalTerminal=window.__fixtureTerminal)');
  phase='normal scrollback';
  output('transport-old',Array.from({length:90},(_,index)=>`OLD_SCROLLBACK_${index}\r\n`).join(''));
  await until(async()=>(await inspect())?.normal.includes('OLD_SCROLLBACK_89'),'normal scrollback parsed');
  phase='online reconnect key stays with remote';
  await key('R',['control','shift']);
  await until(async()=>(await inspect()).keyDecisions.some(event=>event.type==='keydown'&&event.code==='KeyR'&&event.ctrl&&event.shift),'online key reaches terminal handler');
  assert.equal((await inspect()).attempts,0);assert.equal((await inspect()).keyDecisions.findLast(event=>event.type==='keydown').result,true);
  // xterm intentionally has no default encoding for Ctrl+Shift+letter. Passing
  // its handler through must be distinguished from forcing an extra Ctrl+R byte.
  const onlineCalls=terminalCalls('terminalInput').length;await key('R',['control']);
  await until(()=>terminalCalls('terminalInput').length>onlineCalls,'ordinary Ctrl+R forwarded');
  assert.deepEqual(terminalCalls('terminalInput').at(-1).args,['transport-old','\x12']);
  phase='alternate modes and deferred old acknowledgement';
  output('transport-old',alternateModes+'OLD_ALTERNATE_SCREEN');
  await until(async()=>{const state=await inspect();return state?.type==='alternate'&&state.modes.mouseTrackingMode==='any'&&state.modes.bracketedPasteMode;},'alternate and mouse modes enabled');
  await sendCommand('transport-old');await until(()=>terminalCalls('sendCommand').length===2,'command send in bracketed-paste mode');
  assert.deepEqual(terminalCalls('sendCommand')[1].args,[{...commandRequest,sessionId:'transport-old',bracketedPaste:true}]);metrics.checks.commandPasteMode=true;
  await until(()=>terminalCalls('terminalAck').length>=2,'previous output callbacks complete');
  await evaluate('window.__fixtureHoldWriteCallbacks=true');
  const pendingBytes=output('transport-old','PENDING_OLD_ACK');
  await until(async()=>(await inspect())?.pendingCallbacks===1,'old write callback delayed');
  phase='disconnect restores normal buffer';
  emit({type:'sessionClosed',sessionId:'transport-old',message:'Isolated network interruption'});
  await until(async()=>{const state=await inspect();return state?.reconnectVisible&&state.type==='normal';},'disconnect strip and normal screen');
  const disconnected=await inspect();assertReset(disconnected);assert.match(disconnected.normal,/OLD_SCROLLBACK_0/);
  const commandCallsBeforeDisconnect=terminalCalls('sendCommand').length;
  await assert.rejects(sendCommand('transport-old'),/已断开/);assert.equal(terminalCalls('sendCommand').length,commandCallsBeforeDisconnect);metrics.checks.commandOfflineRejected=true;
  const offlineInputs=terminalCalls('terminalInput').length;
  await evaluate('window.__fixtureTerminal.input("DO_NOT_SEND_OFFLINE",true)');await key('R',['control','shift']);
  await until(async()=>(await inspect()).attempts===1,'offline reconnect shortcut');
  assert.equal(terminalCalls('terminalInput').length,offlineInputs);metrics.checks.reconnectOfflineOnly=true;
  phase='replacement SSH transport keeps the same terminal';
  await replace('transport-new');
  await until(()=>evaluate('!window.__fixtureCommandSenders.has("transport-old")&&window.__fixtureCommandSenders.has("transport-new")'),'command sender follows physical transport');
  await assert.rejects(evaluate(`window.__fixtureOldCommandSender(${JSON.stringify(commandRequest)})`),/已断开/);
  assert.equal(terminalCalls('sendCommand').length,commandCallsBeforeDisconnect);
  await sendCommand('transport-new');await until(()=>terminalCalls('sendCommand').length===commandCallsBeforeDisconnect+1,'new command sender calls API');
  assert.deepEqual(terminalCalls('sendCommand').at(-1).args,[{...commandRequest,sessionId:'transport-new',bracketedPaste:false}]);metrics.checks.commandReconnectedSender=true;
  const reconnected=await inspect();assertReset(reconnected);assert.equal(reconnected.sameTerminal,true);assert.equal(reconnected.count,1);
  assert.match(reconnected.normal,/OLD_SCROLLBACK_0/);assert.match(reconnected.normal,/OLD_SCROLLBACK_89/);assert.equal(reconnected.reconnectVisible,false);
  assert.deepEqual(reconnected.normal.split('\n').filter(line=>line.startsWith('OLD_SCROLLBACK_')),Array.from({length:90},(_,index)=>`OLD_SCROLLBACK_${index}`),'disconnect/reconnect banners must not overwrite any old output');
  metrics.checks.sameTerminal=true;metrics.checks.scrollbackPreserved=true;metrics.checks.modesReset=true;metrics.checks.resizedNewTransport=true;
  phase='old write callback still acknowledges old physical session';
  const ackCount=terminalCalls('terminalAck').length;
  await evaluate('window.__fixtureHoldWriteCallbacks=false;window.__fixtureDeferredWriteCallbacks.splice(0).forEach(callback=>callback())');
  await until(()=>terminalCalls('terminalAck').length>ackCount,'deferred old ACK delivered');
  assert.deepEqual(terminalCalls('terminalAck').at(-1).args,['transport-old',pendingBytes]);metrics.checks.pendingAckOldTransport=true;
  phase='stale old transport events cannot reach the new screen';
  const beforeStale=terminalCalls('terminalAck').length;
  output('transport-old','STALE_OLD_TRANSPORT_OUTPUT');emit({type:'sessionClosed',sessionId:'transport-old',message:'STALE_CLOSE'});await flush();
  const afterStale=await inspect();assert.equal(afterStale.reconnectVisible,false);assert.ok(!afterStale.normal.includes('STALE_OLD_TRANSPORT_OUTPUT'));assert.equal(terminalCalls('terminalAck').length,beforeStale);metrics.checks.oldEventsIgnored=true;
  phase='new input and output route through replacement transport';
  const inputsBefore=terminalCalls('terminalInput').length;
  await key('R',['control','shift']);
  assert.equal((await inspect()).keyDecisions.findLast(event=>event.type==='keydown').result,true);assert.equal((await inspect()).attempts,1);
  await key('R',['control']);await until(()=>terminalCalls('terminalInput').length>inputsBefore,'reconnected Ctrl+R forwarded');
  assert.deepEqual(terminalCalls('terminalInput').at(-1).args,['transport-new','\x12']);
  await evaluate('window.__fixtureTerminal.input("NEW_TRANSPORT_INPUT",true)');
  await until(()=>terminalCalls('terminalInput').some(call=>call.args[0]==='transport-new'&&call.args[1]==='NEW_TRANSPORT_INPUT'),'new input bridge');
  output('transport-new','\r\nNEW_TRANSPORT_RENDERED\r\n');await until(async()=>(await inspect()).rendered?.includes('NEW_TRANSPORT_RENDERED'),'new transport actually rendered');metrics.checks.inputNewTransport=true;
  phase='replacement without close notification still resets alternate modes';
  output('transport-new',alternateModes+'SECOND_ALTERNATE_SCREEN');await until(async()=>(await inspect()).type==='alternate','second alternate buffer');
  await replace('transport-third');assertReset(await inspect());assert.match((await inspect()).normal,/NEW_TRANSPORT_RENDERED/);metrics.checks.replacementWithoutCloseResetsModes=true;
  const final=await inspect();assert.equal(final.count,1);assert.ok(final.canvas>0||final.domRendered.includes('NEW_TRANSPORT_RENDERED'),'GPU or DOM fallback must render the new transport output');assert.ok(final.renderCount>0);metrics.final=final;
  await fs.writeFile(reportFile+'.png',(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  assert.deepEqual(metrics.rendererErrors,[]);metrics.success=true;
}
run().catch(async error=>{
  metrics.success=false;metrics.error=error.stack||String(error);metrics.phase=phase;
  if(window&&!window.isDestroyed()){try{metrics.screen=await inspect();await fs.writeFile(reportFile+'.failure.png',(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());}catch{}}
}).finally(async()=>{
  metrics.elapsedMs=Date.now()-started;if(window&&!window.isDestroyed())window.destroy();await fs.writeFile(reportFile,JSON.stringify(metrics,null,2));app.exit(metrics.success?0:1);
});
