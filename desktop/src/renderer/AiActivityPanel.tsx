import {useEffect,useState} from 'react';
import {api} from './api';
import type {AiActivity,AiView,BridgeTaskResult} from '../shared/mcp';
import './ai-activity.css';

type Watch = Extract<AiView,{kind:'task'|'log'}>;

export default function AiActivityPanel({visible,onOpen,onClose,onTransfer}:{visible:boolean;onOpen:()=>void;onClose:()=>void;onTransfer:()=>void}) {
  const [activities,setActivities]=useState<AiActivity[]>([]);
  const [watch,setWatch]=useState<Watch|null>(null);
  const [output,setOutput]=useState(''),[status,setStatus]=useState('');
  const [logPath,setLogPath]=useState('');
  useEffect(()=>api.onEvent(event=>{
    if(event.type==='aiActivity')setActivities(previous=>{const old=previous.find(item=>item.id===event.activity.id);const activity=event.activity.kind==='command'&&old?.output?{...event.activity,output:event.activity.state==='failed'?old.output+'\n'+(event.activity.output||''):old.output}:event.activity;return[activity,...previous.filter(item=>item.id!==event.activity.id)].slice(0,40);});
    if(event.type==='aiOutput')setActivities(previous=>previous.map(item=>item.id===event.id?{...item,output:((item.output||'')+event.text).slice(-65536)}:item));
    if(event.type==='aiShow'){
      if(event.view.kind==='transfer')onTransfer();
      else if(event.view.kind==='activity'){setWatch(null);onOpen();}
      else{setWatch(event.view);onOpen();}
    }
  }),[onOpen,onTransfer]);
  useEffect(()=>{
    if(!visible||!watch)return;
    let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined,offset=0,cursor:string|undefined;
    setOutput('');setStatus('正在读取…');setLogPath('');
    const poll=async()=>{
      try{
        const result=await api.readAiView({...watch,...(watch.kind==='log'?{offset,cursor}:{})});
        if(cancelled)return;
        if(watch.kind==='task'){
          const task=result as BridgeTaskResult;
          setOutput(task.output||'');setStatus((task.state==='exited'?`已结束 · 退出码 ${task.exitCode??'未知'}`:task.state==='unknown'?'状态未知，请检查服务器':task.state==='finishing'?'正在结束':'运行中')+(task.truncated?' · 仅显示最近输出':''));setLogPath(task.logPath||'');
          if(task.state==='exited'||task.state==='unknown')return;
        }else{
          const log=result as {output:string;nextOffset:number;cursor:string;reset:boolean};
          offset=log.nextOffset;cursor=log.cursor;
          setOutput(previous=>((log.reset?'':previous)+log.output).slice(-65536));setStatus(log.reset?'日志已轮转，继续跟踪':'跟踪中');
        }
        timer=setTimeout(poll,2000);
      }catch(error){if(!cancelled)setStatus(error instanceof Error?error.message:String(error));}
    };
    void poll();return()=>{cancelled=true;if(timer)clearTimeout(timer);};
  },[visible,watch]);
  return <aside className="ai-activity" hidden={!visible} aria-label="AI 活动">
    <div className="ai-activity-header"><strong>AI 活动</strong><span>当前程序运行期间</span><button type="button" onClick={onClose} aria-label="收起 AI 活动">×</button></div>
    {watch&&<section className="ai-watch"><div><strong>{watch.kind==='task'?'后台任务':'远程日志'}</strong><button type="button" onClick={()=>setWatch(null)}>关闭查看</button></div><span>{watch.kind==='task'?watch.taskId:watch.path} · {status}</span>{logPath&&<span>滚动日志：{logPath}</span>}<pre>{output||'等待输出…'}</pre></section>}
    <div className="ai-activity-list">{activities.length===0?<p>AI 执行的命令与后台任务会显示在这里。</p>:activities.map(item=><article key={item.id}>
      <div><strong>{item.connectionName}</strong><span>{item.state==='running'?'执行中':item.state==='failed'?'执行失败':item.kind==='task'&&item.exitCode==null?'任务已启动':item.exitCode==null?'状态未知':`退出码 ${item.exitCode}`}</span></div>
      <code>{item.sudo?'sudo · ':''}{item.command}</code>{item.cwd&&<small>目录：{item.cwd}</small>}
      {item.output&&<pre>{item.output}</pre>}
      {item.truncated&&<small>输出已截断；完整日志请查看远程日志文件。</small>}
      {item.taskId&&<button type="button" onClick={()=>setWatch({kind:'task',sessionId:item.sessionId,taskId:item.taskId!})}>查看任务输出</button>}
    </article>)}</div>
  </aside>;
}
