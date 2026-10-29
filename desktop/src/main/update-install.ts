import {createHash,randomUUID} from 'node:crypto';
import {appendFileSync,closeSync,createReadStream,openSync,promises as fs} from 'node:fs';
import path from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import type {UpdateAsset} from '../shared/update';

const execute=promisify(execFile);
export interface WindowsUpdatePlan {current:string;stage:string;backup:string;helper:string}

// Paths are passed as environment variables, never interpolated into PowerShell.
const extractScript=String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($env:GOOESHELL_STAGE).TrimEnd('\') + '\'
$zip = [IO.Compression.ZipFile]::OpenRead($env:GOOESHELL_ARCHIVE)
try {
  $total = 0L
  if ($zip.Entries.Count -gt 50000) { throw 'Too many archive entries' }
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('/', '\')
    if ([IO.Path]::IsPathRooted($name) -or $name.Contains(':')) { throw 'Invalid archive path' }
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $name))
    if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid archive path' }
    $type = ($entry.ExternalAttributes -shr 16) -band 61440
    if ($type -eq 40960) { throw 'Archive symlinks are not supported' }
    $total += $entry.Length
    if ($total -gt 4294967296L) { throw 'Archive is too large' }
  }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($env:GOOESHELL_ARCHIVE, $env:GOOESHELL_STAGE)
if (-not (Test-Path -LiteralPath (Join-Path $env:GOOESHELL_STAGE 'resources\app.asar') -PathType Leaf)) { throw 'Update archive is missing app.asar' }
`;

// A detached Windows PowerShell can exit without executing its script. CMD does
// not have that failure mode, and keeps all paths as quoted environment data.
const helperScript=String.raw`@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE="
set "GOOESHELL_CAN_RESTART=1"
set /a attempts=0
echo Waiting for application exit.
:wait
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "try { $p = [Diagnostics.Process]::GetProcessById([int]$env:GOOESHELL_PID); if ($p.HasExited) { exit 1 }; exit 0 } catch [ArgumentException] { exit 1 } catch { exit 2 }" > "%GOOESHELL_PID_REPORT%" 2>&1
if errorlevel 2 goto status_failed
if errorlevel 1 goto replace
set /a attempts+=1
if %attempts% GEQ 120 goto failed
"%SystemRoot%\System32\ping.exe" 127.0.0.1 -n 2 -w 1000 >nul 2>&1
goto wait
:replace
echo Preparing replacement.
if not exist "%GOOESHELL_STAGE%\GooeShell.exe" goto failed
if not exist "%GOOESHELL_STAGE%\resources\app.asar" goto failed
if exist "%GOOESHELL_BACKUP%" goto failed
set /a attempts=0
:move_old
move "%GOOESHELL_CURRENT%" "%GOOESHELL_BACKUP%"
if not errorlevel 1 goto move_new
if exist "%GOOESHELL_BACKUP%" goto failed
if not exist "%GOOESHELL_CURRENT%" goto failed
set /a attempts+=1
if %attempts% GEQ 20 goto failed
"%SystemRoot%\System32\ping.exe" 127.0.0.1 -n 2 -w 1000 >nul 2>&1
goto move_old
:move_new
set "GOOESHELL_CAN_RESTART="
move "%GOOESHELL_STAGE%" "%GOOESHELL_CURRENT%" >nul
if errorlevel 1 goto rollback
start "" /b "%GOOESHELL_CURRENT%\GooeShell.exe"
if not errorlevel 1 exit /b 0
move "%GOOESHELL_CURRENT%" "%GOOESHELL_STAGE%" >nul
:rollback
if exist "%GOOESHELL_CURRENT%" goto failed
move "%GOOESHELL_BACKUP%" "%GOOESHELL_CURRENT%" >nul
if errorlevel 1 goto failed
set "GOOESHELL_CAN_RESTART=1"
:failed
echo Update failed.
echo Update failed. Review the update log and retry.>"%GOOESHELL_UPDATE_ERROR%"
if defined GOOESHELL_CAN_RESTART if exist "%GOOESHELL_CURRENT%\GooeShell.exe" start "" /b "%GOOESHELL_CURRENT%\GooeShell.exe"
exit /b 1
:status_failed
echo Process status check failed.
goto failed
`;

export async function prepareWindowsUpdate(archive:string,asset:UpdateAsset,exe:string,userData:string):Promise<WindowsUpdatePlan>{
 const current=path.dirname(path.resolve(exe));
 if(path.basename(exe).toLowerCase()!=='gooeshell.exe')throw new Error('当前程序不是可更新的 Windows 发行包');
 const hash=createHash('sha256');let size=0;
 for await(const chunk of createReadStream(archive)){size+=(chunk as Buffer).length;if(size>asset.size)throw new Error('更新包大小已改变');hash.update(chunk as Buffer);}
 if(size!==asset.size||hash.digest('hex')!==asset.sha256.toLowerCase())throw new Error('更新包已改变，请重新下载');
 const stage=await fs.mkdtemp(path.join(path.dirname(current),'.gooeshell-update-'));
 try{
  await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',extractScript],{windowsHide:true,timeout:180000,maxBuffer:1024*1024,env:{...process.env,GOOESHELL_ARCHIVE:path.resolve(archive),GOOESHELL_STAGE:stage}});
  if(!(await fs.stat(path.join(stage,'GooeShell.exe'))).isFile())throw new Error('更新包缺少程序文件');
  const helpers=path.join(userData,'updates');await fs.mkdir(helpers,{recursive:true});
  const helper=path.join(helpers,`update-${randomUUID()}.cmd`);await fs.writeFile(helper,helperScript.replaceAll('\n','\r\n'),{flag:'wx'});
  return{current,stage,backup:path.join(path.dirname(current),'.gooeshell-previous-'+randomUUID()),helper};
 }catch(error){await fs.rm(stage,{recursive:true,force:true}).catch(()=>{});throw new Error(`准备更新失败：${error instanceof Error?error.message:String(error)}`);}
}

export function launchWindowsUpdate(plan:WindowsUpdatePlan,pid=process.pid,detached=true,onError?:(error:Error)=>void){
 const log=openSync(plan.helper+'.log','a');
 const systemRoot=process.env.SystemRoot||process.env.WINDIR;if(!systemRoot){closeSync(log);throw new Error('无法找到 Windows 系统目录');}
 let child;
 try{child=spawn(path.join(systemRoot,'System32','cmd.exe'),['/d','/c','""%GOOESHELL_HELPER%""'],{detached,stdio:['ignore',log,log],windowsHide:true,windowsVerbatimArguments:true,cwd:path.dirname(path.dirname(plan.current)),env:{...process.env,GOOESHELL_HELPER:plan.helper,GOOESHELL_CURRENT:plan.current,GOOESHELL_STAGE:plan.stage,GOOESHELL_BACKUP:plan.backup,GOOESHELL_PID:String(pid),GOOESHELL_PID_REPORT:plan.helper+'.pid',GOOESHELL_UPDATE_ERROR:path.join(path.dirname(plan.helper),'last-error.txt')}});}finally{closeSync(log);}
 child.on('error',error=>{try{appendFileSync(plan.helper+'.log',String(error));}catch{}onError?.(error);});child.unref();return child;
}
