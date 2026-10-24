import fs from 'node:fs/promises';
import {apiHub,hub,stateDir,hash,readState,type Credentials} from '../../bridge/state.js';

export interface RoleMcpIdentity {siteUrl:string;apiUrl:string;profile:string;profileKey:string;deviceId:string;credentialHash:string}
async function identityAt(siteUrl:string,apiUrl:string,profile:string,credentials:Credentials):Promise<RoleMcpIdentity>{
 const stat=await fs.lstat(profile,{bigint:true});
 if(!stat.isDirectory()||stat.isSymbolicLink()||process.platform!=='win32'&&(stat.uid!==BigInt(process.getuid!())||(stat.mode&0o077n)!==0n)
  ||hub()!==siteUrl||apiHub()!==apiUrl||stateDir()!==profile)throw new Error('Профиль MCP изменился.');
 return {siteUrl,apiUrl,profile,profileKey:hash(profile+'\0'+stat.dev+'\0'+stat.ino+'\0'+stat.birthtimeNs),deviceId:credentials.deviceId,credentialHash:hash(credentials.token)};
}
/** A receipt belongs to this physical profile and exact admitted connection, never a replacement token. */
export async function captureRoleMcpIdentity():Promise<RoleMcpIdentity>{
 const site=hub(),origin=apiHub(),profile=stateDir(),credentials=await readState<Credentials>('credentials');
 if(!credentials?.token||!credentials.deviceId)throw new Error('Подключение MCP отсутствует.');
 return identityAt(site,origin,profile,credentials);
}

/** This private lane has bounded reads and cancellation independent of the ordinary device-job drain. */
export async function roleMcpApi<T>(route:'claim'|'authorize'|'context'|'next'|'dispatch'|'result'|'complete',body:unknown,signal?:AbortSignal,expected?:RoleMcpIdentity):Promise<T>{
 const site=hub(),origin=apiHub(),profile=stateDir();
 const credentials=await readState<Credentials>('credentials');if(!credentials)throw new Error('Подключение MCP отсутствует.');
 if(expected){const actual=await identityAt(site,origin,profile,credentials);if(Object.keys(actual).some(key=>actual[key as keyof RoleMcpIdentity]!==expected[key as keyof RoleMcpIdentity]))throw new Error('Подтверждение MCP относится к другому подключению или профилю.');}
 const response=await fetch(origin+'/api/device-channel/system-role-mcp/'+route,{method:'POST',redirect:'error',
  headers:{'content-type':'application/json',authorization:'Bearer '+credentials.token},body:JSON.stringify(body??{}),
  signal:AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])])});
 if(!response.ok){await response.body?.cancel();throw Object.assign(new Error('Канал MCP не подтвердил доступ.'),{status:response.status});}
 const reader=response.body?.getReader();if(!reader)throw new Error('Канал MCP вернул пустой ответ.');const parts:Uint8Array[]=[];let bytes=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>8*1024*1024){await reader.cancel();throw new Error('Канал MCP превысил предел ответа.');}parts.push(part.value);}}
 finally{reader.releaseLock();}
 return JSON.parse(Buffer.concat(parts).toString('utf8'))as T;
}
