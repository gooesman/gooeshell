import {createHash,randomUUID} from 'node:crypto';
import {Store,cleanProfile,cleanGroup,cleanSettings,cleanHostKeyPreference} from './store';
import {CredentialStore,type ConnectionSecrets} from './credential-store';
import {IdentityStore} from './identity-store';
import {CommandStore,cleanCommandGroup,cleanSavedCommand} from './command-store';
import {resolveIdentityMetadata} from './identity-resolver';
import {jumpCredentialProfile} from './jump-profile';
import {connectionConfigurationIdentity} from '../shared/connections';
import type {AppSettings,HostProfile,ConnectionGroup,CommandLibrary,HostKeyPreference} from '../shared/types';

interface BackupIdentity {id:string;name:string;username:string;password?:string}
interface BackupConnection {profile:HostProfile;favorite:boolean;credentials?:ConnectionSecrets;jumpCredentials?:ConnectionSecrets}
export interface PortableConfig {format:'gooeshell-config';version:1;settings:AppSettings;groups:ConnectionGroup[];identities:BackupIdentity[];connections:BackupConnection[];commands:CommandLibrary;hostKeyPreferences:HostKeyPreference[]}

export async function collectPortableConfig(store:Store,identities:IdentityStore,credentials:CredentialStore,commands:CommandStore,includeSecrets:boolean):Promise<PortableConfig>{
  const [raw,profiles,groups,settings,library,identityList,hostKeyPreferences]=await Promise.all([store.connections(),store.profiles(),store.groups(),store.settings(),commands.library(),identities.metadata(),store.hostKeyPreferences()]);
  const resolved=await resolveIdentityMetadata(identities,raw),favorites=new Set(profiles.map(profile=>profile.id));
  const savedIdentities:BackupIdentity[]=[];
  for(const item of identityList){
    const secret=includeSecrets&&item.remember==='persistent'?await identities.snapshot(item.id):undefined;
    savedIdentities.push({id:item.id,name:item.name,username:item.username,...(secret?.password?{password:secret.password}:{})});
  }
  const connections:BackupConnection[]=[];
  for(const profile of resolved){
    let target:ConnectionSecrets|undefined,hop:ConnectionSecrets|undefined;
    if(includeSecrets){
      const found=await credentials.get(profile);if(found.remember==='persistent')target=found;
      if(profile.jumpHost){const foundHop=await credentials.get(jumpCredentialProfile(profile.jumpHost));if(foundHop.remember==='persistent')hop=foundHop;}
    }
    connections.push({profile,favorite:favorites.has(profile.id),...(target?{credentials:target}:{}),...(hop?{jumpCredentials:hop}:{})});
  }
  return{format:'gooeshell-config',version:1,settings,groups,identities:savedIdentities,connections,commands:library,hostKeyPreferences};
}
function id(value:unknown){if(typeof value!=='string'||!value.trim()||value.length>255||/[\x00-\x1f\x7f]/.test(value))throw new Error('备份标识无效');return value;}
function label(value:unknown){if(typeof value!=='string'||!value.trim()||value.length>255||/[\x00-\x1f\x7f]/.test(value))throw new Error('备份身份无效');return value.trim();}
function credential(value:unknown):ConnectionSecrets|undefined{
  if(value===undefined)return;
  if(!value||typeof value!=='object')throw new Error('备份凭据无效');
  const raw=value as ConnectionSecrets;
  if(raw.remember!=='persistent'||typeof raw.sudoUsesLogin!=='boolean')throw new Error('备份凭据选项无效');
  const clean:ConnectionSecrets={remember:'persistent',sudoUsesLogin:raw.sudoUsesLogin};
  for(const key of ['password','passphrase','sudoPassword'] as const){const v=raw[key];if(v!==undefined){if(typeof v!=='string'||v.length>16384||v.includes('\0'))throw new Error('备份凭据无效');if(v)clean[key]=v;}}
  return clean;
}
export function validatePortableConfig(value:unknown):PortableConfig{
  if(!value||typeof value!=='object')throw new Error('配置备份无效');
  const raw=value as PortableConfig;
  if(raw.format!=='gooeshell-config'||raw.version!==1||!raw.settings||typeof raw.settings!=='object'||!Array.isArray(raw.groups)||!Array.isArray(raw.identities)||!Array.isArray(raw.connections)||!raw.commands||!Array.isArray(raw.commands.groups)||!Array.isArray(raw.commands.commands)||!Array.isArray(raw.hostKeyPreferences))throw new Error('配置备份格式或版本无效');
  if(raw.groups.length>1000||raw.identities.length>10000||raw.connections.length>10000||raw.commands.groups.length>1000||raw.commands.commands.length>10000||raw.hostKeyPreferences.length>10000)throw new Error('配置备份包含过多项目');
  const groups=raw.groups.map(cleanGroup);
  const identities=raw.identities.map(item=>{const password=item.password;if(password!==undefined&&(typeof password!=='string'||password.length>16384||password.includes('\0')))throw new Error('备份身份密码无效');return{id:id(item.id),name:label(item.name),username:label(item.username),...(password?{password}:{})};});
  const connections=raw.connections.map(item=>{if(!item||typeof item.favorite!=='boolean')throw new Error('备份连接无效');id(item.profile?.id);const profile=cleanProfile(item.profile);const credentials=credential(item.credentials),jumpCredentials=credential(item.jumpCredentials);if(jumpCredentials&&!profile.jumpHost)throw new Error('跳板机凭据缺少对应连接');return{profile,favorite:item.favorite,...(credentials?{credentials}:{}),...(jumpCredentials?{jumpCredentials}:{})};});
  const commands={groups:raw.commands.groups.map(cleanCommandGroup),commands:raw.commands.commands.map(cleanSavedCommand)};
  const hostKeyPreferences=raw.hostKeyPreferences.map(cleanHostKeyPreference);if(hostKeyPreferences.some(item=>!item.skipVerification))throw new Error('备份指纹选项无效');
  const unique=(values:string[])=>new Set(values).size===values.length;
  if(!unique(groups.map(v=>v.id))||!unique(identities.map(v=>v.id))||!unique(connections.map(v=>v.profile.id))||!unique(commands.groups.map(v=>v.id))||!unique(commands.commands.map(v=>v.id))||!unique(hostKeyPreferences.map(v=>JSON.stringify([v.host,v.port]))))throw new Error('备份包含重复标识');
  const groupIds=new Set(groups.map(v=>v.id)),identityIds=new Set(identities.map(v=>v.id)),commandGroups=new Set(commands.groups.map(v=>v.id));
  if(connections.some(({profile})=>profile.groupId&&!groupIds.has(profile.groupId)||profile.loginIdentityId&&!identityIds.has(profile.loginIdentityId)||profile.jumpHost?.loginIdentityId&&!identityIds.has(profile.jumpHost.loginIdentityId))||commands.commands.some(command=>!commandGroups.has(command.groupId)))throw new Error('备份包含缺失的关联项目');
  const hops=new Map<string,string>();
  for(const {profile,jumpCredentials} of connections)if(profile.jumpHost){const jump=profile.jumpHost,key=JSON.stringify([connectionConfigurationIdentity(jumpCredentialProfile(jump)),jumpCredentials??null]),previous=hops.get(jump.id);if(previous&&previous!==key)throw new Error('备份中的跳板机标识、身份或凭据不一致');hops.set(jump.id,key);}
  return{format:'gooeshell-config',version:1,settings:cleanSettings(raw.settings),groups,identities,connections,commands,hostKeyPreferences};
}

/** Merge into existing data; a matching connection is never overwritten. */
export async function importPortableConfig(config:PortableConfig,store:Store,identities:IdentityStore,credentials:CredentialStore,commands:CommandStore,applySettings:boolean,applyHostPreferences=false){
  const source=validatePortableConfig(config),groupIds=new Map<string,string>(),identityIds=new Map<string,string>(),connectionIds=new Map<string,string>(),jumpIds=new Map<string,string>(),commandIds=new Map<string,string>();
  if((source.identities.some(v=>v.password)||source.connections.some(v=>v.credentials||v.jumpCredentials))&&!await identities.available())throw new Error('系统加密存储不可用，未导入配置');
  let added=0,skipped=0;
  try{
    const existingGroups=await store.groups(),existingConnections=await store.connections();
    const existingJumpIds=new Set(existingConnections.flatMap(item=>item.jumpHost?[item.jumpHost.id]:[])),savedJumpIds=new Set<string>();
    for(const group of source.groups){const existing=existingGroups.find(item=>item.id===group.id);const next=existing&&existing.name===group.name&&existing.icon===group.icon?existing.id:existing?randomUUID():group.id;if(!existing||next!==existing.id)await store.saveGroup({...group,id:next});groupIds.set(group.id,next);}
    for(const item of source.identities){const saved=await identities.importIdentity({sourceId:item.id,name:item.name,username:item.username,remember:item.password?'persistent':'session',...(item.password?{password:item.password}:{})});identityIds.set(item.id,saved.id);}
    for(const item of source.connections){
      const profile=structuredClone(item.profile);const previous=profile.id;
      if(profile.groupId)profile.groupId=groupIds.get(profile.groupId);
      if(profile.loginIdentityId)profile.loginIdentityId=identityIds.get(profile.loginIdentityId);
      if(profile.jumpHost){const jump=profile.jumpHost;const old=jump.id;if(jump.loginIdentityId)jump.loginIdentityId=identityIds.get(jump.loginIdentityId);if(!jumpIds.has(old)){const existing=existingConnections.find(item=>item.jumpHost?.id===old)?.jumpHost;const conflict=existing&&connectionConfigurationIdentity(jumpCredentialProfile(existing))!==connectionConfigurationIdentity(jumpCredentialProfile(jump));jumpIds.set(old,conflict?randomUUID():old);}jump.id=jumpIds.get(old)!;}
      const result=await store.importConnection(profile,item.favorite);connectionIds.set(previous,result.profile.id);
      if(!result.added){skipped++;continue;} added++;
      if(item.credentials)await credentials.save(result.profile,item.credentials);
      if(item.jumpCredentials&&result.profile.jumpHost&&!existingJumpIds.has(result.profile.jumpHost.id)&&!savedJumpIds.has(result.profile.jumpHost.id)){await credentials.save(jumpCredentialProfile(result.profile.jumpHost),item.jumpCredentials);savedJumpIds.add(result.profile.jumpHost.id);}
    }
    const existingCommands=await commands.library();
    for(const group of source.commands.groups){if(group.connectionId&&!connectionIds.has(group.connectionId))connectionIds.set(group.connectionId,'orphan:'+createHash('sha256').update(group.connectionId).digest('hex'));const connectionId=group.connectionId?connectionIds.get(group.connectionId):undefined,existing=existingCommands.groups.find(item=>item.id===group.id);const next=existing&&existing.name===group.name&&existing.connectionId===connectionId?existing.id:existing?randomUUID():group.id;commandIds.set(group.id,next);if(!existing||next!==existing.id)await commands.saveGroup({...group,id:next,...(connectionId?{connectionId}:{})});}
    for(const command of source.commands.commands){const groupId=commandIds.get(command.groupId)!,existing=existingCommands.commands.find(item=>item.id===command.id);if(existing&&existing.groupId===groupId&&existing.name===command.name&&existing.command===command.command)continue;await commands.saveCommand({...command,id:existing?randomUUID():command.id,groupId});}
    if(applySettings)await store.saveSettings(source.settings);
    if(applyHostPreferences)for(const preference of source.hostKeyPreferences)await store.setHostKeyPreference(preference);
    return{added,skipped,identities:source.identities.length,groups:source.groups.length,commands:source.commands.commands.length};
  }catch(error){throw new Error(`导入未全部完成（已添加 ${added} 个连接，跳过 ${skipped} 个）；原有连接未覆盖。${error instanceof Error?error.message:String(error)}`);}
}
