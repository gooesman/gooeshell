/** Renderer-safe parent navigation for native local paths and POSIX remote paths. */
export function parentPath(value:string,side:'local'|'remote'):string{
  if(side==='remote'||value.startsWith('/'))return value.replace(/\/+$/,'').replace(/\/[^/]*$/,'')||'/';
  const trimmed=value.replace(/[\\/]+$/,'');
  const parent=trimmed.replace(/[\\/][^\\/]*$/,'');
  return parent===trimmed||/^[A-Za-z]:$/.test(parent)?(parent.match(/^[A-Za-z]:/)?.[0]||parent)+'\\':parent;
}
