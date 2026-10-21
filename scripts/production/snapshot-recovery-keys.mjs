import {mkdir,writeFile} from 'node:fs/promises';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import path from 'node:path';
import {privateRecoveryFile,recoveryHash} from './snapshot-recovery-config.mjs';

const keyId=pem=>{if(typeof pem!=='string'||createPublicKey(pem).asymmetricKeyType!=='ed25519')throw new Error('Нужен Ed25519 public key снимков.');return recoveryHash(pem);};
async function optional(filename,maximum){try{return await privateRecoveryFile(filename,maximum);}catch(error){if(error.code==='ENOENT')return undefined;throw error;}}
export async function snapshotKeyMaterial(signingKeyFile,trustedKeysFile,{required=false}={}){
 const privateBytes=await optional(signingKeyFile,8192),trustedBytes=await optional(trustedKeysFile,65536);const trusted={};
 if(privateBytes){const key=createPrivateKey(privateBytes);if(key.asymmetricKeyType!=='ed25519')throw new Error('Нужен Ed25519 private key снимков.');const pem=createPublicKey(key).export({type:'spki',format:'pem'}).toString();trusted[keyId(pem)]=pem;}
 if(trustedBytes){const raw=JSON.parse(trustedBytes);if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>100)throw new Error('Повреждён доверенный keyring снимков.');for(const [id,pem]of Object.entries(raw)){if(keyId(pem)!==id)throw new Error('SHA доверенного ключа снимков не совпал.');trusted[id]=pem;}}
 if(required&&!privateBytes)throw new Error('Подписанные снимки требуют сохранённый закрытый ключ подписи.');return {privateBytes,trustedBytes,trusted};
}
export function verifySnapshotSignatures(signatures,material){
 if(!Array.isArray(signatures)||signatures.length>200000)throw new Error('Некорректный список подписей снимков.');
 for(const signature of signatures){if(!signature||signature.algorithm!=='Ed25519'||keyId(signature.publicKey)!==signature.keyId||material.trusted[signature.keyId]!==signature.publicKey||typeof signature.value!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(signature.value))throw new Error('Подписанный снимок не соответствует сохранённому ключу или доверенному keyring.');}
}
export async function readSnapshotSignatures(sql){
 const signatures=[];for(const table of ['project_snapshots','project_snapshot_profiles']){
  const exists=(await sql('catalog',`SELECT to_regclass('public.${table}') IS NOT NULL;`)).trim();if(exists==='f')continue;if(exists!=='t')throw new Error('Не удалось проверить ключи снимков.');
  const rows=JSON.parse(await sql('catalog',`SELECT coalesce(json_agg(signature),'[]'::json) FROM ${table} WHERE signature IS NOT NULL;`));if(!Array.isArray(rows))throw new Error('Некорректные подписи снимков.');signatures.push(...rows);
 }return signatures;
}
/** Exact signing bytes are private bundle files; they are never returned by the maintenance API. */
export async function exportSnapshotKeys(destination,configuration,signatures){
 const material=await snapshotKeyMaterial(configuration.signingKeyFile,configuration.trustedKeysFile,{required:signatures.length>0});verifySnapshotSignatures(signatures,material);const keyFiles=[];
 if(material.privateBytes||material.trustedBytes){await mkdir(path.join(destination,'operatorsecrets'),{mode:0o700});for(const [name,bytes]of [['snapshot_signing_key',material.privateBytes],['snapshot_trusted_keys.json',material.trustedBytes]])if(bytes){const file='operatorsecrets/'+name;await writeFile(path.join(destination,file),bytes,{flag:'wx',mode:0o600,flush:true});keyFiles.push(file);}}
 return keyFiles;
}
export async function verifyBundleSnapshotKeys(source,inventory,signatures){
 const files=inventory?.keyFiles||[],signing=files.includes('operatorsecrets/snapshot_signing_key')?path.join(source,'operatorsecrets/snapshot_signing_key'):path.join(source,'operatorsecrets/.absent-signing-key'),ring=files.includes('operatorsecrets/snapshot_trusted_keys.json')?path.join(source,'operatorsecrets/snapshot_trusted_keys.json'):path.join(source,'operatorsecrets/.absent-trusted-ring');
 const material=await snapshotKeyMaterial(signing,ring,{required:signatures.length>0});verifySnapshotSignatures(signatures,material);return material;
}
