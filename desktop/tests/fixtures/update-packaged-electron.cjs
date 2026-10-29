const {app,dialog}=require('electron');
const {promises:fs,mkdirSync}=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const dir=process.env.GOOESHELL_UPDATE_FIXTURE;
if(!dir||!path.isAbsolute(dir)||!path.basename(dir).startsWith('update-electron-'))throw new Error('Isolated fixture directory required');
mkdirSync(path.join(dir,'data'),{recursive:true});app.setPath('userData',path.join(dir,'data'));app.setVersion('1.4.1');
const assetName='GooeShell-9.9.9-win-x64.zip';
const archive=path.join(dir,'fixture.zip'),download=path.join(dir,assetName);
const root='https://github.com/gooesman/gooeshell/releases';
dialog.showSaveDialog=async()=>({canceled:false,filePath:download});
dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});
let window;
const evalJs=code=>window.webContents.executeJavaScript(code);
const call=(method,...args)=>evalJs(`window.gooeshell[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
async function run(){
 const payload=await fs.readFile(archive),asset={name:assetName,state:'uploaded',size:payload.length,digest:'sha256:'+createHash('sha256').update(payload).digest('hex'),browser_download_url:root+'/download/v9.9.9/'+assetName};
 global.fetch=async url=>String(url).includes('api.github.com')?new Response(JSON.stringify({tag_name:'v9.9.9',draft:false,prerelease:false,html_url:root+'/tag/v9.9.9',assets:[asset]})):new Response(payload);
 await call('checkUpdate');await call('downloadUpdate',assetName);
 if(!app.isPackaged)throw new Error('Expected a packaged Electron application');
 await fs.writeFile(path.join(dir,'install-started'),'yes');
 void call('installUpdate').catch(async error=>{if(!window.isDestroyed()){await fs.writeFile(path.join(dir,'error.txt'),error.stack||String(error));app.exit(1);}});
}
app.on('browser-window-created',(_event,created)=>{window=created;window.on('show',()=>window.hide());window.webContents.once('did-finish-load',()=>void run().catch(async error=>{await fs.writeFile(path.join(dir,'error.txt'),error.stack||String(error));app.exit(1);}));});
require(process.env.GOOESHELL_UPDATE_MAIN);
