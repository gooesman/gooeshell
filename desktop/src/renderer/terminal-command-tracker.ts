import type {Terminal, IMarker, IDisposable} from '@xterm/xterm';
import {registerCommandPositionMarker} from './command-position-marker';
import {readCommandEcho} from './terminal-command-echo';

export type CommandStatus = 'running' | 'success' | 'error' | 'unknown';
export interface CommandRecord {
  id: number; marker: IMarker; command?: string; commandSource?:'shell'|'echo'; status: CommandStatus; exitCode?: number;
  output: IMarker; outputColumn: number; end?: IMarker; endColumn?: number;
  geometry: number; reflowSafe: boolean;
}
type Signal = {kind:'A'|'B'|'C'} | {kind:'D';exitCode?:number} | {kind:'E';command:string};

/** Only metadata is accepted here. Command text is never sent to the shell. */
export function parseCommandSignal(data: string): Signal | undefined {
  if(data.length>32768)return;
  if(data==='A'||data==='B'||data==='C')return{kind:data};
  if(data==='D')return{kind:'D'};
  if(data.startsWith('D;')){
    const value=data.slice(2);
    if(!/^-?\d{1,10}$/.test(value))return;
    const exitCode=Number(value);
    if(Number.isSafeInteger(exitCode)&&exitCode>=-2147483648&&exitCode<=2147483647)return{kind:'D',exitCode};
    return;
  }
  if(!data.startsWith('E;'))return;
  const encoded=data.split(';')[1];
  if(encoded.length>24576)return;
  let command='';
  for(let index=0;index<encoded.length;index++){
    const char=encoded[index];
    if(char!=='\\'){command+=char;continue;}
    if(encoded[index+1]==='\\'){command+='\\';index++;continue;}
    if(encoded[index+1]==='x'&&/^[a-f\d]{2}$/i.test(encoded.slice(index+2,index+4))){
      command+=String.fromCharCode(parseInt(encoded.slice(index+2,index+4),16));index+=3;continue;
    }
    return;
  }
  if(command.length>8192||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command))return;
  return{kind:'E',command};
}

/** Markers belong to the xterm instance, including while its tab is hidden. */
export class TerminalCommandTracker {
  private entries:CommandRecord[]=[];
  private disposables:IDisposable[]=[];
  private listeners=new Set<()=>void>();
  private prompt?:{marker:IMarker;input:boolean;command?:string;commandProvided?:boolean;
    echo?:{marker:IMarker;column:number;columns:number;geometry:number;prefix:string}};
  private running?:CommandRecord;
  private serial=0;
  private geometry=0;
  private columns:number;
  private disposed=false;
  private navigation?:number;
  private navigating=false;
  private boundary=`gooeshell-session-boundary:${crypto.randomUUID()}`;
  constructor(private terminal:Terminal,private limit=1000){
    this.columns=terminal.cols;
    for(const ident of [133,633])this.disposables.push(terminal.parser.registerOscHandler(ident,data=>{
      const signal=parseCommandSignal(data);
      if(signal&&(ident===633||signal.kind!=='E'))this.accept(signal);
      // Metadata must not print even when an application sends it in the alt buffer.
      return true;
    }));
    this.disposables.push(terminal.parser.registerOscHandler(777,data=>{
      if(data!==this.boundary)return false;
      this.resetSession();return true;
    }));
    this.disposables.push(terminal.onResize(({cols})=>{
      if(cols!==this.columns){this.geometry++;this.columns=cols;}
      this.changed();
    }),terminal.buffer.onBufferChange(()=>this.changed()),terminal.onScroll(()=>{
      if(!this.navigating)this.navigation=undefined;
    }));
  }
  get records():readonly CommandRecord[]{return this.entries;}
  get normal(){return this.terminal.buffer.active.type==='normal';}
  onChange(listener:()=>void){this.listeners.add(listener);return{dispose:()=>this.listeners.delete(listener)};}
  private changed(){if(!this.disposed)for(const listener of this.listeners)listener();}
  private cursor(){const buffer=this.terminal.buffer.active;return{line:buffer.baseY+buffer.cursorY,column:buffer.cursorX};}
  private dropPrompt(){this.prompt?.echo?.marker.dispose();this.prompt?.marker.dispose();this.prompt=undefined;}
  private remove(record:CommandRecord){
    const index=this.entries.indexOf(record);if(index<0)return;
    this.entries.splice(index,1);
    if(this.running===record)this.running=undefined;
    record.marker.dispose();record.output.dispose();record.end?.dispose();this.changed();
  }
  private accept(signal:Signal){
    if(this.disposed||!this.normal)return;
    if(signal.kind==='A'){
      if(this.running)this.finish();
      this.dropPrompt();
      const marker=registerCommandPositionMarker(this.terminal);if(marker)this.prompt={marker,input:false};
      return;
    }
    if(signal.kind==='B'){
      if(this.prompt){
        this.prompt.input=true;this.prompt.echo?.marker.dispose();
        const marker=this.terminal.registerMarker(0),position=this.cursor();
        const prefix=this.terminal.buffer.normal.getLine(position.line)?.translateToString(false,0,position.column);
        this.prompt.echo=marker&&prefix!==undefined?{marker,column:position.column,columns:this.terminal.cols,geometry:this.geometry,prefix}:undefined;
        if(marker&&!this.prompt.echo)marker.dispose();
      }
      return;
    }
    if(signal.kind==='E'){
      if(this.prompt&&!this.running){this.prompt.command=signal.command;this.prompt.commandProvided=true;}
      return;
    }
    if(signal.kind==='C'){
      if(this.running||!this.prompt?.input||this.prompt.marker.isDisposed)return;
      const output=this.terminal.registerMarker(0);if(!output)return;
      const position=this.cursor();
      const command=this.prompt.commandProvided?this.prompt.command:
        this.prompt.echo?.geometry===this.geometry?readCommandEcho(this.terminal,this.prompt.echo,position):undefined;
      const record:CommandRecord={id:++this.serial,marker:this.prompt.marker,command,
        ...(command?{commandSource:this.prompt.commandProvided?'shell' as const:'echo' as const}:{}),status:'running',output,
        outputColumn:position.column,geometry:this.geometry,reflowSafe:position.column===0&&!this.terminal.buffer.normal.getLine(position.line)?.isWrapped};
      this.prompt.echo?.marker.dispose();
      this.prompt=undefined;this.running=record;this.entries.push(record);
      record.marker.onDispose(()=>this.remove(record));
      while(this.entries.length>this.limit)this.remove(this.entries[0]);
      this.navigation=undefined;this.changed();return;
    }
    if(signal.kind==='D')this.finish(signal.exitCode);
  }
  private finish(exitCode?:number){
    const record=this.running;if(!record)return;
    const position=this.cursor();record.end=this.terminal.registerMarker(0);record.endColumn=position.column;
    record.reflowSafe=record.reflowSafe&&position.column===0&&!this.terminal.buffer.normal.getLine(position.line)?.isWrapped;
    record.status=exitCode===undefined?'unknown':exitCode===0?'success':'error';record.exitCode=exitCode;
    this.running=undefined;this.changed();
  }
  /** Transport boundaries keep old scrollback but never pair a new D with an old C. */
  resetSession(){
    if(this.running){this.running.status='unknown';this.running=undefined;}
    this.dropPrompt();this.navigation=undefined;this.changed();
  }
  /** The boundary is parsed after preceding SSH output, independently of ACK callbacks. */
  queueSessionReset(){this.terminal.write(`\x1b]777;${this.boundary}\x07`);}
  jump(record:CommandRecord){
    if(!this.normal||record.marker.isDisposed||!this.entries.includes(record))return false;
    this.navigating=true;
    try{this.terminal.scrollToLine(record.marker.line);}finally{this.navigating=false;}
    this.navigation=record.id;this.terminal.focus();return true;
  }
  navigate(direction:-1|1){
    if(!this.normal||!this.entries.length)return false;
    const index=this.entries.findIndex(record=>record.id===this.navigation);
    let record:CommandRecord|undefined;
    if(index>=0)record=this.entries[index+direction];
    else{
      const buffer=this.terminal.buffer.normal;
      const boundary=direction<0&&buffer.viewportY===buffer.baseY?buffer.length:buffer.viewportY;
      record=direction<0?[...this.entries].reverse().find(item=>item.marker.line<boundary):this.entries.find(item=>item.marker.line>boundary);
    }
    if(record)this.jump(record);
    else if(direction>0){this.navigation=undefined;this.terminal.scrollToBottom();}
    return true;
  }
  outputText(record:CommandRecord){
    if(record.status==='running'||!record.end||record.marker.isDisposed||record.output.isDisposed||record.end.isDisposed)throw new Error('这条命令的完整输出已不可用');
    if(!record.reflowSafe&&record.geometry!==this.geometry)throw new Error('窗口宽度已变化，无法准确提取这段未换行的输出');
    const buffer=this.terminal.buffer.normal,start=record.output.line,end=record.end.line;
    if(end<start)throw new Error('这条命令的完整输出已不可用');
    let result='';
    for(let line=start;line<=end;line++){
      const textLine=buffer.getLine(line);if(!textLine)throw new Error('这条命令的完整输出已不可用');
      if(line>start&&!textLine.isWrapped)result+='\n';
      result+=textLine.translateToString(true,line===start?record.outputColumn:0,line===end?record.endColumn:undefined);
      if(result.length>2*1024*1024)throw new Error('输出过长，请缩小选择范围后复制');
    }
    return result;
  }
  dispose(){
    this.disposed=true;this.listeners.clear();for(const disposable of this.disposables)disposable.dispose();
    this.dropPrompt();for(const record of [...this.entries])this.remove(record);
  }
}
