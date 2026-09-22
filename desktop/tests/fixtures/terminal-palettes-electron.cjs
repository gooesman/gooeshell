const {app,BrowserWindow,ipcMain}=require('electron');
const {promises:fs}=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const assert=require('node:assert/strict');
const url=process.env.GOOESHELL_PALETTE_RENDER_URL,reportFile=process.env.GOOESHELL_PALETTE_RENDER_REPORT,userData=process.env.GOOESHELL_PALETTE_RENDER_DATA;
if(!url||new URL(url).hostname!=='127.0.0.1'||!reportFile||!userData)throw new Error('Explicit isolated fixture paths and a loopback URL are required');
app.setPath('userData',userData);app.commandLine.appendSwitch('force-device-scale-factor','1');
const metrics={checks:{},calls:[],rendererErrors:[],console:[]};const started=Date.now();let window,phase='initialization';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evaluate=code=>window.webContents.executeJavaScript(code);
const styleRows={blue:2,boldBlue:3,brightBlue:4,boldBrightBlue:5,trueColor:6,boldTrueColor:7};
function opaqueGlyphColor(data){
  // Antialiased edges can contain quantized RGB values on a transparent canvas.
  // Independent channel maxima can even combine three different edge pixels
  // into a color that was never painted. Sample actual fully covered interiors
  // instead, and select the most frequent complete RGB triple without tolerance.
  const counts=new Map(),channelMax=[0,0,0];let opaquePixels=0,edgePixels=0;
  for(let index=0;index<data.length;index+=4){
    for(let channel=0;channel<3;channel++)channelMax[channel]=Math.max(channelMax[channel],data[index+channel]);
    if(!data[index+3])continue;
    if(data[index+3]!==255){edgePixels++;continue;}
    const key=`${data[index]},${data[index+1]},${data[index+2]}`;
    counts.set(key,(counts.get(key)||0)+1);opaquePixels++;
  }
  const dominant=[...counts].sort((a,b)=>b[1]-a[1])[0];
  if(!dominant)throw new Error('No opaque glyph interiors available for exact color sampling');
  return {color:dominant[0].split(',').map(Number),opaquePixels,edgePixels,channelMax};
}
async function until(predicate,label,timeout=8_000){const deadline=Date.now()+timeout;while(!(await predicate())){if(Date.now()>deadline)throw new Error(`Timed out: ${label}`);await delay(20);}}
const inspect=()=>evaluate(String.raw`(()=>{
  const terminal=window.__fixtureTerminal;if(!terminal)return null;
  const text=buffer=>Array.from({length:buffer.length},(_,index)=>buffer.getLine(index)?.translateToString(true)||'').join('\n');
  const surface=document.querySelector('.terminal-instance'),picture=[...surface.children].find(el=>el.style.backgroundImage);
  return {type:terminal.buffer.active.type,text:text(terminal.buffer.active),normal:text(terminal.buffer.normal),rendered:window.__fixtureRenderedText,
    cols:terminal.cols,rows:terminal.rows,modes:terminal.modes,count:window.__fixtureTerminalCount,renderCount:window.__fixtureRenderCount,
    sameTerminal:window.__fixtureOriginalTerminal===terminal,settings:window.__fixturePaletteSettings,
    fontFamily:terminal.options.fontFamily,fontSize:terminal.options.fontSize,fontWeight:terminal.options.fontWeight,fontWeightBold:terminal.options.fontWeightBold,drawBoldTextInBrightColors:terminal.options.drawBoldTextInBrightColors,lineHeight:terminal.options.lineHeight,
    cells:Array.from({length:6},(_,index)=>{const cell=terminal.buffer.active.getLine(index+2)?.getCell(0);return cell?{bold:!!cell.isBold(),fg:cell.getFgColor(),rgb:cell.isFgRGB(),palette:cell.isFgPalette()}:null;}),
    theme:terminal.options.theme,background:getComputedStyle(surface).backgroundColor,picture:picture?.style.backgroundImage,pictureOpacity:picture?.style.opacity,
    layers:[...document.querySelectorAll('.xterm,.xterm-viewport,.xterm-scrollable-element,.xterm-screen,canvas')].map(el=>getComputedStyle(el).backgroundColor),
    selected:document.querySelector('.terminal-palette-choice[aria-pressed="true"] strong')?.textContent,
    domRendered:document.querySelector('.xterm-rows')?.textContent||'',canvas:document.querySelectorAll('canvas').length};
})()`);
function output(text){const bytes=Buffer.byteLength(text);window.webContents.send('palette-fixture:event',{type:'terminal',sessionId:'palette-transport',data:Buffer.from(text).toString('base64'),bytes});}
async function flush(){await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await delay(40);}
async function palette(name){await evaluate(`[...document.querySelectorAll('.terminal-palette-choice')].find(el=>el.querySelector('strong')?.textContent===${JSON.stringify(name)}).click()`);await flush();}
async function theme(id){await evaluate(`document.getElementById('interface-${id}').click()`);await until(async()=>(await inspect()).settings.theme===id,'interface '+id);await flush();}
async function bold(enabled){await evaluate(`document.querySelector('[role="switch"][aria-label="允许终端文字额外加粗"]').click()`);await until(async()=>{const state=await inspect();return state.settings.terminalBold===enabled&&state.fontWeightBold===(enabled?700:400);},'program bold '+enabled);await flush();}
async function captureStyles(label){
  await flush();
  const geometry=await evaluate(`(()=>{const terminal=window.__fixtureTerminal,rect=terminal.element.querySelector('.xterm-screen').getBoundingClientRect();return{x:rect.left,y:rect.top,width:rect.width,rowHeight:rect.height/terminal.rows,innerWidth:window.innerWidth};})()`);
  const pixels=await evaluate(`new Promise(resolve=>{
    const terminal=window.__fixtureTerminal,rows=${JSON.stringify(styleRows)},sampleColor=${opaqueGlyphColor.toString()};
    const listener=terminal.onRender(()=>{
      listener.dispose();const gl=[...terminal.element.querySelectorAll('.xterm-screen canvas')].map(canvas=>canvas.getContext('webgl2')).find(Boolean),result={};
      for(const [name,row] of Object.entries(rows)){
        if(gl){
          const width=gl.drawingBufferWidth,height=gl.drawingBufferHeight,rowHeight=height/terminal.rows,top=Math.round(row*rowHeight),bottom=Math.round((row+1)*rowHeight),data=new Uint8Array(width*(bottom-top)*4);
          gl.readPixels(0,height-bottom,width,bottom-top,gl.RGBA,gl.UNSIGNED_BYTE,data);
          result[name]=sampleColor(data);
        }else{
          const span=terminal.element.querySelector('.xterm-rows').children[row].querySelector('span'),style=getComputedStyle(span);
          result[name]={color:style.color.match(/\\d+/g).slice(0,3).map(Number),weight:Number(style.fontWeight)};
        }
      }
      resolve(result);
    });terminal.refresh(0,terminal.rows-1);
  })`);
  const screenshot=await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}),scale=screenshot.getSize().width/geometry.innerWidth;
  await fs.writeFile(reportFile+'.'+label+'.png',screenshot.toPNG());
  for(const [name,row] of Object.entries(styleRows)){
    const x=Math.round(geometry.x*scale),y=Math.round((geometry.y+row*geometry.rowHeight)*scale),width=Math.round(geometry.width*scale),height=Math.round((geometry.y+(row+1)*geometry.rowHeight)*scale)-y;
    pixels[name].hash=createHash('sha256').update(screenshot.crop({x,y,width,height}).toBitmap()).digest('hex');
  }
  return pixels;
}
function verifyColors(samples,state){
  const rgb=hex=>[1,3,5].map(index=>parseInt(hex.slice(index,index+2),16));
  for(const name of ['blue','boldBlue'])assert.deepEqual(samples[name].color,rgb(state.theme.blue),name+' keeps ANSI blue');
  for(const name of ['brightBlue','boldBrightBlue'])assert.deepEqual(samples[name].color,rgb(state.theme.brightBlue),name+' keeps explicit bright blue');
  for(const name of ['trueColor','boldTrueColor'])assert.deepEqual(samples[name].color,[194,58,235],name+' keeps explicit true color');
  assert.equal(state.drawBoldTextInBrightColors,false);
  assert.deepEqual(state.cells.map(cell=>cell.bold),[false,true,false,true,false,true]);
  assert.deepEqual(state.cells.map(cell=>cell.fg),[4,4,12,12,0xc23aeb,0xc23aeb]);
  assert.ok(state.cells.slice(0,4).every(cell=>cell.palette));assert.ok(state.cells.slice(4).every(cell=>cell.rgb));
}
function preserved(before,after){
  assert.equal(after.sameTerminal,true);assert.equal(after.count,1);
  for(const key of ['type','text','normal','cols','rows','fontFamily','fontSize','fontWeight','lineHeight'])assert.equal(after[key],before[key],key);
  assert.deepEqual(after.cells,before.cells);
  assert.deepEqual(after.modes,before.modes);
}
async function run(){
  // This reproduces the old sampler's failure: a partly covered green channel
  // must not replace the exact foreground of the fully covered glyph pixels.
  assert.deepEqual(opaqueGlyphColor(Uint8Array.from([194,58,235,255,194,58,235,255,193,60,234,250,0,0,0,0])).color,[194,58,235]);
  assert.throws(()=>opaqueGlyphColor(Uint8Array.from([194,60,235,250])),/No opaque glyph interiors/);
  metrics.checks.exactInteriorSampling=true;
  await app.whenReady();
  ipcMain.on('palette-fixture:call',(event,method,args)=>{if(event.sender===window.webContents)metrics.calls.push({method,args});});
  window=new BrowserWindow({show:false,width:1280,height:820,webPreferences:{preload:path.resolve('tests/fixtures/terminal-palettes-preload.cjs'),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  window.webContents.on('render-process-gone',(_event,details)=>metrics.rendererErrors.push(details));
  window.webContents.on('console-message',(_event,details,message)=>metrics.console.push(typeof details==='object'?details.message:message));
  await window.loadURL(url);window.setMenu(null);
  await until(async()=>(await inspect())?.cols>0&&metrics.calls.some(call=>call.method==='terminalResize'),'initial terminal');
  await evaluate('void(window.__fixtureOriginalTerminal=window.__fixtureTerminal)');await delay(150);await flush();
  assert.equal((await inspect()).background,'rgb(0, 0, 0)');
  phase='follow interface uses vivid dark colors';
  await theme('light');assert.equal((await inspect()).background,'rgb(255, 255, 255)');assert.equal((await inspect()).theme.foreground,'#242424');
  await theme('dark');assert.equal((await inspect()).background,'rgb(0, 0, 0)');assert.equal((await inspect()).theme.foreground,'#dddddd');assert.equal((await inspect()).theme.blue,'#3b82f6');metrics.checks.legacyFollow=true;
  phase='existing alternate screen with scrollback and mouse modes';
  output(Array.from({length:80},(_,index)=>`PERSIST_SCROLLBACK_${index}\r\n`).join(''));
  await until(async()=>(await inspect()).normal.includes('PERSIST_SCROLLBACK_79'),'normal buffer');
  output('\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1h\x1b[?25l\x1b[H\x1b[34mDIRECTORY_BLUE\x1b[0m\r\n\x1b[32mEXECUTABLE_GREEN\x1b[0m\r\n'+['34','1;34','94','1;94','38;2;194;58;235','1;38;2;194;58;235'].map(sgr=>`\x1b[${sgr}mSTYLE_MMMM_0123\x1b[0m`).join('\r\n'));
  await until(async()=>{const state=await inspect();return state.type==='alternate'&&state.rendered?.includes('EXECUTABLE_GREEN');},'colored alternate screen rendered');
  const baseline=await inspect();assert.equal(baseline.modes.mouseTrackingMode,'any');assert.equal(baseline.modes.bracketedPasteMode,true);
  phase='program bold changes actual glyphs without changing colors or terminal state';
  assert.equal(baseline.fontWeightBold,400);assert.equal(baseline.settings.terminalBold,false);
  const regularStyles=await captureStyles('bold-disabled');metrics.styles={regular:regularStyles};verifyColors(regularStyles,await inspect());
  await bold(true);const enabled=await inspect();preserved(baseline,enabled);
  const boldStyles=await captureStyles('bold-enabled');metrics.styles.bold=boldStyles;verifyColors(boldStyles,enabled);
  for(const name of ['blue','brightBlue','trueColor'])assert.equal(boldStyles[name].hash,regularStyles[name].hash,name+' must not gain weight');
  for(const name of ['boldBlue','boldBrightBlue','boldTrueColor'])assert.notEqual(boldStyles[name].hash,regularStyles[name].hash,name+' must visibly gain weight');
  if(process.env.GOOESHELL_PALETTE_DOM==='1'){assert.equal(regularStyles.boldBlue.weight,400);assert.equal(boldStyles.boldBlue.weight,700);}
  await bold(false);preserved(baseline,await inspect());
  const restoredStyles=await captureStyles('bold-restored');verifyColors(restoredStyles,await inspect());
  for(const name of Object.keys(styleRows))assert.equal(restoredStyles[name].hash,regularStyles[name].hash,name+' restores original glyphs');
  metrics.styles={regular:regularStyles,bold:boldStyles,restored:restoredStyles};metrics.checks.boldGlyphs=true;metrics.checks.explicitColors=true;
  phase='explicit palette remains independent of the interface';
  await palette('石墨');const graphite=await inspect();preserved(baseline,graphite);assert.equal(graphite.background,'rgb(23, 23, 23)');assert.equal(graphite.theme.blue,'#92b5d5');
  await theme('light');const lightUi=await inspect();preserved(baseline,lightUi);assert.deepEqual(lightUi.theme,graphite.theme);assert.equal(lightUi.background,graphite.background);assert.equal(lightUi.selected,'石墨');
  await fs.writeFile(reportFile+'.light-ui.png',(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
  await palette('白昼');const daylight=await inspect();preserved(baseline,daylight);assert.equal(daylight.background,'rgb(255, 255, 255)');
  await theme('dark');const darkUi=await inspect();preserved(baseline,darkUi);assert.deepEqual(darkUi.theme,daylight.theme);assert.equal(darkUi.background,daylight.background);
  for(const name of ['经典','暖灰','柔和','纯黑']){await palette(name);preserved(baseline,await inspect());}
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
