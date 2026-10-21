import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

export const recoveryHash=value=>createHash('sha256').update(value).digest('hex');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));

/** Credentials are operator-owned files; neither an HTTP request nor a dump supplies an endpoint. */
export async function privateRecoveryFile(filename,maximum=65536){
 const resolved=await realpath(filename);if(resolved!==path.resolve(filename))throw new Error('Файл конфигурации восстановления не должен быть ссылкой.');
 const handle=await open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const before=await handle.stat();if(!before.isFile()||before.nlink!==1||before.size>maximum||before.mode&0o077)throw new Error('Нужен обычный закрытый файл конфигурации восстановления.');
  const bytes=await handle.readFile(),after=await handle.stat();if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('Конфигурация восстановления изменилась во время чтения.');return bytes;
 }finally{await handle.close();}
}
async function optionalFile(filename,maximum){try{return await privateRecoveryFile(filename,maximum);}catch(error){if(error.code==='ENOENT')return undefined;throw error;}}
const secret=async filename=>{const value=(await privateRecoveryFile(filename,8192)).toString('utf8').trim();if(!value||/[\x00-\x20\x7f]/.test(value))throw new Error('Некорректный закрытый S3 secret.');return value;};

async function endpointConfiguration(raw,directory){
 if(!exact(raw,['endpoint','bucket','region','accessKeyFile','secretKeyFile'])||typeof raw.endpoint!=='string'||typeof raw.bucket!=='string'||!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(raw.bucket)||raw.bucket.includes('..')||!/^[-a-z0-9]{1,64}$/.test(raw.region||''))throw new Error('Некорректная закрытая S3-конфигурация восстановления.');
 const url=new URL(raw.endpoint);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('S3 endpoint требует HTTPS; HTTP допустим только на loopback изолированного стенда.');
 for(const key of ['accessKeyFile','secretKeyFile'])if(typeof raw[key]!=='string'||!raw[key])throw new Error('S3 credentials должны быть в закрытых файлах.');
 const accessKeyFile=path.resolve(directory,raw.accessKeyFile),secretKeyFile=path.resolve(directory,raw.secretKeyFile);
 return {...raw,endpoint:url.origin,accessKeyFile,secretKeyFile,accessKey:await secret(accessKeyFile),secretKey:await secret(secretKeyFile),storageId:'s3:'+recoveryHash(JSON.stringify([url.origin,raw.bucket])).slice(0,32)};
}
export async function snapshotRecoveryConfiguration(directory){
 const filename=path.join(directory,'snapshot-recovery.json'),bytes=await optionalFile(filename,65536);
 if(!bytes)return {signingKeyFile:path.join(directory,'secrets/snapshot_signing_key'),trustedKeysFile:path.join(directory,'secrets/snapshot_trusted_keys.json')};
 const raw=JSON.parse(bytes);if(!exact(raw,['source','target','signingKeyFile','trustedKeysFile'])||['source','target'].some(key=>raw[key]!==undefined&&(!raw[key]||typeof raw[key]!=='object'||Array.isArray(raw[key]))))throw new Error('Некорректная snapshot-recovery.json.');
 for(const key of ['signingKeyFile','trustedKeysFile'])if(raw[key]!==undefined&&(typeof raw[key]!=='string'||!raw[key]))throw new Error('Ключи снимков должны быть закрытыми файлами.');
 return {filename,source:raw.source?await endpointConfiguration(raw.source,directory):undefined,target:raw.target?await endpointConfiguration(raw.target,directory):undefined,
  signingKeyFile:path.resolve(directory,raw.signingKeyFile||'secrets/snapshot_signing_key'),trustedKeysFile:path.resolve(directory,raw.trustedKeysFile||'secrets/snapshot_trusted_keys.json')};
}
/** A confirmed preview is fenced against credential/key changes as well as Compose changes. */
export async function snapshotRecoveryFingerprint(directory){
 const configuration=await snapshotRecoveryConfiguration(directory),files=[configuration.filename,configuration.signingKeyFile,configuration.trustedKeysFile,...[configuration.source,configuration.target].filter(Boolean).flatMap(value=>[value.accessKeyFile,value.secretKeyFile])].filter(Boolean),result=[];
 for(const filename of [...new Set(files)].sort()){const bytes=await optionalFile(filename,65536);result.push({file:filename,sha256:bytes?recoveryHash(bytes):null});}return result;
}
