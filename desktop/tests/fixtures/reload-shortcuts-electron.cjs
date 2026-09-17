const {app,BrowserWindow,Menu}=require('electron');
const {mkdirSync,writeFileSync,promises:fs}=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {configureApplicationMenu}=require('../../dist-main/main/application-menu.js');
const artifacts=process.env.GOOESHELL_RELOAD_SHORTCUTS_ARTIFACTS;
if(!artifacts||!path.isAbsolute(artifacts)||!path.basename(artifacts).startsWith('reload-shortcuts-'))throw new Error('Explicit isolated fixture directory required');
const userData=path.join(artifacts,'user-data');mkdirSync(userData,{recursive:true});app.setPath('userData',userData);
const report={success:false,checks:{},baseline:[],protected:[],errors:[]};
const saveReport=()=>writeFileSync(path.join(artifacts,'result.json'),JSON.stringify(report,null,2));
const fail=error=>{report.errors.push(error?.stack||String(error));saveReport();app.exit(1);};
process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const roles=menu=>menu?.items.flatMap(item=>[item.role?.toLowerCase(),...(item.submenu?roles(item.submenu):[])])||[];
const roleItem=(menu,role)=>{for(const item of menu?.items||[]){if(item.role?.toLowerCase()===role)return item;const found=roleItem(item.submenu,role);if(found)return found;}};
let window,loads=0,starts=0;
const evaluate=code=>window.webContents.executeJavaScript(code);
async function until(predicate,label){const end=Date.now()+5000;while(!(await predicate())){if(Date.now()>end)throw new Error('Timed out: '+label);await delay(20);}}
async function key(keyCode,modifiers=[]){
  // A hidden/unfocused Electron window does not dispatch menu accelerators:
  // requiring focus and a baseline reload makes this a regression for the
  // native menu path, not just synthetic renderer key handling.
  window.show();window.focus();window.webContents.focus();
  await until(()=>window.isFocused(),'isolated regression window focused');
  await delay(250);
  await evaluate('document.querySelector("textarea").focus()');
  window.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
  window.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});
  await delay(250);
}
async function snapshot(){return evaluate('({identity:window.identity,state:window.terminalState,keys:window.keys})');}
async function run(){
  await app.whenReady();
  const defaultMenu=Menu.getApplicationMenu();report.defaultRoles=roles(defaultMenu);
  assert(report.defaultRoles.includes('reload'));assert(report.defaultRoles.includes('forcereload'));
  const html=path.join(artifacts,'keys.html');
  await fs.writeFile(html,'<!doctype html><title>Gooeshell isolated shortcut regression</title><textarea autofocus></textarea><script>window.identity=crypto.randomUUID();window.terminalState=["connection-A","connection-B"];window.keys=[];addEventListener("keydown",event=>window.keys.push({key:event.key.toLowerCase(),ctrl:event.ctrlKey,shift:event.shiftKey,meta:event.metaKey}));</script>');
  window=new BrowserWindow({show:true,width:500,height:300,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.on('did-finish-load',()=>loads++);window.webContents.on('did-start-loading',()=>starts++);
  await window.loadFile(html);
  Menu.setApplicationMenu(defaultMenu);
  const accelerator=process.platform==='darwin'?'meta':'control';
  for(const [modifiers,check] of [[[accelerator,'shift'],'defaultMenuReproducesForceReload'],[[accelerator],'defaultMenuReproducesReload']]){
    const before=await snapshot(),beforeLoads=loads,beforeStarts=starts;
    if(process.platform==='darwin'){
      // sendInputEvent delivers renderer keys on macOS, but does not dispatch
      // Cocoa application-menu accelerators on hosted runners. Exercise the
      // real default menu action as the positive control on this platform;
      // protected keyboard events below remain native input checks everywhere.
      const item=roleItem(defaultMenu,check==='defaultMenuReproducesForceReload'?'forcereload':'reload');
      assert(item&&item.enabled,'Default reload menu action is available');
      item.click({},window,window.webContents);
    }else await key('R',modifiers);
    await until(()=>loads>beforeLoads,'default accelerator reloads the renderer');
    const after=await snapshot();
    assert.notEqual(after.identity,before.identity);assert.equal(loads,beforeLoads+1);assert.equal(starts,beforeStarts+1);
    report.baseline.push({method:process.platform==='darwin'?'menu-role':'native-accelerator',key:'R',modifiers,loads:loads-beforeLoads,identityChanged:before.identity!==after.identity});report.checks[check]=true;
  }
  configureApplicationMenu();
  report.protectedRoles=roles(Menu.getApplicationMenu());
  for(const role of ['reload','forcereload','viewmenu','toggledevtools','close','resetzoom','zoomin','zoomout'])assert(!report.protectedRoles.includes(role),'Unexpected menu role: '+role);
  if(process.platform!=='darwin')assert.equal(Menu.getApplicationMenu(),null);
  report.checks.noReloadRoles=true;
  const before=await snapshot(),beforeLoads=loads,beforeStarts=starts;
  const cases=[['R',['control','shift']],['R',['control']],['F5',[]],['F5',['control']],['F5',['shift']],['W',['control']],['F1',['control','shift']]];
  if(process.platform==='darwin')cases.push(['R',['meta','shift']],['R',['meta']]);
  for(const [keyCode,modifiers] of cases){
    const keysBefore=(await snapshot()).keys.length;
    await key(keyCode,modifiers);
    assert(!window.isDestroyed(),'Terminal key must not close its window');
    const after=await snapshot();assert.equal(after.identity,before.identity);assert.deepEqual(after.state,before.state);assert.equal(after.keys.length,keysBefore+1);
    const expected={key:keyCode.toLowerCase(),ctrl:modifiers.includes('control'),shift:modifiers.includes('shift'),meta:modifiers.includes('meta')};
    assert.deepEqual(after.keys.at(-1),expected);report.protected.push(expected);
  }
  assert.equal(loads,beforeLoads);assert.equal(starts,beforeStarts);report.checks.terminalKeysPreserved=true;report.checks.rendererStatePreserved=true;report.checks.singleLoadAfterProtection=true;
  report.success=true;saveReport();app.exit(0);
}
void run().catch(fail);
