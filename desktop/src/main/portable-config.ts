import {createHash,randomUUID} from 'node:crypto';
import {LocalKeyStore,canonicalPublicKey,checkBackupKey,readBackupKey} from './local-keys';
import {Store,cleanProfile,cleanGroup,cleanSettings,cleanHostKeyPreference} from './store';
import {CredentialStore,type ConnectionSecrets} from './credential-store';
import {IdentityStore} from './identity-store';
import {CommandStore,cleanCommandGroup,cleanSavedCommand} from './command-store';
import {resolveIdentityMetadata} from './identity-resolver';
import {jumpCredentialProfile} from './jump-profile';
import {connectionConfigurationIdentity} from '../shared/connections';
import type {AppSettings,HostProfile,ConnectionGroup,CommandLibrary,HostKeyPreference} from '../shared/types';

import {settingSections, settingFields, pickSettings, hasSelection, type BackupSelection, type BackupCatalog} from '../shared/backup';

interface BackupIdentity {id:string;name:string;username:string;password?:string}
interface BackupConnection {profile:HostProfile;favorite:boolean;credentials?:ConnectionSecrets;jumpCredentials?:ConnectionSecrets;privateKey?:string;jumpKey?:string}
export interface PortableConfig {format:'gooeshell-config';version:2|3;privateKeys?:Record<string,string>;settings:Partial<AppSettings>;groups:ConnectionGroup[];identities:BackupIdentity[];connections:BackupConnection[];commands:CommandLibrary;hostKeyPreferences:HostKeyPreference[]}

export async function readPortableConfig(store:Store, identities:IdentityStore, commands:CommandStore):Promise<PortableConfig> {
  const [raw, profiles, groups, settings, library, identityList, hostKeyPreferences] = await Promise.all([
    store.connections(), store.profiles(), store.groups(), store.settings(), commands.library(), identities.metadata(), store.hostKeyPreferences(),
  ]);
  const resolved = await resolveIdentityMetadata(identities, raw);
  const favorites = new Set(profiles.map(profile => profile.id));
  return {format:'gooeshell-config', version:2, settings, groups, commands:library, hostKeyPreferences,
    identities:identityList.map(({id,name,username}) => ({id,name,username})),
    connections:resolved.map(profile => ({profile, favorite:favorites.has(profile.id)}))};
}

export function backupCatalog(data:PortableConfig, exporting=false):BackupCatalog {
  return {settings:settingSections.filter(section => settingFields[section].every(key=>Object.hasOwn(data.settings,key))),
    groups:data.groups.map(({id,name})=>({id,name})), identities:data.identities.map(({id,name,username})=>({id,name,username})),
    connections:data.connections.map(({profile:p,privateKey,jumpKey})=>({hasPrivateKey:exporting ? p.auth==='key'||p.jumpHost?.auth==='key' : !!(privateKey||jumpKey),id:p.id,name:p.name,host:p.host,groupId:p.groupId,
      identityIds:[p.loginIdentityId,p.jumpHost?.loginIdentityId].filter((id):id is string=>!!id)})),
    commandCount:data.commands.commands.length, commandGroupCount:data.commands.groups.length,
    hasSecrets:data.identities.some(i=>!!i.password)||data.connections.some(c=>!!c.credentials||!!c.jumpCredentials),
    hosts:data.hostKeyPreferences.map(({host,port})=>({host,port}))};
}

export function selectPortableConfig(data:PortableConfig, selection:BackupSelection):PortableConfig {
  function selected<T extends string>(requested:T[], available:T[]) {
    const allowed = new Set(available);
    if (!Array.isArray(requested) || requested.length > allowed.size || requested.some(id=>!allowed.has(id)) ||
        new Set(requested).size !== requested.length) throw new Error('备份范围已变化，请重新选择');
    return new Set(requested);
  }
  if (!selection || (selection.privateKeys!==undefined && typeof selection.privateKeys!=='boolean') || [selection.commands,selection.hostPreferences,selection.secrets].some(value=>typeof value!=='boolean'))
    throw new Error('备份选项无效');
  const catalog = backupCatalog(data);
  const sections = selected(selection.settings, catalog.settings);
  const identityIds = selected(selection.identityIds, catalog.identities.map(i=>i.id));
  const groupIds = selected(selection.groupIds, catalog.groups.map(g=>g.id));
  const connectionIds = selected(selection.connectionIds, catalog.connections.map(c=>c.id));
  if (!hasSelection(selection) || (selection.hostPreferences && !catalog.hosts.length) ||
      (selection.commands && !catalog.commandGroupCount && !catalog.commandCount)) throw new Error('请选择可用的备份内容');
  const keys:Record<string,string>={};
  const connections = data.connections.filter(c=>connectionIds.has(c.profile.id)).map(item=>{
    const profile = structuredClone(item.profile);
    if (profile.groupId) groupIds.add(profile.groupId);
    for (const login of [profile, profile.jumpHost]) {
      if (login?.loginIdentityId && !identityIds.has(login.loginIdentityId)) delete login.loginIdentityId;
    }
    const chosen:BackupConnection={profile,favorite:item.favorite};
    if(selection.secrets){chosen.credentials=item.credentials;chosen.jumpCredentials=item.jumpCredentials;}
    if(selection.privateKeys){
      for(const field of ['privateKey','jumpKey'] as const){
        const digest=item[field];
        if(digest){chosen[field]=digest;keys[digest]=data.privateKeys![digest];}
      }
    }
    return chosen;
  });
  return {...data, privateKeys:Object.keys(keys).length?keys:undefined,version:Object.keys(keys).length?3:2, settings:pickSettings(data.settings,[...sections]), connections,
    groups:data.groups.filter(g=>groupIds.has(g.id)),
    identities:data.identities.filter(i=>identityIds.has(i.id)).map(({id,name,username,password})=>
      ({id,name,username,...(selection.secrets && password ? {password} : {})})),
    commands:selection.commands ? data.commands : {groups:[],commands:[]},
    hostKeyPreferences:selection.hostPreferences ? data.hostKeyPreferences : []};
}

export async function collectPortableConfig(store:Store, identities:IdentityStore, credentials:CredentialStore,
  commands:CommandStore, selection:BackupSelection, onUnavailable?:(label:string,protection?:ReturnType<typeof checkBackupKey>)=>void):Promise<PortableConfig> {
  const data = await readPortableConfig(store,identities,commands);
  const result = selectPortableConfig(data,selection);
  async function readSecret<T>(label:string, read:()=>Promise<T>, includedKey?:string) {
    try {return await read();} catch(error) {
      if(!onUnavailable || !(error instanceof Error) || !/^CREDENTIAL_(DECRYPT_FAILED|STORAGE_UNAVAILABLE):/.test(error.message))throw error;
      if(includedKey){
        const bytes=Buffer.from(result.privateKeys![includedKey],'base64');
        try {onUnavailable(label,checkBackupKey(bytes));} finally {bytes.fill(0);}
      }else onUnavailable(label);
    }
  }
  if (selection.privateKeys) {
    const byPath=new Map<string,string>(), keys:Record<string,string>={};
    let total=0;
    for(const item of result.connections) {
      for(const [login,field] of [[item.profile,'privateKey'],[item.profile.jumpHost,'jumpKey']] as const) {
        if(login?.auth!=='key')continue;
        const file=login.privateKeyPath;
        if(!file)throw new Error('请先为「'+login.name+'」选择 SSH 私钥文件');
        let digest=byPath.get(file);
        if(!digest){
          let bytes:Buffer;
          try {bytes=await readBackupKey(file);}catch{throw new Error('无法备份「'+login.name+'」的 SSH 私钥，请检查文件是否存在、可读取，且为受支持的私钥（最大 1 MiB）');}
          try {
            digest=createHash('sha256').update(bytes).digest('hex');
            if(!keys[digest]){
              total+=bytes.length;
              if(total>24*1024*1024)throw new Error('所选私钥超过备份容量，请分批导出');
              keys[digest]=bytes.toString('base64');
            }
            byPath.set(file,digest);
          }finally{bytes.fill(0);}
        }
        item[field]=digest;
      }
    }
    if(byPath.size){result.version=3;result.privateKeys=keys;}
  }
  if (selection.secrets) {
    const persistent = new Set((await identities.metadata()).filter(i=>i.remember==='persistent').map(i=>i.id));
    for (const item of result.identities) {
      if (persistent.has(item.id)) item.password = (await readSecret('登录身份「'+item.name+'」',()=>identities.snapshot(item.id)))?.password;
    }
    const profiles = new Map(data.connections.map(c=>[c.profile.id,c.profile]));
    for (const item of result.connections) {
      // The stored credentials belong to the original target and jump identity bindings.
      const original = profiles.get(item.profile.id)!;
      const target = await readSecret('连接「'+original.name+'」',()=>credentials.get(original),item.privateKey);
      if (target?.remember==='persistent') item.credentials=target;
      if (original.jumpHost) {
        const jump=original.jumpHost;
        const hop = await readSecret('跳板机「'+jump.name+'」',()=>credentials.get(jumpCredentialProfile(jump)),item.jumpKey);
        if (hop?.remember==='persistent') item.jumpCredentials=hop;
      }
    }
  }
  return result;
}
/** User-entered replacements are verified against the exact embedded key and only saved in the backup. */
export function completeBackupKeyPassphrases(data:PortableConfig, answers:Record<string,string>={}) {
  const missing=new Map<string,Set<string>>(), checked=new Map<string,boolean>();
  for(const item of data.connections){
    for(const [digest,field,name] of [[item.privateKey,'credentials',item.profile.name],
      [item.jumpKey,'jumpCredentials',item.profile.jumpHost?.name]] as const){
      if(!digest || !name || item[field]?.passphrase)continue;
      if(!checked.has(digest)){
        const bytes=Buffer.from(data.privateKeys![digest],'base64');
        try{
          checked.set(digest,checkBackupKey(bytes)==='encrypted');
          if(checked.get(digest) && Object.hasOwn(answers,digest) && answers[digest]!==''){
            const text=answers[digest];
            if(typeof text!=='string'||text.length>16384||text.includes('\0'))throw new Error('私钥口令无效');
            try{canonicalPublicKey(bytes,text);}catch{throw new Error('「'+name+'」的私钥口令不正确，请重新输入原口令。');}
          }
        }finally{bytes.fill(0);}
      }
      if(!checked.get(digest))continue;
      if(!Object.hasOwn(answers,digest)){
        const names=missing.get(digest)??new Set<string>();
        names.add(name);missing.set(digest,names);
      }else if(answers[digest]){
        item[field]={remember:'persistent',sudoUsesLogin:true,...item[field],passphrase:answers[digest]};
      }
    }
  }
  return [...missing].map(([id,names])=>({id,label:[...names].join('、')}));
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
  const raw=value as Omit<PortableConfig,'version'> & {version:number};
  if(raw.format!=='gooeshell-config'||![1,2,3].includes(raw.version)||!raw.settings||typeof raw.settings!=='object'||Array.isArray(raw.settings)||!Array.isArray(raw.groups)||!Array.isArray(raw.identities)||!Array.isArray(raw.connections)||!raw.commands||!Array.isArray(raw.commands.groups)||!Array.isArray(raw.commands.commands)||!Array.isArray(raw.hostKeyPreferences))throw new Error('配置备份格式或版本无效');
  if(raw.groups.length>1000||raw.identities.length>10000||raw.connections.length>10000||raw.commands.groups.length>1000||raw.commands.commands.length>10000||raw.hostKeyPreferences.length>10000)throw new Error('配置备份包含过多项目');
  const groups=raw.groups.map(cleanGroup);
  const identities=raw.identities.map(item=>{const password=item.password;if(password!==undefined&&(typeof password!=='string'||password.length>16384||password.includes('\0')))throw new Error('备份身份密码无效');return{id:id(item.id),name:label(item.name),username:label(item.username),...(password?{password}:{})};});
  const keys:Record<string,string>={};
  if(raw.privateKeys!==undefined){
    if(raw.version!==3 || !raw.privateKeys || typeof raw.privateKeys!=='object'||Array.isArray(raw.privateKeys))throw new Error('备份私钥列表无效');
    let total=0;
    for(const [digest,encoded] of Object.entries(raw.privateKeys)){
      if(!/^[a-f0-9]{64}$/.test(digest)||typeof encoded!=='string'||!encoded.length||encoded.length>1398104)throw new Error('备份私钥无效');
      const bytes=Buffer.from(encoded,'base64');
      try{
        total+=bytes.length;
        if(total>24*1024*1024||bytes.toString('base64')!==encoded||createHash('sha256').update(bytes).digest('hex')!==digest)throw new Error('备份私钥校验失败');
        checkBackupKey(bytes);keys[digest]=encoded;
      }finally{bytes.fill(0);}
    }
  }
  const used=new Set<string>();
  function reference(digest:unknown,auth:string|undefined){
    if(digest===undefined)return;
    if(auth!=='key'||typeof digest!=='string'||!Object.hasOwn(keys,digest))throw new Error('备份私钥与连接不匹配');
    used.add(digest);return digest;
  }
  const connections=raw.connections.map(item=>{if(!item||typeof item.favorite!=='boolean')throw new Error('备份连接无效');id(item.profile?.id);const profile=cleanProfile(item.profile);const credentials=credential(item.credentials),jumpCredentials=credential(item.jumpCredentials);if(jumpCredentials&&!profile.jumpHost)throw new Error('跳板机凭据缺少对应连接');return{profile,favorite:item.favorite,privateKey:reference(item.privateKey,profile.auth),jumpKey:reference(item.jumpKey,profile.jumpHost?.auth),...(credentials?{credentials}:{}),...(jumpCredentials?{jumpCredentials}:{})};});
  if(used.size!==Object.keys(keys).length)throw new Error('备份包含无关联的私钥');
  const commands={groups:raw.commands.groups.map(cleanCommandGroup),commands:raw.commands.commands.map(cleanSavedCommand)};
  const hostKeyPreferences=raw.hostKeyPreferences.map(cleanHostKeyPreference);if(hostKeyPreferences.some(item=>!item.skipVerification))throw new Error('备份指纹选项无效');
  const unique=(values:string[])=>new Set(values).size===values.length;
  if(!unique(groups.map(v=>v.id))||!unique(identities.map(v=>v.id))||!unique(connections.map(v=>v.profile.id))||!unique(commands.groups.map(v=>v.id))||!unique(commands.commands.map(v=>v.id))||!unique(hostKeyPreferences.map(v=>JSON.stringify([v.host,v.port]))))throw new Error('备份包含重复标识');
  const groupIds=new Set(groups.map(v=>v.id)),identityIds=new Set(identities.map(v=>v.id)),commandGroups=new Set(commands.groups.map(v=>v.id));
  if(connections.some(({profile})=>profile.groupId&&!groupIds.has(profile.groupId)||profile.loginIdentityId&&!identityIds.has(profile.loginIdentityId)||profile.jumpHost?.loginIdentityId&&!identityIds.has(profile.jumpHost.loginIdentityId))||commands.commands.some(command=>!commandGroups.has(command.groupId)))throw new Error('备份包含缺失的关联项目');
  const hops=new Map<string,string>();
  for(const {profile,jumpCredentials,jumpKey} of connections)if(profile.jumpHost){const jump=profile.jumpHost,key=JSON.stringify([connectionConfigurationIdentity(jumpCredentialProfile(jump)),jumpCredentials??null,jumpKey??null]),previous=hops.get(jump.id);if(previous&&previous!==key)throw new Error('备份中的跳板机标识、身份或凭据不一致');hops.set(jump.id,key);}
  const clean = cleanSettings(raw.settings as AppSettings);
  const sections = settingSections.filter(section => {
    if (raw.version === 1) return true;
    const fields = settingFields[section];
    const present = fields.filter(key=>Object.hasOwn(raw.settings,key)).length;
    if (present && present !== fields.length) throw new Error('备份设置不完整');
    return present > 0;
  });
  return{format:'gooeshell-config',version:used.size?3:2,...(used.size?{privateKeys:keys}:{}),settings:pickSettings(clean,sections),groups,identities,connections,commands,hostKeyPreferences};
}

/** Merge into existing data; a matching connection is never overwritten. */
export async function importPortableConfig(config:PortableConfig,store:Store,identities:IdentityStore,credentials:CredentialStore,commands:CommandStore,selection:BackupSelection,localKeys?:LocalKeyStore){
  const source=selectPortableConfig(validatePortableConfig(config),selection),groupIds=new Map<string,string>(),identityIds=new Map<string,string>(),connectionIds=new Map<string,string>(),jumpIds=new Map<string,string>(),commandIds=new Map<string,string>();
  if((source.identities.some(v=>v.password)||source.connections.some(v=>v.credentials||v.jumpCredentials))&&!await identities.available())throw new Error('系统加密存储不可用，未导入配置');
  let added=0,skipped=0;
  try{
    const existingGroups=source.groups.length ? await store.groups() : [];
    const needsOwners=source.connections.length || source.commands.groups.some(group=>group.connectionId);
    const existingConnections=needsOwners ? await store.connections() : [];
    const existingJumpIds=new Set(existingConnections.flatMap(item=>item.jumpHost?[item.jumpHost.id]:[])),savedJumpIds=new Set<string>();
    // Only use original paths already configured on this machine. Archive paths are never write destinations.
    const localPaths=new Set(existingConnections.flatMap(p=>[p,p.jumpHost]).filter(p=>p?.auth==='key').map(p=>p!.privateKeyPath));
    const restoredPaths=new Map<string,string>(), checkedPaths=new Map<string,string|undefined>();
    for(const item of source.connections){
      for(const [login,digest] of [[item.profile,item.privateKey],[item.profile.jumpHost,item.jumpKey]] as const){
        if(!login||!digest)continue;
        const original=login.privateKeyPath;
        if(original && localPaths.has(original)){
          if(!checkedPaths.has(original)){
            let hash:string|undefined;
            try {const bytes=await readBackupKey(original);try{hash=createHash('sha256').update(bytes).digest('hex');}finally{bytes.fill(0);}}catch{/* Restore a fresh copy if the configured file is gone. */}
            checkedPaths.set(original,hash);
          }
          if(checkedPaths.get(original)===digest)continue;
        }
        if(!localKeys)throw new Error('未指定本机私钥目录');
        if(!restoredPaths.has(digest)){
          const bytes=Buffer.from(source.privateKeys![digest],'base64');
          try{restoredPaths.set(digest,await localKeys.restore(bytes));}finally{bytes.fill(0);}
        }
        login.privateKeyPath=restoredPaths.get(digest)!;
      }
    }
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
    const existingCommands=selection.commands ? await commands.library() : {groups:[],commands:[]};
    // A command-only restore can reuse its original connection on this device.
    const savedById = new Map(existingConnections.map(profile=>[profile.id,profile]));
    const owners = new Map(config.connections.map(item=>[item.profile.id,item.profile]));
    for (const group of source.commands.groups) {
      const ownerId = group.connectionId;
      if (!ownerId || connectionIds.has(ownerId)) continue;
      const local = savedById.get(ownerId), original = owners.get(ownerId);
      const sameOwner = local && (!original || connectionConfigurationIdentity(original)===connectionConfigurationIdentity(local));
      connectionIds.set(ownerId,sameOwner ? ownerId : 'orphan:'+createHash('sha256').update(ownerId).digest('hex'));
    }
    for(const group of source.commands.groups){const connectionId=group.connectionId?connectionIds.get(group.connectionId):undefined,existing=existingCommands.groups.find(item=>item.id===group.id);const next=existing&&existing.name===group.name&&existing.connectionId===connectionId?existing.id:existing?randomUUID():group.id;commandIds.set(group.id,next);if(!existing||next!==existing.id)await commands.saveGroup({...group,id:next,...(connectionId?{connectionId}:{})});}
    for(const command of source.commands.commands){const groupId=commandIds.get(command.groupId)!,existing=existingCommands.commands.find(item=>item.id===command.id);if(existing&&existing.groupId===groupId&&existing.name===command.name&&existing.command===command.command)continue;await commands.saveCommand({...command,id:existing?randomUUID():command.id,groupId});}
    if(selection.settings.length)await store.mergeSettings(source.settings);
    for(const preference of source.hostKeyPreferences)await store.setHostKeyPreference(preference);
    return{added,skipped,privateKeys:Object.keys(source.privateKeys??{}).length,identities:source.identities.length,groups:source.groups.length,commands:source.commands.commands.length};
  }catch(error){throw new Error(`导入未全部完成（已添加 ${added} 个连接，跳过 ${skipped} 个）；原有连接未覆盖。${error instanceof Error?error.message:String(error)}`);}
}
