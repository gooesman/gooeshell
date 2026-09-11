const {app,safeStorage}=require('electron');
const {promises:fs,mkdirSync,writeFileSync}=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const artifacts=process.env.GOOESHELL_INSTANCE_ARTIFACTS,role=process.env.GOOESHELL_INSTANCE_ROLE;
if(!artifacts||!path.isAbsolute(artifacts)||!path.basename(artifacts).startsWith('single-instance-')||!['primary','duplicate','independent'].includes(role))throw new Error('Explicit isolated fixture directory and role required');
const userData=path.join(artifacts,role==='independent'?'independent-data':'shared-data');mkdirSync(userData,{recursive:true});app.setPath('userData',userData);
const report={role,success:false,userData,checks:{},windows:0,workers:0,stores:0,secondInstances:0,activation:{restore:0,show:0,focus:0},errors:[]};
const saveReport=()=>writeFileSync(path.join(artifacts,role+'.json'),JSON.stringify(report,null,2));
const children=new Set();
const fail=error=>{report.errors.push(error?.stack||String(error));saveReport();for(const child of children)child.kill();app.exit(1);};
process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
safeStorage.isEncryptionAvailable=()=>false;safeStorage.isAsyncEncryptionAvailable=async()=>false;safeStorage.getSelectedStorageBackend=()=> 'basic_text';
safeStorage.encryptString=safeStorage.decryptString=safeStorage.encryptStringAsync=safeStorage.decryptStringAsync=()=>{throw new Error('Fixture forbids the OS keyring');};
const workers=require('node:worker_threads'),OriginalWorker=workers.Worker;
workers.Worker=class extends OriginalWorker{constructor(...args){report.workers++;super(...args);}};
for(const [file,name] of [['store','Store'],['credential-store','CredentialStore'],['command-store','CommandStore']]){
 const module=require(path.resolve(__dirname,'../../dist-main/main/'+file+'.js')),Original=module[name];
 module[name]=class extends Original{constructor(...args){report.stores++;super(...args);}};
}
app.on('second-instance',()=>report.secondInstances++);
app.on('will-quit',()=>{if(role==='duplicate'){report.success=report.windows===0&&report.workers===0&&report.stores===0;saveReport();}});
let window,pretendMinimized=false;
app.on('browser-window-created',(_event,created)=>{
 report.windows++;window=created;
 // These three window effects are observed without showing or focusing a test
 // window on the user's desktop. The Electron instance lock and all processes,
 // stores, worker and renderer creation remain real.
 window.isMinimized=()=>pretendMinimized;window.isVisible=()=>false;
 window.restore=()=>{report.activation.restore++;pretendMinimized=false;};
 window.show=()=>report.activation.show++;window.focus=()=>report.activation.focus++;
 window.webContents.once('did-finish-load',()=>void run().catch(fail));
});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const deadline=Date.now()+6000;while(!predicate()){if(Date.now()>deadline)throw new Error('Single-instance fixture timed out');await delay(20);}}
async function childRun(childRole){
 const env={...process.env,GOOESHELL_INSTANCE_ROLE:childRole};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(process.execPath,[__filename,...(process.platform==='linux'&&process.env.CI?['--no-sandbox']:[])],{env,cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});children.add(child);
 let logs='';child.stdout.on('data',bytes=>logs+=bytes.toString());child.stderr.on('data',bytes=>logs+=bytes.toString());
 const timeout=setTimeout(()=>child.kill(),18000);timeout.unref();
 const exit=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});clearTimeout(timeout);children.delete(child);
 const result=JSON.parse(await fs.readFile(path.join(artifacts,childRole+'.json'),'utf8').catch(()=>{throw new Error('Missing '+childRole+' report: '+logs);}));
 assert.equal(exit,0,JSON.stringify(result)+logs);return result;
}
async function run(){
 await delay(50);assert.equal(app.hasSingleInstanceLock(),true);assert.equal(report.windows,1);assert.equal(report.workers,1);assert.equal(report.stores,3);
 if(role==='independent'){report.success=true;saveReport();app.exit(0);return;}
 assert.equal(role,'primary');report.checks.primaryInitialized=true;
 pretendMinimized=true;const before={...report.activation};const duplicate=await childRun('duplicate');
 assert.equal(duplicate.success,true);assert.equal(duplicate.windows,0);assert.equal(duplicate.workers,0);assert.equal(duplicate.stores,0);assert.equal(duplicate.userData,userData);report.checks.duplicateExitedBeforeInit=true;
 await until(()=>report.secondInstances===1&&report.activation.focus>before.focus);
 assert.equal(report.activation.restore,before.restore+1);assert.equal(report.activation.show,before.show+1);assert.equal(report.activation.focus,before.focus+1);assert.equal(pretendMinimized,false);report.checks.existingWindowActivated=true;
 const independent=await childRun('independent');assert.equal(independent.success,true);assert.notEqual(independent.userData,userData);assert.equal(independent.windows,1);assert.equal(independent.workers,1);assert.equal(independent.stores,3);assert.equal(report.secondInstances,1);report.checks.separateUserDataAllowed=true;
 report.success=true;saveReport();app.exit(0);
}
require(path.resolve(__dirname,'../../dist-main/main/main.js'));
