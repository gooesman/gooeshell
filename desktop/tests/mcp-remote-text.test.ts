import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Client as SshClient, type SFTPWrapper } from 'ssh2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpBridge } from '../src/main/mcp-bridge';
import { bridgeRemoteText } from '../src/main/bridge-remote-text';
import { SshService } from '../src/main/ssh-service';
import { sftpCall, trackSftp } from '../src/main/sftp-transfer';
import { encodeEditableText } from '../src/main/text-files';
import { parseMcpCall } from '../src/main/mcp-tools';
import { cli } from '../src/main/cli';

test('remote text tools reject unsafe parameters and abort before a second write', async () => {
  assert.throws(() => parseMcpCall('read_remote_text', { sessionId: 's', path: 'relative' }));
  assert.throws(() => parseMcpCall('read_remote_text', { sessionId: 's', path: '/x', elevated: true }));
  assert.throws(() => parseMcpCall('write_remote_text', { sessionId: 's', path: '/x', text: 'x', encoding: 'utf8', expectedRevision: 'anything' }));
  assert.throws(() => parseMcpCall('edit_remote_text', { sessionId: 's', path: '/x', expectedRevision: 'v1:' + 'a'.repeat(64), oldText: '', newText: 'x' }));
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(bridgeRemoteText('edit_remote_text', { sessionId: 's', path: '/x', expectedRevision: 'v1:' + 'a'.repeat(64), oldText: 'old', newText: 'new' }, controller.signal,
    async method => { if (method === 'writeTextFile') { writes++; return {}; } controller.abort(); return { text: 'old', revision: 'v1:' + 'a'.repeat(64) }; }, () => true));
  assert.equal(writes, 0);
});

const readyFile = process.env.GOOESHELL_SFTP_TEST_READY;
test('MCP and CLI remote text operations use real isolated SSH/SFTP with conflict protection', {
  skip: readyFile ? false : 'Requires disposable loopback SFTP fixture', timeout: 60000,
}, async t => {
  const values = Object.fromEntries((await fs.readFile(readyFile!, 'utf8')).trim().split(/\r?\n/).map(line => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
  }));
  assert.equal(values.fixture, 'gooeshell-sftp-v1'); assert.equal(values.host, '127.0.0.1');
  assert.ok(path.basename(values.root).startsWith('gooeshell-sftp-test-'));
  assert.equal(await fs.readFile(path.join(values.root, 'fixture.token'), 'utf8'), values.token);
  const ssh = new SshClient(); ssh.on('error', () => {}); t.after(() => ssh.destroy());
  await new Promise<void>((resolve, reject) => ssh.once('ready', resolve).once('error', reject).connect({ host: values.host, port: Number(values.port), username: values.username, password: values.password,
    hostVerifier: (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === values.fingerprint }));
  const sftp = await sftpCall<SFTPWrapper>(cb => ssh.sftp(cb)); trackSftp(sftp);
  const service = new SshService(() => {}, path.join(values.root, 'mcp-text-known-hosts.json'));
  const adapter = service as unknown as { sessions: Map<string, unknown>; control: () => Promise<{client:SshClient;sftp:SFTPWrapper}> };
  adapter.sessions.set('fixture', { id:'fixture', profile:{host:values.host,port:Number(values.port),username:values.username}, fingerprint:values.fingerprint, closed:false });
  adapter.control = async () => ({ client:ssh, sftp });
  const caseName = randomUUID(), directory = path.join(values.root, 'remote', caseName); await fs.mkdir(directory);
  const remotePath = `/${caseName}/脚本.sh`, diskPath = path.join(directory, '脚本.sh');
  const bridgeRoot = path.join(values.root, 'mcp-' + caseName);
  const bridge = new McpBridge(bridgeRoot, {command:process.execPath,args:[],env:{}}, async (name,args,signal) => {
    assert.ok(name === 'read_remote_text' || name === 'write_remote_text' || name === 'edit_remote_text');
    return bridgeRemoteText(name,args,signal,async (method,request) => method === 'readTextFile' ? service.readTextFile(request) : service.writeTextFile(request),() => true);
  }, async () => {});
  const client = new Client({name:'isolated-mcp-text-test',version:'1.0'});
  const transport = new StdioClientTransport({command:process.execPath,args:['--import','tsx',path.resolve('src/main/mcp-stdio.ts'),bridge.file],stderr:'pipe'});
  t.after(async () => { await client.close(); await bridge.stop(); });
  await bridge.setEnabled(true); await client.connect(transport);
  const call = async (name:string,args:unknown) => {
    const result = await client.callTool({name,arguments:args as Record<string,unknown>});
    const text = (result.content as Array<{type:string;text?:string}>).find(item => item.type === 'text')?.text || '';
    if (result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  const base = {sessionId:'fixture',path:remotePath};
  await call('write_remote_text',{...base,text:'#!/bin/sh\r\necho 原文\r\n',encoding:'utf8',expectedRevision:'missing'});
  const cliOutput:string[] = [];
  assert.equal(await cli(['--bridge',bridge.file,'read-remote-text',JSON.stringify(base)],new AbortController().signal,value=>cliOutput.push(value)),0);
  assert.equal(JSON.parse(cliOutput[0]).text,'#!/bin/sh\r\necho 原文\r\n');
  await assert.rejects(call('write_remote_text',{...base,text:'overwrite',encoding:'utf8',expectedRevision:'missing'}),/TEXT_CONFLICT/);
  let current = await call('read_remote_text',base); assert.equal(current.lineEnding,'crlf');
  await call('edit_remote_text',{...base,expectedRevision:current.revision,oldText:'echo 原文',newText:'echo 修改'});
  assert.equal(await fs.readFile(diskPath,'utf8'),'#!/bin/sh\r\necho 修改\r\n');
  await assert.rejects(call('edit_remote_text',{...base,expectedRevision:current.revision,oldText:'echo 修改',newText:'wrong'}),/TEXT_CONFLICT/);
  current = await call('read_remote_text',base);
  await assert.rejects(call('edit_remote_text',{...base,expectedRevision:current.revision,oldText:'absent',newText:'wrong'}),/TEXT_MATCH_ERROR/);
  await fs.writeFile(diskPath,encodeEditableText('重复\n重复\n','utf16le'));
  current = await call('read_remote_text',base); assert.equal(current.encoding,'utf16le'); assert.equal(current.bom,true);
  await assert.rejects(call('edit_remote_text',{...base,expectedRevision:current.revision,oldText:'重复',newText:'wrong'}),/TEXT_MATCH_ERROR/);
  await call('edit_remote_text',{...base,expectedRevision:current.revision,oldText:'重复\n重复',newText:'已修改'});
  assert.deepEqual(await fs.readFile(diskPath),encodeEditableText('已修改\n','utf16le'));
  current = await call('read_remote_text',base);
  const concurrent = await Promise.allSettled(['one','two'].map(newText => call('edit_remote_text',{...base,expectedRevision:current.revision,oldText:'已修改',newText})));
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length,1);
  assert.match((concurrent.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.message,/TEXT_CONFLICT/);
  const gb = encodeEditableText('旧内容\r\n','gb18030'); await fs.writeFile(diskPath,gb);
  await assert.rejects(call('read_remote_text',base),/TEXT_ENCODING_REQUIRED/);
  current = await call('read_remote_text',{...base,encoding:'gb18030'});
  await call('edit_remote_text',{...base,encoding:'gb18030',expectedRevision:current.revision,oldText:'旧内容',newText:'新内容'});
  assert.deepEqual(await fs.readFile(diskPath),encodeEditableText('新内容\r\n','gb18030'));
  const big5 = encodeEditableText('舊內容\r\n','big5');await fs.writeFile(diskPath,big5);
  current = await call('read_remote_text',{...base,encoding:'big5'});
  await assert.rejects(call('edit_remote_text',{...base,encoding:'big5',expectedRevision:current.revision,oldText:'舊內容',newText:'😀'}),/TEXT_ENCODING_UNREPRESENTABLE/);
  assert.deepEqual(await fs.readFile(diskPath),big5);
  const largeRequest = {...base,path:`/${caseName}/too-large.txt`,text:'x'.repeat(256*1024),encoding:'utf8',expectedRevision:'missing'};
  await assert.rejects(call('write_remote_text',largeRequest));
  await assert.rejects(fs.stat(path.join(directory,'too-large.txt')),{code:'ENOENT'});
  if (process.platform !== 'win32') {
    const link = path.join(directory,'link.txt');await fs.symlink(diskPath,link);
    await assert.rejects(call('read_remote_text',{...base,path:`/${caseName}/link.txt`}),/普通文件/);
  }
  await fs.writeFile(diskPath,Buffer.alloc(2*1024*1024+1,65));
  current = await call('read_remote_text',base); assert.equal(current.truncated,true); assert.match(current.revision,/^preview:/);
  await assert.rejects(call('edit_remote_text',{...base,expectedRevision:current.revision,oldText:'A',newText:'x'}));
});
