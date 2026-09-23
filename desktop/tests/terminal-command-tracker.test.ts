import test from 'node:test';
import assert from 'node:assert/strict';
import {Terminal} from '@xterm/xterm';
import {parseCommandSignal,TerminalCommandTracker} from '../src/renderer/terminal-command-tracker';

function fixture(limit=1000){
  let type='normal',row=0,column=0,scroll:()=>void=()=>{};
  const resizeHandlers=new Set<(size:{cols:number;rows:number})=>void>();
  const handlers=new Map<number,(data:string)=>boolean|Promise<boolean>>(),markers:ReturnType<typeof marker>[]=[];
  function marker(){let disposed=false;const callbacks=new Set<()=>void>();const value={line:row,id:markers.length,get isDisposed(){return disposed;},dispose(){if(disposed)return;disposed=true;value.line=-1;for(const callback of callbacks)callback();},onDispose(callback:()=>void){callbacks.add(callback);return{dispose:()=>callbacks.delete(callback)};}};markers.push(value);return value;}
  const lines=new Map<number,string>();
  const cell={getWidth:()=>1,getChars:()=>''};
  const normal={baseY:0,viewportY:0,length:100,getNullCell:()=>cell,get cursorY(){return row;},get cursorX(){return column;},get type(){return type;},getLine(index:number){return{length:80,getCell:()=>cell,isWrapped:false,translateToString(_trim:boolean,start=0,end?:number){return(lines.get(index)||'').slice(start,end);}};}};
  const terminal={cols:80,rows:24,options:{},buffer:{normal,active:normal,onBufferChange:()=>({dispose(){}})},
    parser:{registerOscHandler(id:number,handler:(data:string)=>boolean|Promise<boolean>){handlers.set(id,handler);return{dispose:()=>handlers.delete(id)};}},registerMarker:marker,
    onResize(handler:(size:{cols:number;rows:number})=>void){resizeHandlers.add(handler);return{dispose:()=>resizeHandlers.delete(handler)};},onScroll(handler:()=>void){scroll=handler;return{dispose(){}};},
    scrollToLine(line:number){normal.viewportY=Math.min(line,76);scroll();},scrollToBottom(){normal.viewportY=76;scroll();},focus(){},
  };
  const tracker=new TerminalCommandTracker(terminal as unknown as Terminal,limit);
  const send=(data:string,id=133)=>handlers.get(id)?.(data);
  const at=(line:number,col=0)=>{row=line;column=col;};
  const start=(line:number,command='echo fixture')=>{at(line);send('A');send('B');send(`E;${command}`,633);at(line+1);send('C');};
  return{tracker,send,at,start,markers,lines,normal,mode(value:string){type=value;},resize(cols:number){terminal.cols=cols;for(const handler of resizeHandlers)handler({cols,rows:24});}};
}

test('command metadata preserves escaped multiline text and rejects malformed/control payloads',()=>{
  assert.deepEqual(parseCommandSignal('E;echo 中文\\x3b printf "a\\x0ab";nonce'),{kind:'E',command:'echo 中文; printf "a\nb"'});
  assert.deepEqual(parseCommandSignal('E;printf \\x09\\\\path'),{kind:'E',command:'printf \t\\path'});
  for(const text of ['D;no','D;','D;0;1','D;2147483648','E;bad\\q','E;bad\\x1b','E;bad\\x00','E;'+ 'a'.repeat(9000)])assert.equal(parseCommandSignal(text),undefined,text.slice(0,30));
  assert.deepEqual(parseCommandSignal('D;130'),{kind:'D',exitCode:130});
});
test('only actual command boundaries create records; duplicate and empty prompt sequences do not',()=>{
  const f=fixture();f.send('D;0');f.send('C');assert.equal(f.tracker.records.length,0);
  f.at(0);f.send('A');f.send('B');f.send('D');f.send('A');f.send('B');assert.equal(f.tracker.records.length,0);
  f.send('E;false',633);f.at(1);f.send('C');f.send('C');f.send('D;1');f.send('D;0');
  assert.equal(f.tracker.records.length,1);assert.equal(f.tracker.records[0].status,'error');assert.equal(f.tracker.records[0].exitCode,1);f.tracker.dispose();
});
test('disconnect preserves finished marks and prevents a new connection from finishing an old command',()=>{
  const f=fixture();f.start(0);f.send('D;0');f.start(4,'sleep 10');f.tracker.resetSession();f.send('D;0');
  assert.deepEqual(f.tracker.records.map(r=>r.status),['success','unknown']);
  f.start(8,'false');f.send('D;1');assert.deepEqual(f.tracker.records.map(r=>r.status),['success','unknown','error']);f.tracker.dispose();
});
test('alternate-screen metadata cannot create pane marks or steal navigation',()=>{
  const f=fixture();f.start(0,'tmux');f.mode('alternate');f.send('A');f.send('B');f.send('C');f.send('D;1');
  assert.equal(f.tracker.navigate(-1),false);assert.equal(f.tracker.records.length,1);assert.equal(f.tracker.records[0].status,'running');
  f.mode('normal');f.at(2);f.send('D;0');assert.equal(f.tracker.records[0].status,'success');f.tracker.dispose();
});
test('markers have a bounded lifetime and scrollback disposal releases associated metadata',()=>{
  const f=fixture(2);for(let i=0;i<3;i++){f.start(i*3);f.send('D;0');}
  assert.equal(f.tracker.records.length,2);assert.equal(f.markers[0].isDisposed,true);
  const first=f.tracker.records[0];first.marker.dispose();assert.equal(first.output.isDisposed,true);assert.equal(first.end?.isDisposed,true);assert.equal(f.tracker.records.length,1);
  f.tracker.dispose();assert.equal(f.tracker.records.length,0);
});
test('copy output excludes the next prompt and rejects ambiguous partial-line output after reflow',()=>{
  const f=fixture();f.start(0);f.lines.set(1,'中文 output');f.at(2);f.send('D;0');f.lines.set(2,'user@host $ next command');
  assert.equal(f.tracker.outputText(f.tracker.records[0]),'中文 output\n');f.resize(60);assert.equal(f.tracker.outputText(f.tracker.records[0]),'中文 output\n');
  f.start(4,'printf abc');f.lines.set(5,'abcuser@host $ ');f.at(5,3);f.send('D;0');const record=f.tracker.records[1];assert.equal(f.tracker.outputText(record),'abc');f.resize(40);assert.throws(()=>f.tracker.outputText(record),/宽度/);f.tracker.dispose();
});

test('shell metadata and explicit omission take priority over visible command echo',async t=>{
  const terminal=new Terminal({cols:80,rows:12}),tracker=new TerminalCommandTracker(terminal);
  t.after(()=>{tracker.dispose();terminal.dispose();});
  const write=(data:string)=>new Promise<void>(resolve=>terminal.write(data,resolve));
  const prompt='\x1b]133;A\x07$ \x1b]133;B\x07';
  const complete='\r\n\x1b]133;C\x07\x1b]133;D;0\x07';
  await write(prompt+'echo visible'+complete);
  await write(prompt+'echo visible\x1b]633;E;echo authoritative\x07'+complete);
  await write(prompt+'echo omitted\x1b]633;E;\x07'+complete);
  assert.deepEqual(tracker.records.map(({command,commandSource})=>({command,commandSource})),[
    {command:'echo visible',commandSource:'echo'},
    {command:'echo authoritative',commandSource:'shell'},
    {command:'',commandSource:undefined},
  ]);
});

test('echo capture rejects resized input and never pairs an old prompt with a replacement session',async t=>{
  const terminal=new Terminal({cols:80,rows:12}),tracker=new TerminalCommandTracker(terminal);
  t.after(()=>{tracker.dispose();terminal.dispose();});
  const write=(data:string)=>new Promise<void>(resolve=>terminal.write(data,resolve));
  const prompt='\x1b]133;A\x07$ \x1b]133;B\x07';
  await write(prompt+'echo resized');terminal.resize(60,12);terminal.resize(80,12);
  await write('\r\n\x1b]133;C\x07\x1b]133;D;0\x07');
  assert.equal(tracker.records[0].command,undefined);
  await write(prompt+'echo stale');tracker.queueSessionReset();
  await write('\r\n\x1b]133;C\x07\x1b]133;D;0\x07');
  assert.equal(tracker.records.length,1);
  await write(prompt+'echo replacement\r\n\x1b]133;C\x07\x1b]133;D;0\x07');
  assert.equal(tracker.records[1].command,'echo replacement');
  assert.equal(tracker.records[1].commandSource,'echo');
});
