const {app,dialog,safeStorage}=require('electron');
const {promises:fs,mkdirSync}=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const dir=process.env.GOOESHELL_MAINTENANCE_DIR;
if(!dir||!path.isAbsolute(dir)||!path.basename(dir).startsWith('maintenance-main-'))throw new Error('Isolated fixture directory required');
const data=path.join(dir,'data');mkdirSync(data,{recursive:true});app.setPath('userData',data);
app.setVersion('1.4.1');
if(process.platform!=='win32'){
safeStorage.isAsyncEncryptionAvailable=async()=>true;safeStorage.encryptStringAsync=async value=>Buffer.from(value);safeStorage.decryptStringAsync=async value=>({result:value.toString()});
safeStorage.isEncryptionAvailable=()=>true;safeStorage.getSelectedStorageBackend=()=>'gnome_libsecret';safeStorage.encryptString=value=>Buffer.from(value);safeStorage.decryptString=value=>value.toString();
}
let omitResponse=0,omitPrompts=0;
dialog.showMessageBox=async(_win,options)=>{assert.equal(options.title,'部分已保存的凭据无法读取');assert(options.detail.includes('Fixture only'));omitPrompts++;return {response:omitResponse};};
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
function scope(legend) {return `[...document.querySelectorAll('fieldset')].find(e=>e.querySelector('legend')?.textContent===${JSON.stringify(legend)})`;}
async function scopeClick(legend,selector,label){
 const query=`[...(${scope(legend)}?.querySelectorAll(${JSON.stringify(selector)})||[])].find(e=>e.textContent.includes(${JSON.stringify(label)}))`;
 await until(`Boolean(${query})`);await evalJs(`${query}.click()`);
}
async function run(){
 await until('Boolean(window.gooeshell && document.querySelector(".connection-home"))');
 const keyFile=path.join(dir,'fixture-private-key');
 const {generateVerifiedEd25519KeyPair}=require('../../dist-main/main/local-keys.js');
 const keyPair=await generateVerifiedEd25519KeyPair('fixture-secret');
 await fs.writeFile(keyFile,keyPair.private,{mode:0o600});
 const profile={id:'fixture-profile',name:'Fixture only',host:'fixture.invalid',port:22,username:'fixture',auth:'key',privateKeyPath:keyFile,rememberHost:true,encoding:'utf8'};
 await call('saveConnection',{profile,favorite:true,credentials:{remember:'persistent',passphrase:'fixture-secret',sudoUsesLogin:true}});
 const identity=await call('saveLoginIdentity',{name:'Fixture identity',username:'fixture',remember:'session'});
 await call('saveGroup',{id:'fixture-group',name:'Demo group',order:0,icon:'cloud'});
 await call('saveConnection',{profile:{...profile,id:'second',name:'Second server',host:'second.invalid',groupId:'fixture-group',loginIdentityId:identity.id},favorite:true});
 await call('setHostKeyPreference',{host:'fixture.invalid',port:22,skipVerification:true});
 await evalJs('document.querySelector(\'.titlebar [aria-label="设置"]\').click()');await click('更新与备份');
 phase='check and download';await click('检查更新');await until('document.body.innerText.includes("发现新版本 9.9.9")');
 await click('下载 '+assetName);await until('document.body.innerText.includes("更新包下载并校验完成")');assert.deepEqual(await fs.readFile(archive),payload);result.checks.update=true;
 phase='export';await scopeClick('备份范围','button','清空');
 await scopeClick('备份范围','summary','选择分组和连接');await scopeClick('备份范围','label','Demo group');
 await until('document.body.innerText.includes("引用了 1 个未选身份")');await scopeClick('备份范围','button','带上关联身份');
 await scopeClick('备份范围','summary','选择身份');
 assert(await evalJs(`[...${scope('备份范围')}.querySelectorAll('label')].find(e=>e.textContent.includes('Fixture identity')).querySelector('input').checked`));
 await scopeClick('备份范围','label','Fixture only');
 await scopeClick('备份范围','label','SSH 私钥文件');
 await scopeClick('备份范围','label','长期保存的密码');await scopeClick('备份范围','label','跳过指纹验证设置');await fill('#backup-export-password','fixture-passphrase');await fill('#backup-export-confirm','fixture-passphrase');// Damage only the synthetic record to exercise the same native dialog as a failed OS decryption.
 const secretFile=path.join(data,'credentials.encrypted.json'),originalCredentials=await fs.readFile(secretFile,'utf8'),bad=JSON.parse(originalCredentials);
 bad.records.find(r=>r.id===profile.id).encrypted=Buffer.from('invalid-fixture').toString('base64');
 await fs.writeFile(secretFile,JSON.stringify(bad));await click('导出配置');
 for(let i=0;i<200&&!omitPrompts;i++)await wait(30);
 assert.equal(omitPrompts,1);await assert.rejects(fs.access(backup),{code:'ENOENT'});
 omitResponse=1;await click('导出配置');await until('document.body.innerText.includes("已按确认跳过")');assert.equal(omitPrompts,2);
 await fs.rename(backup,path.join(dir,'partial-backup.gsbak'));await fs.writeFile(secretFile,originalCredentials);
 await fill('#backup-export-password','fixture-passphrase');await fill('#backup-export-confirm','fixture-passphrase');
 await click('导出配置');await until('document.body.innerText.includes("加密备份已导出。")');
 await fs.unlink(keyFile);
 assert(!(await fs.readFile(backup,'utf8')).includes('fixture-secret'));await call('deleteConnection',profile.id);await call('deleteConnection','second');await call('deleteLoginIdentity',identity.id);await call('setHostKeyPreference',{host:'fixture.invalid',port:22,skipVerification:false});assert.equal((await call('connections')).connections.length,0);
 phase='wrong password';await click('选择备份文件');await until('Boolean(document.querySelector("#backup-import-password"))');await fill('#backup-import-password','wrong-passphrase');await click('验证并预览');await until('document.body.innerText.includes("备份密码错误或文件已损坏")');assert.equal((await call('connections')).connections.length,0);
 phase='import';await fill('#backup-import-password','fixture-passphrase');await click('验证并预览');await until(`Boolean(${scope('恢复范围')})`);assert(!((await evalJs(`${scope('恢复范围')}.innerText`)).includes('快捷键与鼠标')));
 await scopeClick('恢复范围','summary','选择分组和连接');await scopeClick('恢复范围','label','Demo group');
 await scopeClick('恢复范围','label','登录身份');
 await scopeClick('恢复范围','label','SSH 私钥文件');
 await scopeClick('恢复范围','label','长期保存的密码');await scopeClick('恢复范围','label','跳过指纹验证设置');await click('合并导入');await until('document.body.innerText.includes("导入完成：新增 1 个连接")');
 const imported=(await call('connections')).connections[0];assert.equal(imported.host,'fixture.invalid');assert.equal((await call('credentialStatus',imported)).hasPassphrase,true);assert.notEqual(imported.privateKeyPath,keyFile);assert.equal(await fs.readFile(imported.privateKeyPath,'utf8'),keyPair.private);assert.equal((await call('initial')).hostKeyPreferences[0].skipVerification,true);assert.equal((await call('listLoginIdentities')).identities.length,0);result.checks.backup=true;
 phase='keyboard only';await fs.rename(backup,path.join(dir,'connection-backup.gsbak'));
 const original=(await call('initial')).settings;
 await call('saveSettings',{...original,copyOnSelect:true,shortcuts:{...original.shortcuts,paste:'Alt+V'}});
 await scopeClick('备份范围','button','清空');await scopeClick('备份范围','label','快捷键与鼠标');
 await fill('#backup-export-password','fixture-passphrase');await fill('#backup-export-confirm','fixture-passphrase');await click('导出配置');
 await until('document.body.innerText.includes("加密备份已导出")');
 await call('saveSettings',{...original,fontSize:27,externalEditorPath:'test-editor'});
 await click('选择备份文件');await fill('#backup-import-password','fixture-passphrase');await click('验证并预览');
 await scopeClick('恢复范围','label','快捷键与鼠标');await until('document.body.innerText.includes("将替换本机设置：快捷键与鼠标")');
 await click('合并导入');await until('document.body.innerText.includes("导入完成：1 类设置")');
 const next=(await call('initial')).settings;
 assert.equal(next.shortcuts.paste,'Alt+V');assert.equal(next.copyOnSelect,true);assert.equal(next.fontSize,27);assert.equal(next.externalEditorPath,'test-editor');
 assert.equal((await call('connections')).connections.length,1);result.checks.keyboardOnly=true;result.success=true;
}
app.on('browser-window-created',(_event,created)=>{window=created;window.on('show',()=>window.hide());window.webContents.once('did-finish-load',()=>void run().catch(async error=>{result.error=error.stack||String(error);try{result.body=await evalJs('document.body.innerText');}catch{}}).finally(async()=>{result.phase=phase;await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(result));app.exit(result.success?0:1);}));});
require('../../dist-main/main/main.js');
