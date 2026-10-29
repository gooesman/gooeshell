import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

test('transfer queue resizes with pointer and retains height when collapsed', { skip: process.env.GOOESHELL_TRANSFER_RESIZE_TEST !== '1' && 'Set GOOESHELL_TRANSFER_RESIZE_TEST=1 with Electron and a display', timeout: 45_000 }, async t => {
  const root = process.cwd(), artifactsRoot = path.resolve('../.build'); await fs.mkdir(artifactsRoot, {recursive:true});
  const artifacts = await fs.mkdtemp(path.join(artifactsRoot, 'transfer-resize-')), report = path.join(artifacts, 'result.json');
  const vite = await createServer({configFile:false,root,cacheDir:path.join(artifacts,'vite-cache'),plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false}});
  await vite.listen(); t.after(() => vite.close());
  const port = (vite.httpServer!.address() as {port:number}).port;
  const executable = process.platform === 'darwin' ? path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : path.join(root,'node_modules/electron/dist',process.platform === 'win32' ? 'electron.exe' : 'electron');
  const env = {...process.env,GOOESHELL_RESIZE_URL:`http://127.0.0.1:${port}/tests/fixtures/app-explorer-render.html`,GOOESHELL_RESIZE_REPORT:report,GOOESHELL_RESIZE_DATA:path.join(artifacts,'data')}; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable,[...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),path.join(root,'tests/fixtures/transfer-resize-electron.cjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','ignore','pipe']});
  let stderr=''; child.stderr.on('data',data=>{stderr+=data;});
  const timeout=setTimeout(()=>child.kill(),40_000); timeout.unref(); t.after(()=>{if(child.exitCode===null)child.kill();});
  const exit=await new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);}); clearTimeout(timeout);
  const result=JSON.parse(await fs.readFile(report,'utf8').catch(()=>{throw new Error('No resize report: '+stderr);}));
  t.diagnostic(`resize artifacts: ${artifacts}`); assert.equal(exit,0,JSON.stringify(result)); assert.equal(result.success,true,JSON.stringify(result));
  for(const name of ['pointer','keyboard','collapse','bounds'])assert.equal(result.checks[name],true,name);
});
