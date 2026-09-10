import {useEffect,useRef,useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {SearchAddon} from '@xterm/addon-search';
import {WebglAddon} from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import {api,isPreview} from './api';
import type {AppSettings,SessionInfo} from '../shared/types';
export function keyChord(e:KeyboardEvent){
 const names:Record<string,string>={Equal:'=',Minus:'-',Comma:',',Period:'.',Space:'Space'};
 const key=names[e.code]||(e.code.startsWith('Key')?e.code.slice(3):e.code.startsWith('Digit')?e.code.slice(5):e.key.length===1?e.key.toUpperCase():e.key);
 return [e.ctrlKey?'Ctrl':'',e.altKey?'Alt':'',e.shiftKey?'Shift':'',e.metaKey?'Meta':'',key].filter(Boolean).join('+');
}
export function mouseChord(e:MouseEvent){
 const key=({1:'MouseMiddle',2:'MouseRight',3:'MouseBack',4:'MouseForward'} as Record<number,string>)[e.button];
 if(!key)return'';
 return[e.ctrlKey?'Ctrl':'',e.altKey?'Alt':'',e.shiftKey?'Shift':'',e.metaKey?'Meta':'',key].filter(Boolean).join('+');
}
function decode(value:string){const raw=atob(value);return Uint8Array.from(raw,c=>c.charCodeAt(0));}
export default function TerminalView({session,settings,active,onFontSizeChange}:{session:SessionInfo;settings:AppSettings;active:boolean;onFontSizeChange?:(size:number)=>void}){
 const host=useRef<HTMLDivElement>(null);const term=useRef<Terminal|null>(null);const requestFit=useRef<(()=>void)|null>(null);const search=useRef<SearchAddon|null>(null);const current=useRef(settings);const fontCallback=useRef(onFontSizeChange);
 const [searchOpen,setSearchOpen]=useState(false);const [query,setQuery]=useState('');const [background,setBackground]=useState('');
 current.current=settings;fontCallback.current=onFontSizeChange;
 useEffect(()=>{
  const terminal=new Terminal({allowTransparency:true,convertEol:false,fontFamily:`"${settings.fontFamily}", "${settings.chineseFont}", monospace`,fontSize:settings.fontSize,lineHeight:settings.lineHeight,cursorBlink:settings.cursorBlink,scrollback:10000,theme:{background:'#00000000',foreground:'#dddddd',cursor:'#88dfbe',selectionBackground:'#31554480',black:'#202428',red:'#eb7f86',green:'#8dc9a0',yellow:'#e2c68e',blue:'#8eb7e5',magenta:'#c3a1de',cyan:'#7dc6c5',white:'#dddddd'},macOptionIsMeta:false});
  const element=host.current!;
  term.current=terminal;const fitter=new FitAddon();const finder=new SearchAddon();search.current=finder;terminal.loadAddon(fitter);terminal.loadAddon(finder);terminal.open(element);
  try{const gpu=new WebglAddon();gpu.onContextLoss(()=>gpu.dispose());terminal.loadAddon(gpu);}catch{/* xterm's standard renderer remains usable when GPU is unavailable. */}
  let disposed=false;let resizeFrame=0;let lastSize='';
  const resize=()=>{resizeFrame=0;if(disposed||element.clientWidth===0||element.clientHeight===0)return;fitter.fit();const size=`${terminal.cols}x${terminal.rows}`;if(size!==lastSize){lastSize=size;api.terminalResize(session.id,terminal.cols,terminal.rows);}};
  const scheduleResize=()=>{if(!disposed&&!resizeFrame)resizeFrame=requestAnimationFrame(resize);};
  requestFit.current=scheduleResize;
  const observer=new ResizeObserver(scheduleResize);observer.observe(element);scheduleResize();
  const input=terminal.onData(data=>{if(!isPreview)api.terminalInput(session.id,data);});
  const binaryInput=terminal.onBinary(data=>{if(!isPreview)api.terminalBinaryInput(session.id,data);});
  const remove=api.onEvent(event=>{
   if(event.type==='terminal'&&event.sessionId===session.id)terminal.write(decode(event.data),()=>api.terminalAck(session.id,event.bytes));
   if(event.type==='sessionClosed'&&event.sessionId===session.id)terminal.write('\r\n\x1b[90m[连接已关闭]\x1b[0m\r\n');
  });
  const selection=terminal.onSelectionChange(()=>{if(current.current.copyOnSelect&&terminal.hasSelection())void api.writeClipboard(terminal.getSelection());});
  const perform=(chord:string)=>{
   const keys=current.current.shortcuts;
   if(chord===keys.copy){if(terminal.hasSelection())void api.writeClipboard(terminal.getSelection());return true;}
   if(chord===keys.paste){void api.readClipboard().then(text=>terminal.paste(text));return true;}
   if(chord===keys.search){setSearchOpen(true);return true;}
   if(chord===keys.fontUp||chord===keys.fontDown){const size=Math.max(8,Math.min(40,(terminal.options.fontSize||14)+(chord===keys.fontUp?1:-1)));if(fontCallback.current)fontCallback.current(size);else terminal.options.fontSize=size;scheduleResize();return true;}
   return false;
  };
  terminal.attachCustomKeyEventHandler(event=>{
   if(event.type!=='keydown'||event.isComposing)return true;
   return !perform(keyChord(event));
  });
  const mouse=(event:MouseEvent)=>{const chord=mouseChord(event);if(chord&&perform(chord)){event.preventDefault();event.stopImmediatePropagation();terminal.focus();}};
  const context=(event:MouseEvent)=>{const chord=mouseChord(event);if(Object.values(current.current.shortcuts).includes(chord)){event.preventDefault();return;}if(current.current.rightClickPaste){event.preventDefault();void api.readClipboard().then(text=>terminal.paste(text));}};
  element.addEventListener('mousedown',mouse,true);element.addEventListener('contextmenu',context);terminal.focus();
  return()=>{disposed=true;cancelAnimationFrame(resizeFrame);remove();input.dispose();binaryInput.dispose();selection.dispose();observer.disconnect();element.removeEventListener('mousedown',mouse,true);element.removeEventListener('contextmenu',context);terminal.dispose();term.current=null;search.current=null;requestFit.current=null;};
 },[session.id]);
 useEffect(()=>{if(term.current){term.current.options.fontFamily=`"${settings.fontFamily}", "${settings.chineseFont}", monospace`;term.current.options.fontSize=settings.fontSize;term.current.options.lineHeight=settings.lineHeight;term.current.options.cursorBlink=settings.cursorBlink;requestFit.current?.();}},[settings.fontFamily,settings.chineseFont,settings.fontSize,settings.lineHeight,settings.cursorBlink]);
 useEffect(()=>{let cancelled=false;if(!settings.backgroundImage){setBackground('');return;}void api.backgroundData(settings.backgroundImage).then(data=>{if(!cancelled)setBackground(data);}).catch(()=>setBackground(''));return()=>{cancelled=true;};},[settings.backgroundImage]);
 useEffect(()=>{if(active){requestFit.current?.();const frame=requestAnimationFrame(()=>term.current?.focus());return()=>cancelAnimationFrame(frame);}},[active]);
 return <div className="terminal-instance" style={{position:'relative',height:'100%',minHeight:0,display:active?'block':'none',background:'#000'}}>
  {background&&<div style={{position:'absolute',inset:0,backgroundImage:`url(${background})`,backgroundSize:'cover',backgroundPosition:'center',opacity:settings.backgroundOpacity,pointerEvents:'none'}}/>}
  <div ref={host} style={{position:'absolute',inset:'10px 12px',minHeight:0}}/>
  {searchOpen&&<div className="terminal-search" style={{position:'absolute',right:20,top:12,display:'flex',gap:6,padding:8,background:'#20252b',border:'1px solid #39414b',borderRadius:6,zIndex:5}}><input autoFocus placeholder="搜索终端输出" value={query} onChange={e=>{setQuery(e.target.value);search.current?.findNext(e.target.value);}} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'){setSearchOpen(false);term.current?.focus();}if(e.key==='Enter')e.shiftKey?search.current?.findPrevious(query):search.current?.findNext(query);}}/><button onClick={()=>search.current?.findPrevious(query)}>↑</button><button onClick={()=>search.current?.findNext(query)}>↓</button><button onClick={()=>{setSearchOpen(false);term.current?.focus();}}>×</button></div>}
 </div>;
}
