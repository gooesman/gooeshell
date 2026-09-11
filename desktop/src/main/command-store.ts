import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {CommandGroup,CommandLibrary,SavedCommand,SendCommandRequest} from '../shared/types';

const fileName='command-library.json';
const maxGroups=1000;
const maxCommands=10000;
const maxFileBytes=32*1024*1024;
export const maxCommandBytes=64*1024;
const controls=/[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

function identifier(value:unknown,label:string):string{
  if(typeof value!=='string'||!value.trim()||value.length>255||/[\x00-\x20\x7f-\x9f]/.test(value))throw new Error(`${label}标识无效`);
  return value;
}
function label(value:unknown,name:string,max:number):string{
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f\x7f-\x9f]/.test(value))throw new Error(`${name}无效`);
  return value.trim();
}
function order(value:unknown):number{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new Error('命令排序无效');
  return value;
}
export function cleanCommandText(value:unknown):string{
  if(typeof value!=='string')throw new Error('命令内容无效');
  const normalized=value.replace(/\r\n/g,'\n');
  if(!normalized.trim())throw new Error('请输入命令内容');
  if(Buffer.byteLength(normalized,'utf8')>maxCommandBytes)throw new Error('单条命令最多支持 64 KiB 文本');
  if(controls.test(normalized))throw new Error('命令不能包含终端控制字符，请使用普通文本、换行或制表符');
  return normalized;
}
export function cleanCommandGroup(value:CommandGroup):CommandGroup{
  if(!value||typeof value!=='object')throw new Error('命令分组无效');
  const connectionId=value.connectionId===undefined||value.connectionId===''?undefined:identifier(value.connectionId,'连接');
  const connectionName=connectionId&&value.connectionName!==undefined&&value.connectionName!==''?label(value.connectionName,'连接名称',255):undefined;
  return{id:identifier(value.id,'分组'),name:label(value.name,'分组名称',100),order:order(value.order),...(connectionId?{connectionId}:{}),...(connectionName?{connectionName}:{})};
}
export function cleanSavedCommand(value:SavedCommand):SavedCommand{
  if(!value||typeof value!=='object')throw new Error('命令无效');
  if(value.mode!=='insert'&&value.mode!=='execute')throw new Error('命令发送方式无效');
  if(typeof value.confirmBeforeRun!=='boolean')throw new Error('命令确认选项无效');
  if(typeof value.description!=='string'||value.description.length>2048||controls.test(value.description.replace(/\r\n/g,'\n')))throw new Error('命令说明无效或过长');
  return{id:identifier(value.id,'命令'),groupId:identifier(value.groupId,'分组'),name:label(value.name,'命令名称',100),command:cleanCommandText(value.command),description:value.description.replace(/\r\n/g,'\n'),mode:value.mode,confirmBeforeRun:value.confirmBeforeRun,order:order(value.order)};
}
function cleanLibrary(value:unknown):CommandLibrary{
  if(!value||typeof value!=='object')throw new Error('命令库格式无效');
  const raw=value as CommandLibrary&{version?:number};
  if(raw.version!==1||!Array.isArray(raw.groups)||!Array.isArray(raw.commands))throw new Error('命令库格式或版本无效');
  if(raw.groups.length>maxGroups||raw.commands.length>maxCommands)throw new Error('命令库内容过多');
  const groups=raw.groups.map(cleanCommandGroup);const commands=raw.commands.map(cleanSavedCommand);
  const groupIds=new Set(groups.map(group=>group.id));
  if(groupIds.size!==groups.length||new Set(commands.map(command=>command.id)).size!==commands.length)throw new Error('命令库包含重复标识');
  if(commands.some(command=>!groupIds.has(command.groupId)))throw new Error('命令库包含不存在的分组');
  return{groups:groups.sort((a,b)=>a.order-b.order),commands:commands.sort((a,b)=>a.order-b.order)};
}

/** A separate file keeps commands independent of connection-history pruning. */
export class CommandStore{
  private writes:Promise<unknown>=Promise.resolve();
  constructor(private readonly directory:string){}
  private serial<T>(operation:()=>Promise<T>):Promise<T>{
    const next=this.writes.catch(()=>{}).then(operation);this.writes=next;return next;
  }
  private async read():Promise<CommandLibrary>{
    const file=path.join(this.directory,fileName);
    let data:string;
    try{
      const stat=await fs.stat(file);if(stat.size>maxFileBytes)throw new Error('命令库文件过大');
      data=await fs.readFile(file,'utf8');
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{groups:[],commands:[]};throw error;}
    try{return cleanLibrary(JSON.parse(data));}
    catch(error){throw new Error('命令库读取失败，原文件已保留：'+(error instanceof Error?error.message:'格式无效'));}
  }
  private async write(library:CommandLibrary):Promise<void>{
    const data=JSON.stringify({version:1,...library},null,2)+'\n';
    if(Buffer.byteLength(data,'utf8')>maxFileBytes)throw new Error('命令库文件过大，请减少命令内容');
    await fs.mkdir(this.directory,{recursive:true});
    const temporary=path.join(this.directory,`.${fileName}.${randomUUID()}.tmp`);
    try{
      const handle=await fs.open(temporary,'wx',0o600);
      try{await handle.writeFile(data,'utf8');await handle.sync();}finally{await handle.close();}
      await fs.rename(temporary,path.join(this.directory,fileName));
    }finally{await fs.rm(temporary,{force:true});}
  }
  library():Promise<CommandLibrary>{return this.serial(()=>this.read());}
  commandForSend(request:SendCommandRequest,connectionId:string):Promise<SavedCommand>{
    if(!request||typeof request!=='object'||(request.mode!=='insert'&&request.mode!=='execute')||typeof request.allowOtherConnection!=='boolean'||typeof request.bracketedPaste!=='boolean'||typeof request.expectedCommand!=='string'||typeof request.expectedConfirmBeforeRun!=='boolean')return Promise.reject(new Error('命令发送请求无效'));
    const id=identifier(request.commandId,'命令');identifier(request.expectedGroupId,'分组');identifier(connectionId,'连接');
    return this.serial(async()=>{
      const library=await this.read();const command=library.commands.find(value=>value.id===id);
      const group=command&&library.groups.find(value=>value.id===command.groupId);
      if(!command||!group)throw new Error('此命令或分组已删除，请刷新命令库');
      if(command.command!==request.expectedCommand||command.groupId!==request.expectedGroupId||command.confirmBeforeRun!==request.expectedConfirmBeforeRun)throw new Error('此命令已修改，请重新查看后再发送');
      if(group.connectionId!==request.expectedConnectionId)throw new Error('此命令分组的适用连接已修改，请重新查看后再发送');
      if(group.connectionId&&group.connectionId!==connectionId&&!request.allowOtherConnection)throw new Error('此命令属于其他连接，请确认目标终端后再借用');
      return command;
    });
  }
  saveGroup(value:CommandGroup):Promise<void>{
    const safe=cleanCommandGroup(value);
    return this.serial(async()=>{
      const library=await this.read();const index=library.groups.findIndex(group=>group.id===safe.id);
      if(index<0){if(library.groups.length>=maxGroups)throw new Error('命令分组已达上限');library.groups.push(safe);}else library.groups[index]=safe;
      await this.write(library);
    });
  }
  deleteGroup(id:string):Promise<void>{
    const safe=identifier(id,'分组');
    return this.serial(async()=>{
      const library=await this.read();library.groups=library.groups.filter(group=>group.id!==safe);library.commands=library.commands.filter(command=>command.groupId!==safe);await this.write(library);
    });
  }
  saveCommand(value:SavedCommand):Promise<void>{
    const safe=cleanSavedCommand(value);
    return this.serial(async()=>{
      const library=await this.read();if(!library.groups.some(group=>group.id===safe.groupId))throw new Error('所选命令分组不存在，请刷新后重试');
      const index=library.commands.findIndex(command=>command.id===safe.id);
      if(index<0){if(library.commands.length>=maxCommands)throw new Error('命令数量已达上限');library.commands.push(safe);}else library.commands[index]=safe;
      await this.write(library);
    });
  }
  deleteCommand(id:string):Promise<void>{
    const safe=identifier(id,'命令');
    return this.serial(async()=>{
      const library=await this.read();library.commands=library.commands.filter(command=>command.id!==safe);await this.write(library);
    });
  }
}
