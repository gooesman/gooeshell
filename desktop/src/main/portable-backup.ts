import {createCipheriv,createDecipheriv,randomBytes,scrypt as scryptCallback} from 'node:crypto';
const maxBackupBytes=32*1024*1024;
const parameters={N:32768,r:8,p:1,maxmem:64*1024*1024};
function derive(passphrase:string,salt:Buffer):Promise<Buffer>{return new Promise((resolve,reject)=>scryptCallback(passphrase,salt,32,parameters,(error,key)=>error?reject(error):resolve(key)));}
function password(value:string){if(typeof value!=='string'||value.length<8||value.length>1024)throw new Error('备份密码需要 8 至 1024 个字符');return value;}
function decode(value:unknown,length:number,name:string):Buffer{
  if(typeof value!=='string'||!(/^[A-Za-z0-9+/]*={0,2}$/).test(value))throw new Error(`备份${name}无效`);
  const result=Buffer.from(value,'base64');if(result.length!==length||result.toString('base64')!==value)throw new Error(`备份${name}无效`);return result;
}
/** Portable passphrase encryption; OS-bound ciphertext is never copied across machines. */
export async function encryptBackup(data:unknown,passphrase:string):Promise<string>{
  const plain=Buffer.from(JSON.stringify(data),'utf8');if(plain.length>maxBackupBytes)throw new Error('配置备份过大');
  const salt=randomBytes(16),iv=randomBytes(12),key=await derive(password(passphrase),salt);
  try{const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('gooeshell-backup-v1'));const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);return JSON.stringify({format:'gooeshell-backup',version:1,kdf:'scrypt-32768-8-1',cipher:'aes-256-gcm',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:ciphertext.toString('base64')});}
  finally{plain.fill(0);key.fill(0);}
}
export async function decryptBackup(file:string,passphrase:string):Promise<unknown>{
  if(typeof file!=='string'||Buffer.byteLength(file,'utf8')>Math.ceil(maxBackupBytes*4/3)+4096)throw new Error('备份文件过大');
  let raw:any;try{raw=JSON.parse(file);}catch{throw new Error('备份文件格式无效');}
  if(!raw||raw.format!=='gooeshell-backup'||raw.version!==1||raw.kdf!=='scrypt-32768-8-1'||raw.cipher!=='aes-256-gcm'||typeof raw.data!=='string'||raw.data.length>Math.ceil(maxBackupBytes*4/3)+4)throw new Error('不支持此备份文件或版本');
  const salt=decode(raw.salt,16,'盐值'),iv=decode(raw.iv,12,'随机数'),tag=decode(raw.tag,16,'校验值');
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data))throw new Error('备份内容无效');
  const ciphertext=Buffer.from(raw.data,'base64');if(ciphertext.toString('base64')!==raw.data)throw new Error('备份内容无效');
  const key=await derive(password(passphrase),salt);let plain:Buffer|undefined;
  try{const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(Buffer.from('gooeshell-backup-v1'));decipher.setAuthTag(tag);plain=Buffer.concat([decipher.update(ciphertext),decipher.final()]);return JSON.parse(plain.toString('utf8'));}
  catch{throw new Error('备份密码错误或文件已损坏');}
  finally{key.fill(0);plain?.fill(0);}
}
