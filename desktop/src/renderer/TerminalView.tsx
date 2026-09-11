import {useEffect,useRef,useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {SearchAddon} from '@xterm/addon-search';
import {WebglAddon} from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import {api,isPreview} from './api';
import {terminalTheme,terminalBackground} from './terminal-theme';
import {terminalFontFamily,terminalFontLoads} from '../shared/fonts';
import {loadFontCatalog,acquireTerminalFont,type TerminalFontBundle} from './terminal-font-bundle';
import './terminal-fonts.css';
import './fonts.css';
import type {AppSettings,SessionInfo,SendCommandRequest} from '../shared/types';
export type TerminalCommandSender=(request:Omit<SendCommandRequest,'sessionId'|'bracketedPaste'>)=>Promise<void>;
// Leave alternate-screen/mouse/paste modes without clearing normal scrollback.
const disconnectedModes='\x1b[?2026l\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[!p\x1b[?25h\x1b[999999;1H';
export function keyChord(e:KeyboardEvent){
 const names:Record<string,string>={Equal:'=',Minus:'-',Comma:',',Period:'.',Space:'Space',BracketLeft:'[',BracketRight:']'};
 const key=names[e.code]||(e.code.startsWith('Key')?e.code.slice(3):e.code.startsWith('Digit')?e.code.slice(5):e.key.length===1?e.key.toUpperCase():e.key);
 return [e.ctrlKey?'Ctrl':'',e.altKey?'Alt':'',e.shiftKey?'Shift':'',e.metaKey?'Meta':'',key].filter(Boolean).join('+');
}
export function mouseChord(e:MouseEvent){
 const key=({1:'MouseMiddle',2:'MouseRight',3:'MouseBack',4:'MouseForward'} as Record<number,string>)[e.button];
 if(!key)return'';
 return[e.ctrlKey?'Ctrl':'',e.altKey?'Alt':'',e.shiftKey?'Shift':'',e.metaKey?'Meta':'',key].filter(Boolean).join('+');
}
function decode(value:string){const raw=atob(value);return Uint8Array.from(raw,c=>c.charCodeAt(0));}
export default function TerminalView({session,settings,active,onFontSizeChange,disconnected=false,reconnecting=false,reconnectError='',onReconnect,onCancelReconnect,onSudoPassword,onCommandSender}:{session:SessionInfo;settings:AppSettings;active:boolean;onFontSizeChange?:(size:number)=>void;disconnected?:boolean;reconnecting?:boolean;reconnectError?:string;onReconnect?:()=>void;onCancelReconnect?:()=>void;onSudoPassword?:()=>void;onCommandSender?:(sessionId:string,sender:TerminalCommandSender|null)=>void}){
 const host=useRef<HTMLDivElement>(null);const term=useRef<Terminal|null>(null);const requestFit=useRef<(()=>void)|null>(null);const search=useRef<SearchAddon|null>(null);const current=useRef(settings);const fontCallback=useRef(onFontSizeChange);
 const [searchOpen,setSearchOpen]=useState(false);const [query,setQuery]=useState('');const [background,setBackground]=useState('');const [fontWarning,setFontWarning]=useState('');const activeFont=useRef<TerminalFontBundle|null>(null);
 const [closedEvent,setClosedEvent]=useState<{id:string;message:string}|null>(null);
 const transport=useRef(session.id);const displayedTransport=useRef(session.id);const online=useRef(true);const callbacks=useRef({onReconnect,onCancelReconnect,onSudoPassword});
 const isDisconnected=disconnected||closedEvent?.id===session.id;
 transport.current=session.id;online.current=!isDisconnected&&!reconnecting;callbacks.current={onReconnect,onCancelReconnect,onSudoPassword};
 const tabId=session.tabId||session.id;
 const visible=useRef(active);visible.current=active;
 current.current=settings;fontCallback.current=onFontSizeChange;
 useEffect(()=>{
  const terminal=new Terminal({allowTransparency:true,convertEol:false,fontFamily:'monospace',fontSize:settings.fontSize,fontWeight:400,fontWeightBold:700,lineHeight:settings.lineHeight,cursorBlink:settings.cursorBlink,scrollback:10000,theme:terminalTheme(settings.theme,settings.terminalPalette),macOptionIsMeta:false});
  const element=host.current!;
  term.current=terminal;const fitter=new FitAddon();const finder=new SearchAddon();search.current=finder;terminal.loadAddon(fitter);terminal.loadAddon(finder);terminal.open(element);
  try{const gpu=new WebglAddon();gpu.onContextLoss(()=>gpu.dispose());terminal.loadAddon(gpu);}catch{/* xterm's standard renderer remains usable when GPU is unavailable. */}
  let disposed=false;let resizeFrame=0;let lastSize='';
  const resize=()=>{resizeFrame=0;if(disposed||element.clientWidth===0||element.clientHeight===0)return;fitter.fit();const size=`${transport.current}:${terminal.cols}x${terminal.rows}`;if(size!==lastSize){lastSize=size;api.terminalResize(transport.current,terminal.cols,terminal.rows);}};
  const scheduleResize=()=>{if(!disposed&&!resizeFrame)resizeFrame=requestAnimationFrame(resize);};
  requestFit.current=scheduleResize;
  const observer=new ResizeObserver(scheduleResize);observer.observe(element);scheduleResize();
  const input=terminal.onData(data=>{if(!isPreview&&online.current)api.terminalInput(transport.current,data);});
  const binaryInput=terminal.onBinary(data=>{if(!isPreview&&online.current)api.terminalBinaryInput(transport.current,data);});
  const remove=api.onEvent(event=>{
   if(event.type==='terminal'&&event.sessionId===transport.current)terminal.write(decode(event.data),()=>api.terminalAck(event.sessionId,event.bytes));
   if(event.type==='sessionClosed'&&event.sessionId===transport.current){online.current=false;setClosedEvent({id:event.sessionId,message:event.message});terminal.write(disconnectedModes+'\r\n\x1b[90m[连接已断开]\x1b[0m\r\n');}
  });
  const selection=terminal.onSelectionChange(()=>{if(current.current.copyOnSelect&&terminal.hasSelection())void api.writeClipboard(terminal.getSelection());});
  const perform=(chord:string)=>{
   const keys=current.current.shortcuts;
   if(chord&&chord===keys.reconnect&&!online.current&&callbacks.current.onReconnect){callbacks.current.onReconnect();return true;}
   if(chord&&chord===keys.sudoPassword&&online.current&&callbacks.current.onSudoPassword){callbacks.current.onSudoPassword();return true;}
   if(chord===keys.copy){if(terminal.hasSelection())void api.writeClipboard(terminal.getSelection());return true;}
   if(chord===keys.paste){void api.readClipboard().then(text=>terminal.paste(text));return true;}
   if(chord===keys.search){setSearchOpen(true);return true;}
   if(chord===keys.fontUp||chord===keys.fontDown){const size=Math.max(8,Math.min(40,(terminal.options.fontSize||14)+(chord===keys.fontUp?1:-1)));if(fontCallback.current)fontCallback.current(size);else terminal.options.fontSize=size;scheduleResize();return true;}
   return false;
  };
  terminal.attachCustomKeyEventHandler(event=>{
   if(event.type!=='keydown'||event.isComposing)return true;
   const chord=keyChord(event);if(event.repeat&&((chord===current.current.shortcuts.reconnect&&!online.current)||(chord===current.current.shortcuts.sudoPassword&&online.current)))return false;
   return !perform(chord);
  });
  const mouse=(event:MouseEvent)=>{const chord=mouseChord(event);if(chord&&perform(chord)){event.preventDefault();event.stopImmediatePropagation();terminal.focus();}};
  const context=(event:MouseEvent)=>{const chord=mouseChord(event);if(Object.values(current.current.shortcuts).includes(chord)){event.preventDefault();return;}if(current.current.rightClickPaste){event.preventDefault();void api.readClipboard().then(text=>terminal.paste(text));}};
  element.addEventListener('mousedown',mouse,true);element.addEventListener('contextmenu',context);terminal.focus();
  return()=>{disposed=true;cancelAnimationFrame(resizeFrame);remove();input.dispose();binaryInput.dispose();selection.dispose();observer.disconnect();element.removeEventListener('mousedown',mouse,true);element.removeEventListener('contextmenu',context);terminal.dispose();activeFont.current?.release();activeFont.current=null;term.current=null;search.current=null;requestFit.current=null;};
 },[tabId]);
 useEffect(()=>{
  if(displayedTransport.current===session.id)return;
  displayedTransport.current=session.id;
  term.current?.write(disconnectedModes+'\r\n\x1b[90m──────── 已重新连接 ────────\x1b[0m\r\n');
  requestFit.current?.();
  if(active)term.current?.focus();
 },[session.id,active]);
 useEffect(()=>{
  const terminal=term.current;if(!terminal)return;let cancelled=false;
  const refresh=()=>{terminal.options.fontSize=settings.fontSize;terminal.options.lineHeight=settings.lineHeight;terminal.clearTextureAtlas();terminal.refresh(0,terminal.rows-1);requestFit.current?.();};
  // First output must not wait for Windows to enumerate every installed font.
  // Start with available faces, then replace them when the composite family is ready.
  if(!activeFont.current)void Promise.all(terminalFontLoads(settings).map(font=>document.fonts.load(font,'M中文'))).catch(()=>undefined).then(()=>{
   if(cancelled||term.current!==terminal||activeFont.current)return;
   terminal.options.fontFamily=terminalFontFamily(settings);refresh();
  });
  // The composite family selects the two physical weights before xterm measures cells.
  void loadFontCatalog().then(catalog=>acquireTerminalFont(settings,catalog)).then(bundle=>{
   if(cancelled||term.current!==terminal){bundle.release();return;}
   const previous=activeFont.current;activeFont.current=bundle;
   terminal.options.fontFamily=bundle.family;terminal.options.fontWeight=400;terminal.options.fontWeightBold=700;
   setFontWarning(bundle.warnings.join(' '));refresh();previous?.release();
  }).catch(async error=>{
   if(cancelled||term.current!==terminal)return;
   if(!activeFont.current){await Promise.all(terminalFontLoads(settings).map(font=>document.fonts.load(font,'M中文'))).catch(()=>undefined);if(cancelled||term.current!==terminal)return;terminal.options.fontFamily=terminalFontFamily(settings);}
   setFontWarning(`${error.message} 暂时保留可用字体。`);refresh();
  });
  return()=>{cancelled=true;};
 },[tabId,settings.fontFamily,settings.chineseFont,settings.fontSize,settings.fontWeight,settings.chineseFontWeight,settings.lineHeight]);
 useEffect(()=>{if(term.current)term.current.options.cursorBlink=settings.cursorBlink;},[settings.cursorBlink]);
 useEffect(()=>{if(term.current)term.current.options.theme=terminalTheme(settings.theme,settings.terminalPalette);},[settings.theme,settings.terminalPalette]);
 useEffect(()=>{
  const target=session.id;
  onCommandSender?.(target,async request=>{
   if(!online.current||transport.current!==target||!term.current)throw new Error('目标终端已断开，请重新连接后再发送命令。');
   await api.sendCommand({...request,sessionId:target,bracketedPaste:term.current.modes.bracketedPasteMode});
   if(visible.current&&transport.current===target)term.current?.focus();
  });
  return()=>onCommandSender?.(target,null);
 },[session.id,onCommandSender]);
 useEffect(()=>{let cancelled=false;if(!settings.backgroundImage){setBackground('');return;}void api.backgroundData(settings.backgroundImage).then(data=>{if(!cancelled)setBackground(data);}).catch(()=>setBackground(''));return()=>{cancelled=true;};},[settings.backgroundImage]);
 useEffect(()=>{if(active){requestFit.current?.();const frame=requestAnimationFrame(()=>term.current?.focus());return()=>cancelAnimationFrame(frame);}},[active]);
 return <div className="terminal-instance" style={{position:'relative',height:'100%',minHeight:0,display:active?'block':'none',background:terminalBackground(settings.theme,settings.terminalPalette)}}>
  {background&&<div style={{position:'absolute',inset:0,backgroundImage:`url(${background})`,backgroundSize:'cover',backgroundPosition:'center',opacity:settings.backgroundOpacity,pointerEvents:'none'}}/>}
  <div ref={host} style={{position:'absolute',inset:isDisconnected||reconnecting?'10px 12px 64px':'10px 12px',minHeight:0}}/>
  {(isDisconnected||reconnecting)&&onReconnect&&<div className="terminal-reconnect" role="status"><div><strong>{reconnecting?'正在重新连接…':'连接已断开'}</strong><span>{reconnectError||closedEvent?.message||'原终端内容已保留'}</span></div>{reconnecting?<button className="button secondary small" onClick={onCancelReconnect}>取消重连</button>:<button className="button secondary small" onClick={onReconnect}>重新连接{settings.shortcuts.reconnect&&<kbd>{settings.shortcuts.reconnect.replaceAll('+',' + ')}</kbd>}</button>}</div>}
  {fontWarning&&<div className="terminal-font-warning" role="status">{fontWarning}</div>}
  {searchOpen&&<div className="terminal-search" style={{position:'absolute',right:20,top:12,display:'flex',gap:6,padding:8,background:'var(--surface-raised)',border:'1px solid var(--border)',borderRadius:10,zIndex:5}}><input autoFocus placeholder="搜索终端输出" value={query} onChange={e=>{setQuery(e.target.value);search.current?.findNext(e.target.value);}} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'){setSearchOpen(false);term.current?.focus();}if(e.key==='Enter')e.shiftKey?search.current?.findPrevious(query):search.current?.findNext(query);}}/><button onClick={()=>search.current?.findPrevious(query)}>↑</button><button onClick={()=>search.current?.findNext(query)}>↓</button><button onClick={()=>{setSearchOpen(false);term.current?.focus();}}>×</button></div>}
 </div>;
}
