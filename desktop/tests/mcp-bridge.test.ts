import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {request as httpRequest} from 'node:http';
import {createServer} from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {McpBridge} from '../src/main/mcp-bridge';

test('MCP stdio bridge authenticates locally, validates calls and revokes in-flight access',async t=>{
  const base=path.resolve('test-output');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'mcp-bridge-'));
  let cancelled=false;const calls:string[]=[];
  const bridge=new McpBridge(root,{command:process.execPath,args:[],env:{}},async(name,args,signal)=>{
    calls.push(name);
    if(name==='run_command')return new Promise(resolve=>{signal.addEventListener('abort',()=>{cancelled=true;resolve({cancelled:true});},{once:true});});
    return name==='connect'?{id:'session',connectionId:args.connectionId}:[{connectionId:'fixture',name:'Fixture'}];
  },async()=>{});
  const client=new Client({name:'isolated-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',path.resolve('src/main/mcp-stdio.ts'),bridge.file],stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',data=>stderr+=data.toString());
  t.after(async()=>{await client.close();await bridge.stop();});
  await bridge.load();assert.equal(bridge.status().enabled,false);
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['list_connections','list_sessions','connect','run_command','start_task','read_task','stop_task','read_log','transfer_file','transfer_between_servers','read_transfer','stop_transfer']);
  assert.equal((await client.callTool({name:'list_connections',arguments:{}})).isError,true,'disabled bridge cannot be used');
  await bridge.setEnabled(true);
  const descriptor=JSON.parse(await fs.readFile(bridge.file,'utf8')),url=`http://127.0.0.1:${descriptor.port}/call`;
  const request=(body:unknown,headers:Record<string,string>={})=>fetch(url,{method:'POST',headers:{authorization:'Bearer '+descriptor.token,...headers},body:JSON.stringify(body)});
  assert.equal((await request({tool:'list_connections',arguments:{}},{authorization:'Bearer wrong'})).status,403);
  assert.equal((await request({tool:'list_connections',arguments:{}},{origin:'https://untrusted.invalid'})).status,403);
  const hostStatus=await new Promise(resolve=>{const call=httpRequest(url,{method:'POST',headers:{authorization:'Bearer '+descriptor.token,host:'other.invalid'}},response=>{response.resume();resolve(response.statusCode);});call.end(JSON.stringify({tool:'list_connections',arguments:{}}));});
  assert.equal(hostStatus,403);
  assert.equal((await request({tool:'__proto__',arguments:{}})).status,400);
  assert.equal((await request({tool:'connect',arguments:{connectionId:'fixture',password:'must-not-be-accepted'}})).status,400);
  assert.equal((await request({tool:'start_task',arguments:{sessionId:'fixture',command:'true',password:'must-not-be-accepted'}})).status,400);
  assert.equal((await request({tool:'read_task',arguments:{sessionId:'fixture',taskId:'bad; kill-server'}})).status,400);
  assert.equal(calls.length,0,'untrusted and invalid requests never reach connection logic');
  const listed=await client.callTool({name:'list_connections',arguments:{}});
  assert.equal(listed.isError,undefined);assert.match(JSON.stringify(listed),/Fixture/);
  assert.equal((await client.callTool({name:'connect',arguments:{connectionId:'fixture'}})).isError,undefined);
  assert.equal((await client.callTool({name:'run_command',arguments:{sessionId:'session',command:'x',timeoutMs:999999}})).isError,true);
  const pending=client.callTool({name:'run_command',arguments:{sessionId:'session',command:'pending'}});
  const end=Date.now()+5000;while(!calls.includes('run_command')){assert.ok(Date.now()<end);await new Promise(resolve=>setTimeout(resolve,10));}
  await fs.writeFile(bridge.file,JSON.stringify({...descriptor,port:1}));await bridge.refreshStatus();
  assert.equal(cancelled,false,'descriptor repair does not cancel an in-flight command');
  assert.equal(calls.filter(name=>name==='run_command').length,1,'repair never repeats the command');
  await bridge.setEnabled(false);assert.equal((await pending).isError,true);assert.equal(cancelled,true);
  assert.deepEqual(JSON.parse(await fs.readFile(bridge.file,'utf8')),{enabled:false});
  await bridge.setEnabled(true);assert.notEqual(JSON.parse(await fs.readFile(bridge.file,'utf8')).token,descriptor.token);
  assert.equal((await client.callTool({name:'list_connections',arguments:{}})).isError,undefined,'client follows refreshed connection metadata');
  assert.equal(stderr,'');
});

test('enabled MCP bridge repairs stale or missing descriptors without changing live access',async t=>{
  const base=path.resolve('test-output');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'mcp-repair-'));
  const bridge=new McpBridge(root,{command:process.execPath,args:[],env:{}},async()=>['live-session'],async()=>{});
  t.after(()=>bridge.stop());
  await bridge.setEnabled(true);
  const original=JSON.parse(await fs.readFile(bridge.file,'utf8'));
  await fs.writeFile(bridge.file,JSON.stringify({...original,port:1,token:'0'.repeat(64)}));
  await bridge.refreshStatus();
  assert.deepEqual(JSON.parse(await fs.readFile(bridge.file,'utf8')),original);
  await fs.unlink(bridge.file);await bridge.setEnabled(true);
  assert.deepEqual(JSON.parse(await fs.readFile(bridge.file,'utf8')),original,'enabling an existing bridge repairs a deleted descriptor');
  await fs.writeFile(bridge.file,'{broken');
  const deadline=Date.now()+8000;
  while(await fs.readFile(bridge.file,'utf8')==='{broken'){
    assert.ok(Date.now()<deadline,'background check must repair the descriptor without opening settings');
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.deepEqual(JSON.parse(await fs.readFile(bridge.file,'utf8')),original);
  const response=await fetch(`http://127.0.0.1:${original.port}/call`,{method:'POST',headers:{authorization:'Bearer '+original.token},body:JSON.stringify({tool:'list_sessions',arguments:{}})});
  assert.deepEqual(await response.json(),{value:['live-session']});
  await bridge.setEnabled(false);await bridge.refreshStatus();
  assert.deepEqual(JSON.parse(await fs.readFile(bridge.file,'utf8')),{enabled:false},'refresh must not turn a disabled bridge back on');
});

test('MCP client follows application restarts and explains unreachable bridge endpoints',async t=>{
  const base=path.resolve('test-output');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'mcp-restart-'));
  const bridge=new McpBridge(root,{command:process.execPath,args:[],env:{}},async()=>['before-restart'],async()=>{});
  const restarted=new McpBridge(root,{command:process.execPath,args:[],env:{}},async()=>['after-restart'],async()=>{});
  const client=new Client({name:'restart-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',path.resolve('src/main/mcp-stdio.ts'),bridge.file],stderr:'pipe'});
  t.after(async()=>{await client.close();await bridge.stop();await restarted.stop();});
  await bridge.setEnabled(true);const old=JSON.parse(await fs.readFile(bridge.file,'utf8'));
  await client.connect(transport);
  assert.match(JSON.stringify(await client.callTool({name:'list_sessions',arguments:{}})),/before-restart/);
  await bridge.stop();await restarted.load();
  const current=JSON.parse(await fs.readFile(bridge.file,'utf8'));assert.notEqual(current.token,old.token);
  assert.match(JSON.stringify(await client.callTool({name:'list_sessions',arguments:{}})),/after-restart/);
  const revoked=await fetch(`http://127.0.0.1:${current.port}/call`,{method:'POST',headers:{authorization:'Bearer '+old.token},body:'{}'});
  assert.equal(revoked.status,403,'restart revokes the previous token');
  await restarted.stop();
  const reservation=createServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=(reservation.address() as {port:number}).port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  await fs.writeFile(bridge.file,JSON.stringify({...current,port}));
  const failed=await client.callTool({name:'list_sessions',arguments:{}});
  assert.equal(failed.isError,true);assert.match(JSON.stringify(failed),/无法连接 GooeShell MCP 桥接/);
  assert.match(JSON.stringify(failed),new RegExp(String(port)));assert.ok(!JSON.stringify(failed).includes(current.token));
});
