import type {UpdateRelease} from '../shared/update';
const apiUrl = 'https://api.github.com/repos/gooesman/gooeshell/releases/latest';
const releaseRoot = 'https://github.com/gooesman/gooeshell/releases';
const maxMetadataBytes = 1024 * 1024;
const maxAssetBytes = 1024 * 1024 * 1024;
export type UpdatePlatform = 'win32' | 'darwin' | 'linux';
export type {UpdateRelease} from '../shared/update';

function version(value:string):number[] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error('版本号格式无效');
  const parts = match.slice(1).map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('版本号过大');
  return parts;
}
export function parseLatestRelease(value:unknown, current:string, platform:UpdatePlatform, arch:string):UpdateRelease {
  if (!value || typeof value !== 'object') throw new Error('更新信息格式无效');
  const data = value as Record<string,unknown>;
  if (typeof data.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(data.tag_name) || data.draft !== false || data.prerelease !== false || !Array.isArray(data.assets)) throw new Error('更新信息格式无效');
  const latest = data.tag_name.slice(1), newest = version(latest), installed = version(current);
  const page = `${releaseRoot}/tag/${data.tag_name}`;
  if (data.html_url !== page) throw new Error('更新页面地址无效');
  const newer = newest.some((part,index) => part !== installed[index] && newest.slice(0,index).every((prev,i)=>prev===installed[i]) && part > installed[index]);
  const suffixes = platform === 'win32' && arch === 'x64' ? ['win-x64.zip'] : platform === 'darwin' && (arch === 'x64' || arch === 'arm64') ? [`mac-${arch}.zip`,`mac-${arch}.dmg`] : platform === 'linux' && arch === 'x64' ? ['linux-x64.AppImage','linux-x64.deb'] : [];
  const allAssets = data.assets;
  const assets = suffixes.flatMap(suffix => {
    const name = `GooeShell-${latest}-${suffix}`;
    const candidates = allAssets.filter((item:unknown)=>item && typeof item === 'object' && (item as Record<string,unknown>).name === name) as Record<string,unknown>[];
    if (candidates.length > 1) throw new Error('更新包名称重复');
    if (!candidates.length) return [];
    const item = candidates[0], url = `${releaseRoot}/download/${data.tag_name}/${name}`;
    if (item.state !== 'uploaded' || item.browser_download_url !== url || !Number.isSafeInteger(item.size) || (item.size as number) <= 0 || (item.size as number) > maxAssetBytes || typeof item.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(item.digest)) throw new Error('更新包信息或校验值无效');
    return [{name,url,size:item.size as number,sha256:item.digest.slice(7).toLowerCase()}];
  });
  return {version:latest,page,notes:typeof data.body === 'string' ? data.body.slice(0,65536) : '',assets,newer};
}

export async function checkForUpdate(current:string, platform:UpdatePlatform, arch:string, request:typeof fetch = fetch):Promise<UpdateRelease> {
  const response = await request(apiUrl,{headers:{Accept:'application/vnd.github+json','User-Agent':'GooeShell'},signal:AbortSignal.timeout(20_000),redirect:'error'});
  if (!response.ok || !response.body) throw new Error(`检查更新失败（HTTP ${response.status}）`);
  const reader = response.body.getReader(); const chunks:Uint8Array[] = []; let size = 0;
  try { for (;;) { const {value,done} = await reader.read(); if (done) break; size += value.length; if (size > maxMetadataBytes) throw new Error('更新信息过大'); chunks.push(value); } }
  finally { await reader.cancel().catch(()=>{}); }
  let data:unknown; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('更新信息不是有效 JSON'); }
  return parseLatestRelease(data,current,platform,arch);
}
