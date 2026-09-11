import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {connectionIdentity} from '../shared/connections';
import type {CredentialRemember,CredentialStatus,CredentialUpdate,HostProfile} from '../shared/types';

/** The adapter is main-process-only. Tests inject an isolated cipher, never the user's keyring. */
export interface CredentialCipher {
  available():Promise<boolean>;
  encrypt(value:string):Promise<Buffer>;
  decrypt(value:Buffer):Promise<string>;
}
export interface ConnectionSecrets {
  remember:CredentialRemember;sudoUsesLogin:boolean;
  password?:string;passphrase?:string;sudoPassword?:string;
}
interface SecretRecord extends ConnectionSecrets {id:string;identity:string;}
interface EncryptedRecord {id:string;identity:string;encrypted:string;}
const emptySecrets=():ConnectionSecrets=>({remember:'never',sudoUsesLogin:true});
const identity=(profile:HostProfile)=>createHash('sha256').update(connectionIdentity(profile)).digest('hex');
const secretFields=['password','passphrase','sudoPassword'] as const;
function validId(value:unknown):value is string{return typeof value==='string'&&!!value&&value.length<=255&&!/[\0\r\n]/.test(value);}
function cleanUpdate(input:CredentialUpdate):CredentialUpdate{
  if(!input||!['never','session','persistent'].includes(input.remember)||typeof input.sudoUsesLogin!=='boolean')throw new Error('密码保存选项无效');
  const result:CredentialUpdate={remember:input.remember,sudoUsesLogin:input.sudoUsesLogin};
  for(const field of secretFields){
    const value=input[field];
    if(value!==undefined){if(typeof value!=='string'||value.length>16384||value.includes('\0'))throw new Error('密码内容无效或过长');result[field]=value;}
  }
  return result;
}
export class CredentialStore {
  private readonly memory=new Map<string,SecretRecord>();
  private readonly revisions=new Map<string,number>();
  private readonly identities=new Map<string,string>();
  private revisionClock=0;
  private queue:Promise<unknown>=Promise.resolve();
  private readonly file:string;
  constructor(directory:string,private readonly cipher:CredentialCipher){this.file=path.join(directory,'credentials.encrypted.json');}
  private serial<T>(operation:()=>Promise<T>):Promise<T>{const next=this.queue.catch(()=>{}).then(operation);this.queue=next;return next;}
  private validateProfile(profile:HostProfile){if(!profile||!validId(profile.id)||typeof profile.host!=='string'||typeof profile.username!=='string')throw new Error('连接配置无效');}
  private revise(profileId:string){this.revisions.set(profileId,++this.revisionClock);}
  connectClock():number{return this.revisionClock;}
  private async available():Promise<boolean>{try{return await this.cipher.available();}catch{return false;}}
  private async requireEncryption(){if(!await this.available())throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE: 系统加密存储暂不可用，请解锁系统密钥服务，或选择仅本次记住。');}
  private async read():Promise<EncryptedRecord[]>{
    try{
      const stat=await fs.stat(this.file);if(stat.size>8*1024*1024)throw new Error('密码存储文件过大');
      const data=JSON.parse(await fs.readFile(this.file,'utf8'));
      if(data?.version!==1||!Array.isArray(data.records)||data.records.length>10000)throw new Error('密码存储格式无效');
      const ids=new Set<string>();
      for(const record of data.records){
        if(!validId(record?.id)||ids.has(record.id)||typeof record.identity!=='string'||!/^[a-f0-9]{64}$/.test(record.identity)||typeof record.encrypted!=='string'||record.encrypted.length>262144||!record.encrypted||!/^[A-Za-z0-9+/]+={0,2}$/.test(record.encrypted))throw new Error('密码存储记录无效');
        ids.add(record.id);
      }
      return data.records;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw new Error('CREDENTIAL_STORAGE_READ_FAILED: 无法读取密码存储，请检查文件权限或备份。');}
  }
  private async write(records:EncryptedRecord[],canCommit:()=>boolean=()=>true):Promise<boolean>{
    await fs.mkdir(path.dirname(this.file),{recursive:true});
    const temporary=this.file+'.'+randomUUID()+'.tmp';
    try{await fs.writeFile(temporary,JSON.stringify({version:1,records}),{encoding:'utf8',flag:'wx',mode:0o600});if(!canCommit())return false;await fs.rename(temporary,this.file);return true;}
    finally{await fs.unlink(temporary).catch(()=>{});}
  }
  private async getInternal(profile:HostProfile):Promise<ConnectionSecrets>{
    this.validateProfile(profile);const expected=identity(profile);
    const cached=this.memory.get(profile.id);
    if(cached?.identity===expected)return this.onlySecrets(cached);
    const stored=(await this.read()).find(value=>value.id===profile.id&&value.identity===expected);
    if(!stored)return emptySecrets();
    await this.requireEncryption();
    try{
      const decoded=JSON.parse(await this.cipher.decrypt(Buffer.from(stored.encrypted,'base64')));
      if(decoded?.id!==profile.id||decoded.identity!==expected||decoded.remember!=='persistent')throw new Error('密码归属不符');
      const checked=cleanUpdate(decoded);
      return this.onlySecrets(checked);
    }catch{throw new Error('CREDENTIAL_DECRYPT_FAILED: 无法解密此连接的密码，请解锁系统密钥服务，或清除已保存密码后重新输入。');}
  }
  private onlySecrets(value:ConnectionSecrets):ConnectionSecrets{
    const result:ConnectionSecrets={remember:value.remember,sudoUsesLogin:value.sudoUsesLogin};
    for(const field of secretFields)if(value[field])result[field]=value[field];
    return result;
  }
  private async prepareInternal(profile:HostProfile,input:CredentialUpdate):Promise<ConnectionSecrets>{
    const update=cleanUpdate(input);
    if(update.remember==='never')return this.onlySecrets(update);
    if(update.remember==='persistent')await this.requireEncryption();
    const previous=await this.getInternal(profile);
    const next:ConnectionSecrets={...previous,remember:update.remember,sudoUsesLogin:update.sudoUsesLogin};
    for(const field of secretFields)if(update[field]!==undefined){if(update[field])next[field]=update[field];else delete next[field];}
    return next;
  }
  get(profile:HostProfile):Promise<ConnectionSecrets>{return this.serial(()=>this.getInternal(profile));}
  async emptyStatus():Promise<CredentialStatus>{return{remember:'never',sudoUsesLogin:true,hasPassword:false,hasPassphrase:false,hasSudoPassword:false,secureStorageAvailable:await this.available()};}
  prepare(profile:HostProfile,update:CredentialUpdate):Promise<ConnectionSecrets>{return this.serial(()=>this.prepareInternal(profile,update));}
  prepareConnect(profile:HostProfile,update?:CredentialUpdate):Promise<{secrets:ConnectionSecrets;revision:number}>{return this.serial(async()=>{
    const secrets=update?await this.prepareInternal(profile,update):await this.getInternal(profile);
    const expected=identity(profile),previous=this.identities.get(profile.id);
    if(previous&&previous!==expected)this.revise(profile.id);
    this.identities.set(profile.id,expected);
    return{secrets,revision:this.revisions.get(profile.id)??0};
  });}
  status(profile:HostProfile):Promise<CredentialStatus>{return this.serial(async()=>{
    const secrets=await this.getInternal(profile);
    return{remember:secrets.remember,sudoUsesLogin:secrets.sudoUsesLogin,hasPassword:!!secrets.password,hasPassphrase:!!secrets.passphrase,hasSudoPassword:!!(secrets.sudoUsesLogin?secrets.password:secrets.sudoPassword),secureStorageAvailable:await this.available()};
  });}
  save(profile:HostProfile,update:CredentialUpdate):Promise<void>{return this.serial(async()=>{
    this.validateProfile(profile);cleanUpdate(update);this.revise(profile.id);await this.saveInternal(profile,update);
  });}
  saveIfUnchanged(profile:HostProfile,update:CredentialUpdate,revision:number,canCommit:()=>boolean=()=>true,startedAt:number=Infinity):Promise<boolean>{return this.serial(async()=>{
    const current=this.revisions.get(profile.id)??0;
    if(current!==revision||current>startedAt||!canCommit())return false;
    const saved=await this.saveInternal(profile,update,canCommit);if(saved)this.revise(profile.id);return saved;
  });}
  private async saveInternal(profile:HostProfile,update:CredentialUpdate,canCommit:()=>boolean=()=>true):Promise<boolean>{
    this.validateProfile(profile);const safe=cleanUpdate(update);
    // Forgetting works even when the OS keyring can no longer decrypt an old entry.
    if(safe.remember==='never'){if(!canCommit())return false;await this.forgetInternal(profile.id);return true;}
    const next=await this.prepareInternal(profile,safe);
    const record:SecretRecord={id:profile.id,identity:identity(profile),...next};
    const records=(await this.read()).filter(value=>value.id!==profile.id);
    if(next.remember==='persistent'){
      let encrypted:Buffer;
      try{encrypted=await this.cipher.encrypt(JSON.stringify(record));}
      catch{throw new Error('CREDENTIAL_ENCRYPT_FAILED: 系统未能加密密码，未保存明文。请重试或选择仅本次记住。');}
      if(!encrypted.length)throw new Error('CREDENTIAL_ENCRYPT_FAILED: 系统未返回有效的加密结果，密码未保存。');
      records.push({id:record.id,identity:record.identity,encrypted:encrypted.toString('base64')});
    }
    if(!canCommit()||!await this.write(records,canCommit))return false;
    this.identities.set(profile.id,record.identity);
    this.memory.delete(profile.id);
    if(next.remember==='session')this.memory.set(profile.id,record);
    return true;
  }
  private async forgetInternal(profileId:string){
    if(!validId(profileId))throw new Error('连接编号无效');
    this.revise(profileId);
    const records=await this.read();const remaining=records.filter(value=>value.id!==profileId);
    if(remaining.length!==records.length)await this.write(remaining);
    this.memory.delete(profileId);
  }
  forget(profileId:string):Promise<void>{return this.serial(()=>this.forgetInternal(profileId));}
  invalidate(profile:HostProfile):Promise<void>{return this.serial(async()=>{
    this.validateProfile(profile);const expected=identity(profile);
    const previous=this.identities.get(profile.id);let revised=false;
    if(previous&&previous!==expected){this.revise(profile.id);revised=true;}
    const records=await this.read();const remaining=records.filter(value=>value.id!==profile.id||value.identity===expected);
    const cached=this.memory.get(profile.id);
    if(!revised&&(remaining.length!==records.length||(cached&&cached.identity!==expected)))this.revise(profile.id);
    if(remaining.length!==records.length)await this.write(remaining);
    if(cached&&cached.identity!==expected)this.memory.delete(profile.id);
    this.identities.set(profile.id,expected);
  });}
  clearMemory():void{for(const id of this.memory.keys())this.revise(id);this.memory.clear();}
}
