const {app,dialog,safeStorage}=require('electron');
const {promises:fs,mkdirSync}=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const dir=process.env.GOOESHELL_MAINTENANCE_DIR;
if(!dir||!path.isAbsolute(dir)||!path.basename(dir).startsWith('maintenance-main-'))throw new Error('Isolated fixture directory required');
const data=path.join(dir,'data');mkdirSync(data,{recursive:true});app.setPath('userData',data);
app.setVersion('1.4.1');
safeStorage.isAsyncEncryptionAvailable=async()=>true;safeStorage.encryptStringAsync=async value=>Buffer.from(value);safeStorage.decryptStringAsync=async value=>({result:value.toString()});
safeStorage.isEncryptionAvailable=()=>true;safeStorage.getSelectedStorageBackend=()=>'gnome_libsecret';safeStorage.encryptString=value=>Buffer.from(value);safeStorage.decryptString=value=>value.toString();
const suffix=process.platform==='win32'?'win-x64.zip':process.platform==='darwin'?`mac-${process.arch}.zip`:'linux-x64.AppImage';
const backup=path.join(dir,'fixture.gsbak'),assetName=`GooeShell-9.9.9-${suffix}`,payload=Buffer.from('synthetic update bytes'),archive=path.join(dir,assetName);
dialog.showSaveDialog=async(_win,options)=>({canceled:false,filePath:options.title.includes('备份')?backup:archive});
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[backup]});
const root='https://github.com/gooesman/gooeshell/releases',asset={name:assetName,state:'uploaded',size:payload.length,digest:'sha256:'+createHash('sha256').update(payload).digest('hex'),browser_download_url:root+'/download/v9.9.9/'+assetName};
global.fetch=async url=>String(url).includes('api.github.com')?new Response(JSON.stringify({tag_name:'v9.9.9',draft:false,prerelease:false,html_url:root+'/tag/v9.9.9',assets:[asset]})):new Response(payload);
const result={success:false,checks:{}},wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));let window,phase='startup';
const evalJs=code=>window.webContents.executeJavaScript(code);
const call=(method,...args)=>evalJs(`window.gooeshell[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
async function until(code){for(let i=0;i<200;i++){if(await evalJs(code))return;await wait(50);}throw new Error('Timed out: '+code);}
async function click(label){const query=`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`;await until(`Boolean(${query})`);await evalJs(`${query}.click()`);}
async function fill(selector,value){await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select();})()`);await window.webContents.insertText(value);}
async function run(){
 await until('Boolean(window.gooeshell && document.querySelector(".connection-home"))');
 const profile={id:'fixture-profile',name:'Fixture only',host:'fixture.invalid',port:22,username:'fixture',auth:'password',rememberHost:true,encoding:'utf8'};
 await call('saveConnection',{profile,favorite:true,credentials:{remember:'persistent',password:'fixture-secret',sudoUsesLogin:true}});
 await call('setHostKeyPreference',{host:'fixture.invalid',port:22,skipVerification:true});
 await evalJs('document.querySelector(\'.titlebar [aria-label="设置"]\').click()');await click('更新与备份');
 phase='check and download';await click('检查更新');await until('document.body.innerText.includes("发现新版本 9.9.9")');
 await click('下载 '+assetName);await until('document.body.innerText.includes("更新包下载并校验完成")');assert.deepEqual(await fs.readFile(archive),payload);result.checks.update=true;
 phase='export';await evalJs('document.querySelector(\'input[type="checkbox"]\').click()');await fill('#backup-export-password','fixture-passphrase');await fill('#backup-export-confirm','fixture-passphrase');await click('导出配置');await until('document.body.innerText.includes("加密备份已导出")');
 assert(!(await fs.readFile(backup,'utf8')).includes('fixture-secret'));await call('deleteConnection',profile.id);await call('setHostKeyPreference',{host:'fixture.invalid',port:22,skipVerification:false});assert.equal((await call('connections')).connections.length,0);
 phase='wrong password';await click('选择备份文件');await until('Boolean(document.querySelector("#backup-import-password"))');await fill('#backup-import-password','wrong-passphrase');await click('验证并预览');await until('document.body.innerText.includes("备份密码错误或文件已损坏")');assert.equal((await call('connections')).connections.length,0);
 phase='import';await fill('#backup-import-password','fixture-passphrase');await click('验证并预览');await until('document.body.innerText.includes("1 个连接")');assert.match(await evalJs('document.body.innerText'),/1 个地址的跳过指纹验证设置/);await evalJs('[...document.querySelectorAll("label")].find(e=>e.textContent.includes("1 个地址的跳过指纹验证设置")).querySelector("input").click()');await click('合并导入');await until('document.body.innerText.includes("导入完成：新增 1 个连接")');
 const imported=(await call('connections')).connections[0];assert.equal(imported.host,'fixture.invalid');assert.equal((await call('credentialStatus',imported)).hasPassword,true);assert.equal((await call('initial')).hostKeyPreferences[0].skipVerification,true);result.checks.backup=true;result.success=true;
}
app.on('browser-window-created',(_event,created)=>{window=created;window.on('show',()=>window.hide());window.webContents.once('did-finish-load',()=>void run().catch(async error=>{result.error=error.stack||String(error);try{result.body=await evalJs('document.body.innerText');}catch{}}).finally(async()=>{result.phase=phase;await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(result));app.exit(result.success?0:1);}));});
require('../../dist-main/main/main.js');
