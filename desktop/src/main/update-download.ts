import {createHash,randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {UpdateAsset} from '../shared/update';

const allowedHosts=new Set(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','objects-origin.githubusercontent.com','github-releases.githubusercontent.com']);
function allowedUrl(value:string){const url=new URL(value);if(url.protocol!=='https:'||!allowedHosts.has(url.hostname)||url.username||url.password||url.port)throw new Error('更新下载地址不可信');return url;}
/** Download an already-validated GitHub release asset; never publish an unchecked file. */
export async function downloadUpdate(asset:UpdateAsset,destination:string,signal:AbortSignal,onProgress:(received:number,total:number)=>void,request:typeof fetch=fetch):Promise<void>{
  if(!path.isAbsolute(destination)||path.basename(destination)!==asset.name)throw new Error('请选择与更新包名称一致的目标路径');
  let url=allowedUrl(asset.url),response:Response|undefined;
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(30*60_000)]);
  for(let redirects=0;redirects<=5;redirects++){
    response=await request(url,{redirect:'manual',signal:deadline,headers:{'User-Agent':'GooeShell'}});
    if(response.status>=300&&response.status<400){const location=response.headers.get('location');await response.body?.cancel();if(!location||redirects===5)throw new Error('更新下载跳转无效');url=allowedUrl(new URL(location,url).href);continue;}
    break;
  }
  if(!response?.ok||!response.body)throw new Error(`更新下载失败（HTTP ${response?.status??0}）`);
  const temporary=path.join(path.dirname(destination),'.gooeshell-update-'+randomUUID()+'.part');
  let created=false;const reader=response.body.getReader();
  try{
    const handle=await fs.open(temporary,'wx',0o600);created=true;
    try{
      const digest=createHash('sha256');let received=0;
      for(;;){const {value,done}=await reader.read();if(done)break;deadline.throwIfAborted();received+=value.length;if(received>asset.size)throw new Error('更新包大小不符');digest.update(value);await handle.writeFile(value);onProgress(received,asset.size);}
      if(received!==asset.size||digest.digest('hex')!==asset.sha256)throw new Error('更新包大小或 SHA-256 校验失败');
      await handle.sync();
    }finally{await handle.close();}
    deadline.throwIfAborted();
    try{await fs.link(temporary,destination);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('目标文件已存在，请选择其他位置');throw error;}
  }finally{await reader.cancel().catch(()=>{});if(created)await fs.unlink(temporary).catch(()=>{});}
}
