const {app,BrowserWindow,ipcMain}=require('electron');
const {promises:fs}=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const url=process.env.GOOESHELL_PALETTE_RENDER_URL,reportFile=process.env.GOOESHELL_PALETTE_RENDER_REPORT,userData=process.env.GOOESHELL_PALETTE_RENDER_DATA;
if(!url||new URL(url).hostname!=='127.0.0.1'||!reportFile||!userData)throw new Error('Explicit isolated fixture paths and a loopback URL are required');
app.setPath('userData',userData);app.commandLine.appendSwitch('force-device-scale-factor','1');
const metrics={checks:{},calls:[],rendererErrors:[],console:[]};const started=Date.now();let window,phase='initialization';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evaluate=code=>window.webContents.executeJavaScript(code);
async function until(predicate,label,timeout=8_000){const deadline=Date.now()+timeout;while(!(await predicate())){if(Date.now()>deadline)throw new Error(`Timed out: ${label}`);await delay(20);}}
const inspect=()=>evaluate(String.raw`(()=>{
  const terminal=window.__fixtureTerminal;if(!terminal)return null;
  const text=buffer=>Array.from({length:buffer.length},(_,index)=>buffer.getLine(index)?.translateToString(true)||'').join('\n');
  const surface=document.querySelector('.terminal-instance'),picture=[...surface.children].find(el=>el.style.backgroundImage);
  return {type:terminal.buffer.active.type,text:text(terminal.buffer.active),normal:text(terminal.buffer.normal),rendered:window.__fixtureRenderedText,
    cols:terminal.cols,rows:terminal.rows,modes:terminal.modes,count:window.__fixtureTerminalCount,renderCount:window.__fixtureRenderCount,
    sameTerminal:window.__fixtureOriginalTerminal===terminal,settings:window.__fixturePaletteSettings,
    fontFamily:terminal.options.fontFamily,fontSize:terminal.options.fontSize,fontWeight:terminal.options.fontWeight,lineHeight:terminal.options.lineHeight,
    theme:terminal.options.theme,background:getComputedStyle(surface).backgroundColor,picture:picture?.style.backgroundImage,pictureOpacity:picture?.style.opacity,
    layers:[...document.querySelectorAll('.xterm,.xterm-viewport,.xterm-scrollable-element,.xterm-screen,canvas')].map(el=>getComputedStyle(el).backgroundColor),
    selected:document.querySelector('.terminal-palette-choice[aria-pressed="true"] strong')?.textContent,
    domRendered:document.querySelector('.xterm-rows')?.textContent||'',canvas:document.querySelectorAll('canvas').length};
})()`);
function output(text){const bytes=Buffer.byteLength(text);window.webContents.send('palette-fixture:event',{type:'terminal',sessionId:'palette-transport',data:Buffer.from(text).toString('base64'),bytes});}
async function flush(){await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await delay(40);}
async function palette(name){await evaluate(`[...document.querySelectorAll('.terminal-palette-choice')].find(el=>el.querySelector('strong')?.textContent===${JSON.stringify(name)}).click()`);await flush();}
async function theme(id){await evaluate(`document.getElementById('interface-${id}').click()`);await until(async()=>(await inspect()).settings.theme===id,'interface '+id);await flush();}
function preserved(before,after){
  assert.equal(after.sameTerminal,true);assert.equal(after.count,1);
  for(const key of ['type','text','normal','cols','rows','fontFamily','fontSize','fontWeight','lineHeight'])assert.equal(after[key],before[key],key);
  assert.deepEqual(after.modes,before.modes);
}
async function run(){
  await app.whenReady();
  ipcMain.on('palette-fixture:call',(event,method,args)=>{if(event.sender===window.webContents)metrics.calls.push({method,args});});
  window=new BrowserWindow({show:false,width:1280,height:820,webPreferences:{preload:path.resolve('tests/fixtures/terminal-palettes-preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  window.webContents.on('render-process-gone',(_event,details)=>metrics.rendererErrors.push(details));
  window.webContents.on('console-message',(_event,details,message)=>metrics.console.push(typeof details==='object'?details.message:message));
  await window.loadURL(url);window.setMenu(null);
  await until(async()=>(await inspect())?.cols>0&&metrics.calls.some(call=>call.method==='terminalResize'),'initial terminal');
  await evaluate('void(window.__fixtureOriginalTerminal=window.__fixtureTerminal)');await delay(150);await flush();
  assert.equal((await inspect()).background,'rgb(0, 0, 0)');
  phase='follow interface retains legacy colors';
  await theme('light');assert.equal((await inspect()).background,'rgb(255, 255, 255)');assert.equal((await inspect()).theme.foreground,'#242424');
  await theme('dark');assert.equal((await inspect()).background,'rgb(0, 0, 0)');assert.equal((await inspect()).theme.foreground,'#dddddd');metrics.checks.legacyFollow=true;
  phase='existing alternate screen with scrollback and mouse modes';
  output(Array.from({length:80},(_,index)=>`PERSIST_SCROLLBACK_${index}\r\n`).join(''));
  await until(async()=>(await inspect()).normal.includes('PERSIST_SCROLLBACK_79'),'normal buffer');
  output('\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1h\x1b[H\x1b[34mDIRECTORY_BLUE\x1b[0m\r\n\x1b[32mEXECUTABLE_GREEN\x1b[0m');
  await until(async()=>{const state=await inspect();return state.type==='alternate'&&state.rendered?.includes('EXECUTABLE_GREEN');},'colored alternate screen rendered');
  const baseline=await inspect();assert.equal(baseline.modes.mouseTrackingMode,'any');assert.equal(baseline.modes.bracketedPasteMode,true);
  phase='explicit palette remains independent of the interface';
  await palette('石墨');const graphite=await inspect();preserved(baseline,graphite);assert.equal(graphite.background,'rgb(23, 23, 23)');assert.equal(graphite.theme.blue,'#92b5d5');
  await theme('light');const lightUi=await inspect();preserved(baseline,lightUi);assert.deepEqual(lightUi.theme,graphite.theme);assert.equal(lightUi.background,graphite.background);assert.equal(lightUi.selected,'石墨');
  await fs.writeFile(reportFile+'.light-ui.png',(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  await palette('白昼');const daylight=await inspect();preserved(baseline,daylight);assert.equal(daylight.background,'rgb(255, 255, 255)');
  await theme('dark');const darkUi=await inspect();preserved(baseline,darkUi);assert.deepEqual(darkUi.theme,daylight.theme);assert.equal(darkUi.background,daylight.background);
  for(const name of ['经典','暖灰','纯黑']){await palette(name);preserved(baseline,await inspect());}
  metrics.checks.independentPalette=true;metrics.checks.sameTerminal=true;metrics.checks.statePreserved=true;
  phase='background artwork is visible through transparent terminal layers';
  await evaluate('document.getElementById("background-on").click()');await until(async()=>!!(await inspect()).picture,'background image');await palette('暖灰');
  const picture=await inspect();preserved(baseline,picture);assert.equal(picture.background,'rgb(33, 30, 27)');assert.equal(picture.theme.background,'#211e1b00');assert.equal(picture.pictureOpacity,'0.2');
  assert.ok(picture.layers.every(color=>/^rgba\(\d+, \d+, \d+, 0\)$/.test(color)),'xterm layers must not paint an opaque background over the artwork');metrics.checks.backgroundImage=true;
  phase='keyboard and remote output remain responsive';
  await evaluate('window.__fixtureTerminal.input("PALETTE_INPUT_ALIVE",true)');
  await until(()=>metrics.calls.some(call=>call.method==='terminalInput'&&call.args[0]==='palette-transport'&&call.args[1]==='PALETTE_INPUT_ALIVE'),'input bridge');
  output('\r\nPALETTE_RENDER_ALIVE\r\n');await until(async()=>(await inspect()).rendered?.includes('PALETTE_RENDER_ALIVE'),'new output rendered');metrics.checks.inputResponsive=true;
  const final=await inspect();assert.ok(final.canvas>0||final.domRendered.includes('PALETTE_RENDER_ALIVE'),'actual GPU or DOM renderer must display new output');
  if(process.env.GOOESHELL_PALETTE_DOM==='1'){assert.equal(final.canvas,0);assert.match(final.domRendered,/DIRECTORY_BLUE/);}
  metrics.final=final;await fs.writeFile(reportFile+'.png',(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  assert.deepEqual(metrics.rendererErrors,[]);metrics.success=true;
}
run().catch(async error=>{metrics.success=false;metrics.error=error.stack||String(error);metrics.phase=phase;
  if(window&&!window.isDestroyed()){try{metrics.screen=await inspect();await fs.writeFile(reportFile+'.failure.png',(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());}catch{}}
}).finally(async()=>{metrics.elapsedMs=Date.now()-started;if(window&&!window.isDestroyed())window.destroy();await fs.writeFile(reportFile,JSON.stringify(metrics,null,2));app.exit(metrics.success?0:1);});
