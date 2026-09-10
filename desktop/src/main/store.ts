import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {defaultSettings} from '../shared/defaults';
import type {HostProfile,AppSettings} from '../shared/types';
export function cleanProfile(input:HostProfile):HostProfile {
  if(!input||typeof input!=='object')throw new Error('连接配置无效');
  const text=(s:unknown,max=255)=>typeof s==='string'&&!/[\0\r\n]/.test(s)&&s.length<=max?s.trim():'';
  const host=text(input.host);const username=text(input.username);
  if(!host||!username||!Number.isInteger(input.port)||input.port<1||input.port>65535)throw new Error('请填写主机、用户名和有效端口');
  return {id:text(input.id)||randomUUID(),name:text(input.name)||host,host,username,port:input.port,
    auth:input.auth==='key'||input.auth==='agent'?input.auth:'password',privateKeyPath:text(input.privateKeyPath,2048),
    rememberHost:input.rememberHost===true,encoding:['utf8','gb18030','big5'].includes(input.encoding)?input.encoding:'utf8'};
}
export function cleanSettings(input:AppSettings):AppSettings {
  const result=structuredClone(defaultSettings);
  if(!input||typeof input!=='object')return result;
  for(const field of ['fontFamily','chineseFont','backgroundImage'] as const)if(typeof input[field]==='string'&&input[field].length<2048&&!input[field].includes('\0'))result[field]=input[field];
  for(const [field,min,max] of [['fontSize',8,40],['lineHeight',1,2],['backgroundOpacity',0,1]] as const)if(Number.isFinite(input[field]))result[field]=Math.max(min,Math.min(max,input[field]));
  for(const field of ['cursorBlink','copyOnSelect','rightClickPaste'] as const)if(typeof input[field]==='boolean')result[field]=input[field];
  for(const id of Object.keys(result.shortcuts))if(typeof input.shortcuts?.[id]==='string'&&input.shortcuts[id].length<80)result.shortcuts[id]=input.shortcuts[id];
  return result;
}
export class Store {
  private readonly writes=new Map<string,Promise<unknown>>();
  constructor(private directory:string){}
  private async read(name:string):Promise<any>{try{return JSON.parse(await fs.readFile(path.join(this.directory,name),'utf8'));}catch{return undefined;}}
  private serial<T>(name:string,operation:()=>Promise<T>):Promise<T>{
    const next=(this.writes.get(name)??Promise.resolve()).catch(()=>{}).then(operation);
    this.writes.set(name,next);
    const release=()=>{if(this.writes.get(name)===next)this.writes.delete(name);};
    void next.then(release,release);
    return next;
  }
  private async write(name:string,value:unknown){
    await fs.mkdir(this.directory,{recursive:true});const dest=path.join(this.directory,name);const temp=dest+'.'+randomUUID()+'.tmp';
    try{await fs.writeFile(temp,JSON.stringify(value,null,2),{encoding:'utf8',flag:'wx'});await fs.rename(temp,dest);}
    finally{await fs.unlink(temp).catch(()=>{});}
  }
  async profiles():Promise<HostProfile[]>{const saved=await this.read('profiles.json');if(!Array.isArray(saved))return[];return saved.flatMap(p=>{try{return[cleanProfile(p)];}catch{return[];}});}
  async settings():Promise<AppSettings>{return cleanSettings(await this.read('settings.json'));}
  async saveProfile(profile:HostProfile){const safe=cleanProfile(profile);return this.serial('profiles.json',async()=>{const all=await this.profiles();await this.write('profiles.json',[...all.filter(p=>p.id!==safe.id),safe]);});}
  async deleteProfile(id:string){return this.serial('profiles.json',async()=>{await this.write('profiles.json',(await this.profiles()).filter(p=>p.id!==id));});}
  async saveSettings(settings:AppSettings){const safe=cleanSettings(settings);return this.serial('settings.json',()=>this.write('settings.json',safe));}
}
