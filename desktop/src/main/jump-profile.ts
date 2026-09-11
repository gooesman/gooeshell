import {createHash} from 'node:crypto';
import type {HostProfile,JumpHostProfile} from '../shared/types';

function text(value:unknown,label:string,max=255,allowEmpty=false):string{
  if(typeof value!=='string'||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw new Error(`跳板机${label}无效`);
  const safe=value.trim();
  if(!allowEmpty&&!safe)throw new Error(`请填写跳板机${label}`);
  return safe;
}

/** Only a single, explicit hop is accepted. Secrets never become profile fields. */
export function cleanJumpProfile(input:unknown):JumpHostProfile{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('跳板机配置无效');
  const value=input as Record<string,unknown>;
  if(value.jumpHost!==undefined)throw new Error('暂不支持多级跳板机，请选择直接连接的跳板机');
  const id=text(value.id,'标识');
  const host=text(value.host,'地址').replace(/^\[|\]$/g,'');
  if(!host)throw new Error('请填写跳板机地址');
  const username=text(value.username,'用户名');
  if(!Number.isInteger(value.port)||Number(value.port)<1||Number(value.port)>65535)throw new Error('跳板机端口应在 1–65535 之间');
  if(value.auth!=='password'&&value.auth!=='key'&&value.auth!=='agent')throw new Error('跳板机身份验证方式无效');
  if(typeof value.rememberHost!=='boolean'||typeof value.reuseConnection!=='boolean')throw new Error('跳板机指纹或连接复用选项无效');
  const name=text(value.name,'名称',255,true)||host;
  const privateKeyPath=value.privateKeyPath===undefined?'':text(value.privateKeyPath,'私钥路径',2048,true);
  if(value.auth==='key'&&!privateKeyPath)throw new Error('请选择跳板机私钥文件');
  return{id,name,host,port:Number(value.port),username,auth:value.auth,privateKeyPath,rememberHost:value.rememberHost,reuseConnection:value.reuseConnection};
}

/** Reused hop presets share credentials without sharing a target's credential id. */
export function jumpCredentialProfile(input:JumpHostProfile):HostProfile{
  const jump=cleanJumpProfile(input);
  return{
    id:`jump:${createHash('sha256').update(jump.id).digest('hex')}`,
    name:jump.name,host:jump.host,port:jump.port,username:jump.username,
    auth:jump.auth,privateKeyPath:jump.privateKeyPath,rememberHost:jump.rememberHost,encoding:'utf8',
  };
}
