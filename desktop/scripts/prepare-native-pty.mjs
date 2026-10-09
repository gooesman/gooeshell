import {createRequire} from 'node:module';
import {promises as fs} from 'node:fs';
import path from 'node:path';

// node-pty 1.1.0 has two upstream macOS packaging defects. Apply bounded,
// idempotent fixes before packaging; do not mutate an installed application.
const require=createRequire(import.meta.url);
const root=path.dirname(require.resolve('node-pty/package.json'));
const metadata=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
if(metadata.version!=='1.1.0')throw new Error('Review native PTY fixes before upgrading node-pty');
const file=path.join(root,'lib/unixTerminal.js');
let source=await fs.readFile(file,'utf8');
for(const archive of ['app','node_modules']){
  const original=`helperPath = helperPath.replace('${archive}.asar', '${archive}.asar.unpacked');`;
  const fixed=`if (!helperPath.includes('${archive}.asar.unpacked')) ${original}`;
  if(!source.includes(fixed)){
    if(!source.includes(original))throw new Error('Unexpected PTY helper path implementation');
    source=source.replace(original,fixed);
  }
}
await fs.writeFile(file,source);
if(process.platform==='darwin'){
  let found=false;
  for(const directory of ['build/Release','build/Debug',`prebuilds/darwin-${process.arch}`]){
    const helper=path.join(root,directory,'spawn-helper');
    const stat=await fs.lstat(helper).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(stat){if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Invalid PTY helper');await fs.chmod(helper,stat.mode|0o111);found=true;}
  }
  if(!found)throw new Error('Missing macOS PTY spawn helper');
}
