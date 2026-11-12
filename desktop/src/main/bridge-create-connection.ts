import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {HostProfile} from '../shared/types';
import type {IdentityStore} from './identity-store';
import {resolveLoginIdentities} from './identity-resolver';
import {cleanProfile, type Store} from './store';

type Endpoint = {host:string;port:number;username?:string;auth:'password'|'key'|'agent';privateKeyPath?:string;loginIdentityId?:string;rememberHost:boolean};
type Request = Endpoint & {name?:string;groupId?:string;icon?:HostProfile['icon'];encoding:HostProfile['encoding'];favorite:boolean;shellIntegration:boolean;jumpHost?:(Endpoint & {name?:string;reuseConnection:boolean})};

/** Create only: shared identity metadata may be read, but stored secrets are never requested. */
export async function createBridgeConnection(store:Store, identities:IdentityStore, request:Request, signal:AbortSignal){
  const validate=(endpoint:Endpoint,label:string)=>{
    if(!endpoint.loginIdentityId&&!endpoint.username)throw new Error(`请填写${label}用户名或选择已保存的登录身份`);
    if(endpoint.loginIdentityId&&(endpoint.auth!=='password'||endpoint.privateKeyPath))throw new Error(`${label}共享登录身份只能用于密码认证`);
    if(!endpoint.loginIdentityId&&endpoint.auth==='key'&&!endpoint.privateKeyPath)throw new Error(`请选择${label}私钥路径`);
    if(endpoint.auth!=='key'&&endpoint.privateKeyPath)throw new Error(`${label}私钥路径仅适用于密钥认证`);
    if(endpoint.privateKeyPath&&!path.isAbsolute(endpoint.privateKeyPath))throw new Error(`${label}私钥路径必须是本机绝对路径`);
  };
  validate(request,'目标服务器');if(request.jumpHost)validate(request.jumpHost,'跳板机');
  const endpoint=(value:Endpoint)=>({host:value.host.replace(/^\[|\]$/g,''),port:value.port,username:value.username||'',auth:value.auth,privateKeyPath:value.privateKeyPath||'',loginIdentityId:value.loginIdentityId,rememberHost:value.rememberHost});
  const jump=request.jumpHost;
  const profile=cleanProfile({id:randomUUID(),name:request.name||request.host,...endpoint(request),encoding:request.encoding,groupId:request.groupId,icon:request.icon||'server',shellIntegration:request.shellIntegration,
    ...(jump?{jumpHost:{id:randomUUID(),name:jump.name||jump.host,...endpoint(jump),reuseConnection:jump.reuseConnection}}:{})});
  const resolved=await resolveLoginIdentities(identities,profile,{targetPassword:false,jumpPassword:false});
  if(request.loginIdentityId&&request.username&&request.username!==resolved.profile.username)throw new Error('目标服务器用户名与所选登录身份不一致');
  if(jump?.loginIdentityId&&jump.username&&jump.username!==resolved.profile.jumpHost?.username)throw new Error('跳板机用户名与所选登录身份不一致');
  signal.throwIfAborted();
  const result=await store.importConnection(resolved.profile,request.favorite);
  return{connectionId:result.profile.id,name:result.profile.name,host:result.profile.host,port:result.profile.port,username:result.profile.username,auth:result.profile.auth,created:result.added};
}
