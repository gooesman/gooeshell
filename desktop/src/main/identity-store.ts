import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {CredentialCipher} from './credential-store';
import type {HostProfile,LoginIdentityList,LoginIdentityReference,LoginIdentitySummary,SaveLoginIdentityInput} from '../shared/types';

interface RecordValue {id:string;name:string;username:string;remember:'session'|'persistent';version:number;encrypted?:string;}
interface Catalog {schema:1;revision:number;identities:RecordValue[];}
class CancelledIdentityWrite extends Error {}
export interface LoginIdentitySnapshot {id:string;username:string;version:number;remember:'session'|'persistent';password?:string;}
function text(value:unknown,label:string):string{
  if(typeof value!=='string'||!value.trim()||value.length>255||/[\x00-\x1f\x7f]/.test(value))throw new Error(`登录身份${label}无效`);
  return value.trim();
}
function password(value:unknown):string|undefined{
  if(value===undefined)return;
  if(typeof value!=='string'||value.length>16384||value.includes('\0'))throw new Error('密码内容无效或过长');
  return value||undefined;
}
export function identityReferences(id:string,profiles:HostProfile[]):LoginIdentityReference[]{
  return profiles.flatMap(profile=>[
    ...(profile.loginIdentityId===id?[{connectionId:profile.id,name:profile.name,host:profile.host,port:profile.port,role:'target' as const}]:[]),
    ...(profile.jumpHost?.loginIdentityId===id?[{connectionId:profile.id,name:profile.name,host:profile.jumpHost.host,port:profile.jumpHost.port,role:'jump' as const}]:[]),
  ]);
}
/** Metadata and encrypted passwords commit together. Plaintext is only held in this main-process instance. */
export class IdentityStore {
  private readonly file:string;
  private readonly memory=new Map<string,{version:number;password:string}>();
  private queue:Promise<unknown>=Promise.resolve();
  constructor(directory:string,private readonly cipher:CredentialCipher){this.file=path.join(directory,'login-identities.json');}
  private serial<T>(operation:()=>Promise<T>):Promise<T>{const next=this.queue.catch(()=>{}).then(operation);this.queue=next;return next;}
  async available(){try{return await this.cipher.available();}catch{return false;}}
  private async requireCipher(){if(!await this.available())throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE: 系统加密存储暂不可用，请解锁系统密钥服务，或选择仅本次记住。');}
  private async read():Promise<Catalog>{
    let raw:string;try{raw=await fs.readFile(this.file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{schema:1,revision:0,identities:[]};throw error;}
    try{
      const value=JSON.parse(raw) as Catalog;
      if(value.schema!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.identities)||value.identities.length>10000)throw new Error();
      const seen=new Set<string>();
      const identities=value.identities.map(record=>{
        const id=text(record.id,'标识'),name=text(record.name,'名称'),username=text(record.username,'用户名');
        if(seen.has(id)||!Number.isSafeInteger(record.version)||record.version<1||record.version>value.revision||!['session','persistent'].includes(record.remember))throw new Error();
        if(record.encrypted!==undefined&&(typeof record.encrypted!=='string'||!record.encrypted||record.encrypted.length>131072||record.remember!=='persistent'))throw new Error();
        seen.add(id);return{id,name,username,version:record.version,remember:record.remember,...(record.encrypted?{encrypted:record.encrypted}:{})};
      });return{schema:1,revision:value.revision,identities};
    }catch{throw new Error('LOGIN_IDENTITY_DATA_INVALID: 登录身份数据无法读取，原文件已保留。');}
  }
  private async write(value:Catalog,canCommit:()=>boolean=()=>true){
    await fs.mkdir(path.dirname(this.file),{recursive:true});const temporary=this.file+'.'+randomUUID()+'.tmp';
    try{await fs.writeFile(temporary,JSON.stringify(value,null,2),{encoding:'utf8',flag:'wx',mode:0o600});if(!canCommit())throw new CancelledIdentityWrite();await fs.rename(temporary,this.file);}
    finally{await fs.unlink(temporary).catch(()=>{});}
  }
  private summary(record:RecordValue,profiles:HostProfile[]):LoginIdentitySummary{
    return{id:record.id,name:record.name,username:record.username,remember:record.remember,version:record.version,
      hasPassword:record.remember==='persistent'?!!record.encrypted:this.memory.get(record.id)?.version===record.version,
      references:identityReferences(record.id,profiles)};
  }
  private async secret(record:RecordValue):Promise<string|undefined>{
    if(record.remember==='session'){const cached=this.memory.get(record.id);return cached?.version===record.version?cached.password:undefined;}
    if(!record.encrypted)return;
    await this.requireCipher();
    try{
      const decoded=JSON.parse(await this.cipher.decrypt(Buffer.from(record.encrypted,'base64')));
      if(decoded.namespace!=='gooeshell.login-identity.v1'||decoded.id!==record.id||decoded.version!==record.version||decoded.username!==record.username)throw new Error();
      const secret=password(decoded.password);if(!secret)throw new Error();return secret;
    }catch{throw new Error('CREDENTIAL_DECRYPT_FAILED: 登录身份密码无法解密，请重新填写密码或删除该身份后重建。');}
  }
  list(profiles:HostProfile[]=[]):Promise<LoginIdentityList>{return this.serial(async()=>({identities:(await this.read()).identities.map(record=>this.summary(record,profiles)),secureStorageAvailable:await this.available()}));}
  snapshot(id:string,includePassword=true):Promise<LoginIdentitySnapshot>{return this.serial(async()=>{
    const record=(await this.read()).identities.find(item=>item.id===text(id,'标识'));
    if(!record)throw new Error('LOGIN_IDENTITY_NOT_FOUND: 所选登录身份已不存在，请重新选择。');
    return{id:record.id,username:record.username,version:record.version,remember:record.remember,...(includePassword?{password:await this.secret(record)}:{})};
  });}
  private async saveInternal(input:SaveLoginIdentityInput,profiles:HostProfile[],canCommit:()=>boolean=()=>true):Promise<LoginIdentitySummary>{
    if(!input||typeof input!=='object'||!['session','persistent'].includes(input.remember))throw new Error('登录身份保存选项无效');
    const name=text(input.name,'名称'),username=text(input.username,'用户名');password(input.password);
    const catalog=await this.read();const id=input.id===undefined?randomUUID():text(input.id,'标识');
    const previous=catalog.identities.find(item=>item.id===id);
    if(input.id!==undefined&&!previous)throw new Error('LOGIN_IDENTITY_NOT_FOUND: 此登录身份已被删除，请重新加载。');
    if(previous&&input.expectedVersion!==previous.version)throw new Error('LOGIN_IDENTITY_CONFLICT: 此登录身份已被修改，请重新加载后再保存。');
    if(!previous&&input.expectedVersion!==undefined)throw new Error('LOGIN_IDENTITY_CONFLICT: 新登录身份不能携带旧版本。');
    const secret=input.password===undefined&&previous?await this.secret(previous):password(input.password);
    if(input.remember==='persistent')await this.requireCipher();
    const version=catalog.revision+1;if(!Number.isSafeInteger(version))throw new Error('登录身份版本已达到上限');
    const record:RecordValue={id,name,username,remember:input.remember,version};
    if(secret&&input.remember==='persistent'){
      try{const encrypted=await this.cipher.encrypt(JSON.stringify({namespace:'gooeshell.login-identity.v1',id,version,username,password:secret}));if(!encrypted.length)throw new Error();record.encrypted=encrypted.toString('base64');}
      catch{throw new Error('CREDENTIAL_ENCRYPT_FAILED: 系统未能加密登录身份密码，原记录已保留。请重试或选择仅本次记住。');}
    }
    if(!canCommit())throw new CancelledIdentityWrite();
    await this.write({schema:1,revision:version,identities:[...catalog.identities.filter(item=>item.id!==id),record]},canCommit);
    this.memory.delete(id);if(secret&&input.remember==='session')this.memory.set(id,{version,password:secret});
    return this.summary(record,profiles);
  }
  save(input:SaveLoginIdentityInput,profiles:HostProfile[]=[]){return this.serial(()=>this.saveInternal(input,profiles));}
  /** Successful authentication may replace a shared password only at the version it actually used. */
  updatePasswordIfUnchanged(snapshot:LoginIdentitySnapshot,newPassword:string|undefined,canCommit:()=>boolean):Promise<boolean>{return this.serial(async()=>{
    if(!canCommit()||newPassword===undefined)return false;
    const current=(await this.read()).identities.find(item=>item.id===snapshot.id);
    if(!current||current.version!==snapshot.version||current.username!==snapshot.username||!canCommit())return false;
    try{await this.saveInternal({id:current.id,name:current.name,username:current.username,remember:current.remember,password:newPassword,expectedVersion:current.version},[],canCommit);return true;}
    catch(error){if(error instanceof CancelledIdentityWrite)return false;throw error;}
  });}
  delete(id:string,profiles:HostProfile[]=[]):Promise<void>{return this.serial(async()=>{
    const safe=text(id,'标识');if(identityReferences(safe,profiles).length)throw new Error('LOGIN_IDENTITY_IN_USE: 此登录身份仍被连接使用，请先修改相关连接。');
    const catalog=await this.read();if(!catalog.identities.some(item=>item.id===safe))return;
    await this.write({...catalog,revision:catalog.revision+1,identities:catalog.identities.filter(item=>item.id!==safe)});this.memory.delete(safe);
  });}
  clearMemory(){this.memory.clear();}
}
