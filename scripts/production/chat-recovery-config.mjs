import path from 'node:path';
import {createHash} from 'node:crypto';
import {privateRecoveryFile} from './snapshot-recovery-config.mjs';

export const chatRecoveryHash=value=>createHash('sha256').update(value).digest('hex');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
export const chatRecoveryBucket=value=>typeof value==='string'&&value.length>=3&&value.length<=63&&!/^\d+\.\d+\.\d+\.\d+$/.test(value)&&value.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
async function optional(filename){try{return await privateRecoveryFile(filename);}catch(error){if(error.code==='ENOENT')return undefined;throw error;}}
async function credential(filename){const value=(await privateRecoveryFile(filename,8192)).toString('utf8').trim();if(!value||/[\x00-\x20\x7f]/.test(value))throw Error('Некорректный закрытый ключ chat S3.');return value;}
async function endpoint(raw,directory){
    if(!exact(raw,['endpoint','projectBucket','personalBucket','region','accessKeyFile','secretKeyFile'])||!chatRecoveryBucket(raw.projectBucket)||!chatRecoveryBucket(raw.personalBucket)||raw.projectBucket===raw.personalBucket||!/^[-a-z0-9]{1,64}$/.test(raw.region||''))throw Error('Нужны два разных закрытых бакета chat recovery.');
    const url=new URL(raw.endpoint);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Chat recovery endpoint требует HTTPS или изолированный loopback HTTP.');
    for(const key of ['accessKeyFile','secretKeyFile'])if(typeof raw[key]!=='string'||!raw[key])throw Error('Ключи chat recovery должны находиться в закрытых файлах.');
    const accessKeyFile=path.resolve(directory,raw.accessKeyFile),secretKeyFile=path.resolve(directory,raw.secretKeyFile);
    return{...raw,endpoint:url.origin,accessKeyFile,secretKeyFile,accessKey:await credential(accessKeyFile),secretKey:await credential(secretKeyFile),storageId:chatRecoveryHash(JSON.stringify([url.origin,raw.projectBucket,raw.personalBucket]))};
}
/** Only operator-owned configuration supplies endpoints, both buckets and credentials. */
export async function chatRecoveryConfiguration(directory){
    const filename=path.join(directory,'chat-recovery.json'),bytes=await optional(filename);if(!bytes)return{filename};
    const raw=JSON.parse(bytes);if(!exact(raw,['source','target']))throw Error('Некорректная закрытая chat-recovery.json.');
    return{filename,source:raw.source===undefined?undefined:await endpoint(raw.source,directory),target:raw.target===undefined?undefined:await endpoint(raw.target,directory)};
}
/** Restore approval includes the target and source identities as well as credential bytes. */
export async function chatRecoveryFingerprint(directory){
    const configuration=await chatRecoveryConfiguration(directory),files=[configuration.filename,...[configuration.source,configuration.target].filter(Boolean).flatMap(value=>[value.accessKeyFile,value.secretKeyFile])],result=[];
    for(const file of [...new Set(files)].sort()){const bytes=await optional(file);result.push({file,sha256:bytes?chatRecoveryHash(bytes):null});}return result;
}
