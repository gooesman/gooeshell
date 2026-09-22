import type {CredentialUpdate,HostProfile} from '../shared/types';
import type {IdentityStore,LoginIdentitySnapshot} from './identity-store';

export interface ResolvedLogin {profile:HostProfile;target?:LoginIdentitySnapshot;jump?:LoginIdentitySnapshot;}
/** Copy all metadata: connected sessions must never reference mutable library records. */
export async function resolveLoginIdentities(store:IdentityStore,input:HostProfile,options:{targetPassword?:boolean;jumpPassword?:boolean}={}):Promise<ResolvedLogin>{
  const profile=structuredClone(input);
  const target=profile.loginIdentityId?await store.snapshot(profile.loginIdentityId,options.targetPassword!==false):undefined;
  const jump=profile.jumpHost?.loginIdentityId?await store.snapshot(profile.jumpHost.loginIdentityId,options.jumpPassword!==false):undefined;
  if(target){profile.username=target.username;profile.auth='password';profile.privateKeyPath='';}
  if(jump&&profile.jumpHost){profile.jumpHost.username=jump.username;profile.jumpHost.auth='password';profile.jumpHost.privateKeyPath='';}
  return{profile,target,jump};
}
/** Shared passwords never enter a connection's independent credential namespace. */
export function connectionCredentialUpdate(profile:HostProfile,update?:CredentialUpdate):CredentialUpdate|undefined{
  if(!update)return;
  if(!profile.loginIdentityId)return update;
  if(update.sudoUsesLogin)return{remember:'session',sudoUsesLogin:true,password:'',passphrase:'',sudoPassword:''};
  return{remember:update.remember,sudoUsesLogin:update.sudoUsesLogin,password:'',passphrase:'',...(update.sudoPassword!==undefined?{sudoPassword:update.sudoPassword}:{})};
}
/** Rendering metadata must remain possible when a system keyring is locked. */
export async function resolveIdentityMetadata(store:IdentityStore,profiles:HostProfile[]):Promise<HostProfile[]>{
  if(!profiles.some(profile=>profile.loginIdentityId||profile.jumpHost?.loginIdentityId))return structuredClone(profiles);
  const identities=await store.metadata();
  return profiles.map(input=>{
    const profile=structuredClone(input),target=identities.find(item=>item.id===profile.loginIdentityId),jump=identities.find(item=>item.id===profile.jumpHost?.loginIdentityId);
    if(target){profile.username=target.username;profile.auth='password';profile.privateKeyPath='';}
    if(jump&&profile.jumpHost){profile.jumpHost.username=jump.username;profile.jumpHost.auth='password';profile.jumpHost.privateKeyPath='';}
    return profile;
  });
}
