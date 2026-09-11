import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import TerminalView from '../../src/renderer/TerminalView';
import {defaultSettings} from '../../src/shared/defaults';
import '../../src/renderer/styles.css';

const profile={id:'stable-connection',name:'Isolated renderer',host:'127.0.0.1',port:22,username:'fixture',auth:'agent' as const,rememberHost:false,encoding:'utf8' as const};
function Fixture(){
  const [state,setState]=useState({id:'transport-old',disconnected:false,reconnecting:false});
  const [attempts,setAttempts]=useState(0);
  useEffect(()=>{(window as any).__fixtureSetConnection=setState;return()=>{delete (window as any).__fixtureSetConnection;};},[]);
  useEffect(()=>{(window as any).__fixtureConnection=state;(window as any).__fixtureReconnectAttempts=attempts;},[state,attempts]);
  return <TerminalView session={{id:state.id,tabId:'stable-terminal-tab',profile}} settings={defaultSettings} active={true}
    disconnected={state.disconnected} reconnecting={state.reconnecting} onReconnect={()=>setAttempts(value=>value+1)}/>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
