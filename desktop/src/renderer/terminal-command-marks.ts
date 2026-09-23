import type {Terminal, IDisposable} from '@xterm/xterm';
import type {AppSettings} from '../shared/types';
import {TerminalCommandTracker, type CommandRecord} from './terminal-command-tracker';

const labels={running:'执行中',success:'成功',error:'非零退出',unknown:'状态未知'};
const description=(record:CommandRecord)=>`${labels[record.status]}${record.exitCode===undefined?'':` · 退出码 ${record.exitCode}`}${record.commandSource==='echo'?' · 终端回显':''}\n${record.command||'命令文本未提供'}`;

/** A small DOM overlay in the existing margins, never a second terminal renderer. */
export class TerminalCommandMarks {
  readonly tracker:TerminalCommandTracker;
  private rail:HTMLDivElement;
  private menu?:HTMLDivElement;
  private frame=0;
  private visible=true;
  private position:AppSettings['commandMarks']='right';
  private disposed=false;
  private disposables:IDisposable[]=[];
  private buttons=new Map<string,HTMLButtonElement>();
  private keys='';
  private observer:ResizeObserver;
  constructor(private terminal:Terminal,private root:HTMLElement,private clipboard:(text:string)=>Promise<void>){
    this.tracker=new TerminalCommandTracker(terminal);
    this.rail=document.createElement('div');this.rail.className='command-marks-rail';
    this.rail.setAttribute('role','group');this.rail.setAttribute('aria-label','命令状态与导航');root.append(this.rail);
    this.disposables.push(this.tracker.onChange(()=>this.schedule()),terminal.onRender(()=>this.schedule()),terminal.onScroll(()=>this.schedule()));
    this.observer=new ResizeObserver(()=>this.schedule());this.observer.observe(root);
    document.addEventListener('pointerdown',this.dismiss,true);document.addEventListener('keydown',this.keyboard,true);
    this.schedule();
  }
  private dismiss=(event:PointerEvent)=>{if(this.menu&&!this.menu.contains(event.target as Node))this.closeMenu();};
  private keyboard=(event:KeyboardEvent)=>{
    if(!this.menu)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.closeMenu();this.terminal.focus();}
    if(event.key==='Tab'){
      const controls=[...this.menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const at=controls.indexOf(document.activeElement as HTMLButtonElement),next=controls[(at+(event.shiftKey?-1:1)+controls.length)%controls.length];
      if(next){event.preventDefault();event.stopPropagation();next.focus();}
    }
  };
  private closeMenu(){this.menu?.remove();this.menu=undefined;}
  update(position:AppSettings['commandMarks'],visible:boolean){
    if(this.position!==position||this.visible!==visible)this.closeMenu();
    this.position=position;this.visible=visible;this.schedule();
  }
  private schedule(){
    if(this.disposed||this.frame)return;
    if(!this.visible){this.rail.hidden=true;return;}
    this.frame=requestAnimationFrame(()=>{this.frame=0;if(!this.disposed)this.render();});
  }
  private render(){
    this.rail.dataset.commandMarksPosition=this.position;
    this.rail.hidden=!this.visible||this.position==='hidden'||!this.tracker.normal;
    if(this.rail.hidden){this.closeMenu();if(this.buttons.size)this.rail.replaceChildren();this.buttons.clear();this.keys='';return;}
    // Ordinary connections with no integration should not measure layout on output.
    if(!this.tracker.records.length){if(this.buttons.size)this.rail.replaceChildren();this.buttons.clear();this.keys='';return;}
    const screen=this.terminal.element?.querySelector('.xterm-screen');if(!screen)return;
    const rect=screen.getBoundingClientRect(),root=this.root.getBoundingClientRect();
    if(rect.height<=0)return;
    const buffer=this.terminal.buffer.normal,rowHeight=rect.height/this.terminal.rows;
    const buckets=new Map<number,{record:CommandRecord;count:number}>();
    for(const record of this.tracker.records){
      if(record.marker.isDisposed)continue;
      const line=record.marker.line;
      if(this.position==='left'&&(line<buffer.viewportY||line>=buffer.viewportY+this.terminal.rows))continue;
      const pixel=this.position==='left'?(line-buffer.viewportY+.5)*rowHeight:Math.max(3,Math.min(rect.height-3,line/Math.max(1,buffer.length-1)*(rect.height-6)+3));
      const bucket=this.position==='left'?Math.round(pixel):Math.floor(pixel/6)*6+3;
      const previous=buckets.get(bucket);
      // Failures remain discoverable even when a long history shares a pixel bucket.
      const preferred=!previous||record.status==='error'||previous.record.status!=='error'?record:previous.record;
      buckets.set(bucket,{record:preferred,count:(previous?.count||0)+1});
    }
    const nodes:HTMLButtonElement[]=[],nextButtons=new Map<string,HTMLButtonElement>();
    for(const [pixel,{record,count}] of buckets){
      const key=`${this.position}:${record.id}`;
      const button=this.buttons.get(key)||document.createElement('button');
      button.type='button';button.className='command-status-mark';button.dataset.commandMark=String(record.id);
      button.dataset.commandLine=String(record.marker.line);button.dataset.command=(record.command||'').slice(0,512);button.dataset.status=record.status;
      button.style.top=`${rect.top-root.top+pixel}px`;
      button.title=description(record)+(count>1?`\n附近还有 ${count-1} 条命令，可用上下命令快捷键逐条定位`:'');
      button.setAttribute('aria-label',`${labels[record.status]}：${record.command?.slice(0,120)||'命令'}，定位命令开始`);
      button.onclick=event=>{event.preventDefault();event.stopPropagation();this.tracker.jump(record);};
      button.oncontextmenu=event=>{event.preventDefault();event.stopPropagation();this.openMenu(record,event.clientX,event.clientY);};
      nodes.push(button);nextButtons.set(key,button);
    }
    const keys=[...nextButtons.keys()].join(',');
    if(keys!==this.keys){this.rail.replaceChildren(...nodes);this.keys=keys;}
    this.buttons=nextButtons;
  }
  private openMenu(record:CommandRecord,x:number,y:number){
    this.closeMenu();const menu=document.createElement('div');this.menu=menu;
    menu.className='command-mark-menu';menu.setAttribute('role','menu');
    const heading=document.createElement('div');heading.className='command-mark-description';heading.textContent=description(record);menu.append(heading);
    const error=document.createElement('div');error.className='command-mark-error';error.setAttribute('role','alert');error.hidden=true;
    const action=(label:string,read:()=>string,disabled=false)=>{
      const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.textContent=label;button.disabled=disabled;
      button.onclick=()=>{void Promise.resolve().then(read).then(text=>this.clipboard(text)).then(()=>{this.closeMenu();this.terminal.focus();}).catch(reason=>{error.textContent=reason instanceof Error?reason.message:'复制失败，请重试';error.hidden=false;});};menu.append(button);
    };
    action('复制命令',()=>{if(record.marker.isDisposed||!record.command)throw new Error('命令文本已不可用');return record.command;},!record.command);
    action('复制输出',()=>this.tracker.outputText(record),record.status==='running'||!record.end);
    menu.append(error);this.root.append(menu);
    const root=this.root.getBoundingClientRect();menu.style.left=`${Math.max(4,Math.min(x-root.left,root.width-menu.offsetWidth-4))}px`;
    menu.style.top=`${Math.max(4,Math.min(y-root.top,root.height-menu.offsetHeight-4))}px`;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }
  resetSession(){this.closeMenu();this.tracker.queueSessionReset();}
  navigate(direction:-1|1){return this.tracker.navigate(direction);}
  dispose(){
    this.disposed=true;cancelAnimationFrame(this.frame);this.observer.disconnect();
    document.removeEventListener('pointerdown',this.dismiss,true);document.removeEventListener('keydown',this.keyboard,true);
    for(const disposable of this.disposables)disposable.dispose();this.tracker.dispose();this.closeMenu();this.rail.remove();
  }
}
