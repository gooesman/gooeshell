import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {defaultSettings,migrateDefaultShortcuts,normalizeShortcut} from '../shared/defaults';
import {preferredChineseFont,systemFontCatalog} from './font-catalog';
import {connectionIdentity} from '../shared/connections';
import {normalizeTerminalPalette} from '../shared/terminal-palettes';
import type {HostProfile,AppSettings,ConnectionHistoryEntry,HostKeyPreference,ConnectionGroup,ConnectionIcon} from '../shared/types';
const connectionIcons=new Set<ConnectionIcon>(['server','cloud','database','router','code','folder']);
function identifier(input:unknown,label='连接'):string{
  if(typeof input!=='string'||!input.trim()||input.length>255||/[\0\r\n]/.test(input))throw new Error(`${label}标识无效`);
  return input.trim();
}
export function cleanProfile(input:HostProfile):HostProfile {
  if(!input||typeof input!=='object')throw new Error('连接配置无效');
  const text=(s:unknown,max=255)=>typeof s==='string'&&!/[\0\r\n]/.test(s)&&s.length<=max?s.trim():'';
  const host=text(input.host);const username=text(input.username);
  if(!host||!username||!Number.isInteger(input.port)||input.port<1||input.port>65535)throw new Error('请填写主机、用户名和有效端口');
  if(input.icon!==undefined&&!connectionIcons.has(input.icon))throw new Error('连接图标无效');
  const groupId=input.groupId===undefined||input.groupId===''?undefined:identifier(input.groupId,'分组');
  return {id:text(input.id)||randomUUID(),name:text(input.name)||host,host,username,port:input.port,
    auth:input.auth==='key'||input.auth==='agent'?input.auth:'password',privateKeyPath:text(input.privateKeyPath,2048),
    rememberHost:input.rememberHost===true,encoding:['utf8','gb18030','big5'].includes(input.encoding)?input.encoding:'utf8',
    ...(groupId?{groupId}:{}),...(input.icon?{icon:input.icon}:{})};
}
export function cleanGroup(input:ConnectionGroup):ConnectionGroup{
  if(!input||typeof input!=='object'||typeof input.name!=='string'||!input.name.trim()||input.name.length>100||/[\0\r\n]/.test(input.name))throw new Error('请填写有效的分组名称');
  if(!connectionIcons.has(input.icon)||!Number.isSafeInteger(input.order)||input.order<0)throw new Error('分组图标或排序无效');
  return{id:identifier(input.id,'分组'),name:input.name.trim(),icon:input.icon,order:input.order};
}
export function cleanSettings(input:AppSettings):AppSettings {
  const result=structuredClone(defaultSettings);
  if(!input||typeof input!=='object')return result;
  if(input.theme==='dark'||input.theme==='light')result.theme=input.theme;
  result.terminalPalette=normalizeTerminalPalette(input.terminalPalette);
  if(Number.isInteger(input.fontWeight)&&input.fontWeight>=1&&input.fontWeight<=1000)result.fontWeight=input.fontWeight;
  result.chineseFontWeight=result.fontWeight;
  if(Number.isInteger(input.chineseFontWeight)&&input.chineseFontWeight>=1&&input.chineseFontWeight<=1000)result.chineseFontWeight=input.chineseFontWeight;
  for(const field of ['fontFamily','chineseFont','backgroundImage'] as const)if(typeof input[field]==='string'&&input[field].length<2048&&!input[field].includes('\0'))result[field]=input[field];
  for(const [field,min,max] of [['fontSize',8,40],['lineHeight',1,2],['backgroundOpacity',0,1]] as const)if(Number.isFinite(input[field]))result[field]=Math.max(min,Math.min(max,input[field]));
  for(const field of ['cursorBlink','copyOnSelect','rightClickPaste','showConnectionHistory','filesToggleIconOnly','sudoPasswordSubmit'] as const)if(typeof input[field]==='boolean')result[field]=input[field];
  for(const id of Object.keys(result.shortcuts))if(typeof input.shortcuts?.[id]==='string'&&input.shortcuts[id].length<80)result.shortcuts[id]=normalizeShortcut(input.shortcuts[id]);
  for(const id of ['previousTab','nextTab','sidebar','terminalHeader','reconnect','sudoPassword','commands']){
    if(typeof input.shortcuts?.[id]==='string'&&input.shortcuts[id].length<80)continue;
    const binding=result.shortcuts[id].toLowerCase();
    if(Object.entries(result.shortcuts).some(([other,value])=>other!==id&&value.toLowerCase()===binding))result.shortcuts[id]='';
  }
  result.shortcuts=migrateDefaultShortcuts(result.shortcuts,Number.isSafeInteger(input.shortcutSchemaVersion)?input.shortcutSchemaVersion:undefined);
  return result;
}
const historyLimit=30;
const catalogFile='connections.json';
interface ConnectionRecord {profile:HostProfile;favorite:boolean;}
interface CatalogHistoryEntry {connectionId:string;connectedAt:number;}
interface ConnectionCatalog {version:1;records:ConnectionRecord[];history:CatalogHistoryEntry[];groups:ConnectionGroup[];}
const validTimestamp=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=8.64e15;
const historyEndpoint=(profile:HostProfile)=>JSON.stringify([profile.host.toLowerCase(),profile.port,profile.username]);
function cleanHistory(input:unknown):ConnectionHistoryEntry[]{
  if(!Array.isArray(input))return[];
  const entries=input.flatMap(value=>{
    try{
      if(!value||typeof value!=='object'||!validTimestamp(value.connectedAt))return[];
      return[{profile:cleanProfile(value.profile),connectedAt:value.connectedAt}];
    }catch{return[];}
  }).sort((a,b)=>b.connectedAt-a.connectedAt);
  const seen=new Set<string>();
  return entries.filter(entry=>{const endpoint=historyEndpoint(entry.profile);if(seen.has(endpoint))return false;seen.add(endpoint);return true;}).slice(0,historyLimit);
}
function cleanCatalog(input:unknown):ConnectionCatalog{
  if(!input||typeof input!=='object'||!('version' in input)||input.version!==1)throw new Error('连接数据版本无效，原文件已保留');
  const raw=input as ConnectionCatalog;
  if(!Array.isArray(raw.records)||!Array.isArray(raw.history)||!Array.isArray(raw.groups))throw new Error('连接数据格式无效，原文件已保留');
  const groups=new Map<string,ConnectionGroup>();
  for(const value of raw.groups){try{const safe=cleanGroup(value);groups.set(safe.id,safe);}catch{}}
  const records=new Map<string,ConnectionRecord>();
  for(const value of raw.records){
    try{
      if(!value||typeof value.favorite!=='boolean')continue;
      // A persisted record must keep its stable id; malformed ids cannot be regenerated on every read.
      identifier(value.profile?.id);
      const profile=cleanProfile(value.profile);if(profile.groupId&&!groups.has(profile.groupId))delete profile.groupId;
      records.set(profile.id,{profile,favorite:value.favorite});
    }catch{}
  }
  const seen=new Set<string>();
  const history=raw.history.filter(value=>value&&typeof value.connectionId==='string'&&records.has(value.connectionId)&&validTimestamp(value.connectedAt))
    .sort((a,b)=>b.connectedAt-a.connectedAt).filter(value=>{if(seen.has(value.connectionId))return false;seen.add(value.connectionId);return true;})
    .slice(0,historyLimit).map(({connectionId,connectedAt})=>({connectionId,connectedAt}));
  return{version:1,records:[...records.values()],history,groups:[...groups.values()].sort((a,b)=>a.order-b.order)};
}
function canonicalProfile(catalog:ConnectionCatalog,profile:HostProfile):HostProfile{
  const record=catalog.records.find(value=>value.profile.id===profile.id)
    ??catalog.records.find(value=>connectionIdentity(value.profile)===connectionIdentity(profile));
  return record?{...profile,id:record.profile.id}:profile;
}
function validateGroup(catalog:ConnectionCatalog,profile:HostProfile){
  if(profile.groupId&&!catalog.groups.some(group=>group.id===profile.groupId))throw new Error('所选连接分组不存在，请重新选择');
}
function putConnection(catalog:ConnectionCatalog,profile:HostProfile,favorite?:boolean):HostProfile{
  const safe=canonicalProfile(catalog,profile);validateGroup(catalog,safe);
  const index=catalog.records.findIndex(value=>value.profile.id===safe.id);
  const record={profile:safe,favorite:favorite??(index>=0&&catalog.records[index].favorite)};
  if(index<0)catalog.records.push(record);else catalog.records[index]=record;
  return safe;
}
const preferenceEndpoint=(value:{host:string;port:number})=>JSON.stringify([value.host.toLowerCase(),value.port]);
function cleanHostKeyPreference(input:HostKeyPreference):HostKeyPreference{
  if(!input||typeof input!=='object'||typeof input.host!=='string'||!input.host.trim()||input.host.length>255||/[\0\r\n]/.test(input.host)||!Number.isInteger(input.port)||input.port<1||input.port>65535||typeof input.skipVerification!=='boolean')throw new Error('请填写有效的服务器地址、端口和指纹选项');
  return{host:input.host.trim().toLowerCase(),port:input.port,skipVerification:input.skipVerification};
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
  private async readCatalog():Promise<ConnectionCatalog>{
    let contents:string;
    try{contents=await fs.readFile(path.join(this.directory,catalogFile),'utf8');}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      const [saved,recent]=await Promise.all([this.read('profiles.json'),this.read('connection-history.json')]);
      const catalog:ConnectionCatalog={version:1,records:[],history:[],groups:[]};
      for(const value of Array.isArray(saved)?saved:[]){
        try{
          const profile=cleanProfile(value);delete profile.groupId;
          const index=catalog.records.findIndex(record=>record.profile.id===profile.id);
          const record={profile,favorite:true};if(index<0)catalog.records.push(record);else catalog.records[index]=record;
        }catch{}
      }
      for(const entry of cleanHistory(recent)){
        const existing=catalog.records.find(record=>record.profile.id===entry.profile.id)
          ??catalog.records.find(record=>connectionIdentity(record.profile)===connectionIdentity(entry.profile))
          ??catalog.records.find(record=>historyEndpoint(record.profile)===historyEndpoint(entry.profile));
        let profile=existing?.profile;
        if(!profile){profile=entry.profile;delete profile.groupId;catalog.records.push({profile,favorite:false});}
        if(!catalog.history.some(value=>value.connectionId===profile.id))catalog.history.push({connectionId:profile.id,connectedAt:entry.connectedAt});
      }
      // Legacy files remain available for recovery. All subsequent operations use this one atomic catalog.
      await this.write(catalogFile,catalog);
      return catalog;
    }
    let input:unknown;
    try{input=JSON.parse(contents);}catch{throw new Error('连接数据无法读取，原文件已保留');}
    return cleanCatalog(input);
  }
  private catalog<T>(operation:(catalog:ConnectionCatalog)=>T|Promise<T>,write=false):Promise<T>{
    return this.serial(catalogFile,async()=>{
      const catalog=await this.readCatalog();const result=await operation(catalog);
      if(write)await this.write(catalogFile,catalog);
      return result;
    });
  }
  async connections():Promise<HostProfile[]>{return this.catalog(catalog=>catalog.records.map(value=>value.profile));}
  async profiles():Promise<HostProfile[]>{return this.catalog(catalog=>catalog.records.filter(value=>value.favorite).map(value=>value.profile));}
  async resolveConnection(profile:HostProfile):Promise<HostProfile>{const safe=cleanProfile(profile);return this.catalog(catalog=>canonicalProfile(catalog,safe));}
  async saveConnection(profile:HostProfile,favorite:boolean):Promise<HostProfile>{
    const safe=cleanProfile(profile);if(typeof favorite!=='boolean')throw new Error('连接收藏选项无效');
    return this.catalog(catalog=>putConnection(catalog,safe,favorite),true);
  }
  async history():Promise<ConnectionHistoryEntry[]>{return this.catalog(catalog=>{
    const profiles=new Map(catalog.records.map(record=>[record.profile.id,record.profile]));
    return catalog.history.map(entry=>({profile:profiles.get(entry.connectionId)!,connectedAt:entry.connectedAt}));
  });}
  async recordConnection(profile:HostProfile,preserveCurrent=false,requireExisting=false){
    const safe=cleanProfile(profile);
    return this.catalog(catalog=>{
      if(requireExisting&&!catalog.records.some(record=>record.profile.id===safe.id))return;
      const current=preserveCurrent?catalog.records.find(record=>record.profile.id===safe.id)?.profile:undefined;
      if(current&&connectionIdentity(current)!==connectionIdentity(safe))return;
      const saved=current??putConnection(catalog,safe);
      catalog.history=[{connectionId:saved.id,connectedAt:Date.now()},...catalog.history.filter(previous=>previous.connectionId!==saved.id)].slice(0,historyLimit);
    },true);
  }
  async clearHistory(){return this.catalog(catalog=>{catalog.history=[];},true);}
  async deleteHistory(id:string){const safe=identifier(id);return this.catalog(catalog=>{catalog.history=catalog.history.filter(entry=>entry.connectionId!==safe);},true);}
  async deleteConnection(id:string){const safe=identifier(id);return this.catalog(catalog=>{
    catalog.records=catalog.records.filter(record=>record.profile.id!==safe);catalog.history=catalog.history.filter(entry=>entry.connectionId!==safe);
  },true);}
  async groups():Promise<ConnectionGroup[]>{return this.catalog(catalog=>catalog.groups);}
  async saveGroup(group:ConnectionGroup):Promise<void>{const safe=cleanGroup(group);return this.catalog(catalog=>{
    const index=catalog.groups.findIndex(value=>value.id===safe.id);if(index<0)catalog.groups.push(safe);else catalog.groups[index]=safe;
    catalog.groups.sort((a,b)=>a.order-b.order);
  },true);}
  async deleteGroup(id:string):Promise<void>{const safe=identifier(id,'分组');return this.catalog(catalog=>{
    catalog.groups=catalog.groups.filter(group=>group.id!==safe);
    for(const record of catalog.records)if(record.profile.groupId===safe)delete record.profile.groupId;
  },true);}
  async hostKeyPreferences():Promise<HostKeyPreference[]>{
    const input=await this.read('host-key-preferences.json');if(!Array.isArray(input))return[];
    const preferences=new Map<string,HostKeyPreference>();
    for(const value of input){try{const safe=cleanHostKeyPreference(value);const key=preferenceEndpoint(safe);if(safe.skipVerification)preferences.set(key,safe);else preferences.delete(key);}catch{}}
    return[...preferences.values()];
  }
  async setHostKeyPreference(preference:HostKeyPreference){
    const safe=cleanHostKeyPreference(preference);
    return this.serial('host-key-preferences.json',async()=>{
      const all=(await this.hostKeyPreferences()).filter(value=>preferenceEndpoint(value)!==preferenceEndpoint(safe));
      await this.write('host-key-preferences.json',safe.skipVerification?[...all,safe]:all);
    });
  }
  async settings():Promise<AppSettings>{
    const saved=await this.read('settings.json');const settings=cleanSettings(saved);
    if(process.platform!=='win32'&&!saved?.chineseFont)settings.chineseFont=preferredChineseFont(await systemFontCatalog());
    return settings;
  }
  async saveProfile(profile:HostProfile){await this.saveConnection(profile,true);}
  async deleteProfile(id:string){const safe=identifier(id);return this.catalog(catalog=>{const record=catalog.records.find(value=>value.profile.id===safe);if(record)record.favorite=false;},true);}
  async saveSettings(settings:AppSettings){const safe=cleanSettings(settings);return this.serial('settings.json',()=>this.write('settings.json',safe));}
}
