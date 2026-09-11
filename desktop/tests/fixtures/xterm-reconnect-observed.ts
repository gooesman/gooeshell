import {Terminal as RealTerminal} from '../../node_modules/@xterm/xterm/lib/xterm.mjs';

// Real xterm parser and renderer. Only callback delivery can be delayed to model
// a write acknowledgement completing after the SSH transport has been replaced.
export class Terminal extends RealTerminal{
  constructor(options:any){
    super(options);const fixture=window as any;
    fixture.__fixtureTerminal=this;fixture.__fixtureTerminalCount=(fixture.__fixtureTerminalCount||0)+1;
    fixture.__fixtureDeferredWriteCallbacks=[];
    fixture.__fixtureKeyDecisions=[];
    this.onRender(()=>{
      fixture.__fixtureRenderCount=(fixture.__fixtureRenderCount||0)+1;
      const buffer=this.buffer.active;const lines=[];
      for(let index=buffer.viewportY;index<Math.min(buffer.length,buffer.viewportY+this.rows);index++)lines.push(buffer.getLine(index)?.translateToString(true)||'');
      fixture.__fixtureRenderedText=lines.join('\n');
    });
  }
  attachCustomKeyEventHandler(handler:(event:KeyboardEvent)=>boolean){
    super.attachCustomKeyEventHandler((event:KeyboardEvent)=>{
      const result=handler(event);
      (window as any).__fixtureKeyDecisions.push({type:event.type,key:event.key,code:event.code,ctrl:event.ctrlKey,shift:event.shiftKey,result});
      return result;
    });
  }
  write(data:string|Uint8Array,callback?:()=>void){
    super.write(data,callback?()=>{
      const fixture=window as any;
      if(fixture.__fixtureHoldWriteCallbacks)fixture.__fixtureDeferredWriteCallbacks.push(callback);else callback();
    }:undefined);
  }
}
