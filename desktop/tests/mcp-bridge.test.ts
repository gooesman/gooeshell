import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {request as httpRequest} from 'node:http';
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
  assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['list_connections','list_sessions','connect','run_command']);
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
  assert.equal(calls.length,0,'untrusted and invalid requests never reach connection logic');
  const listed=await client.callTool({name:'list_connections',arguments:{}});
  assert.equal(listed.isError,undefined);assert.match(JSON.stringify(listed),/Fixture/);
  assert.equal((await client.callTool({name:'connect',arguments:{connectionId:'fixture'}})).isError,undefined);
  assert.equal((await client.callTool({name:'run_command',arguments:{sessionId:'session',command:'x',timeoutMs:999999}})).isError,true);
  const pending=client.callTool({name:'run_command',arguments:{sessionId:'session',command:'pending'}});
  const end=Date.now()+5000;while(!calls.includes('run_command')){assert.ok(Date.now()<end);await new Promise(resolve=>setTimeout(resolve,10));}
  await bridge.setEnabled(false);assert.equal((await pending).isError,true);assert.equal(cancelled,true);
  assert.deepEqual(JSON.parse(await fs.readFile(bridge.file,'utf8')),{enabled:false});
  await bridge.setEnabled(true);assert.notEqual(JSON.parse(await fs.readFile(bridge.file,'utf8')).token,descriptor.token);
  assert.equal((await client.callTool({name:'list_connections',arguments:{}})).isError,undefined,'client follows refreshed connection metadata');
  assert.equal(stderr,'');
});
