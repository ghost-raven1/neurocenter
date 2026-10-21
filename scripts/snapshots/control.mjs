import fs from 'node:fs/promises';
import {constants} from 'node:fs';

/** Operator files never come from the control API or a project manifest. */
export async function privateSnapshotFile(filename,maximum=8192){
 const file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const before=await file.stat();if(!before.isFile()||before.nlink!==1||before.mode&0o077||before.size>maximum)throw new Error('UNSAFE_OPERATOR_FILE');
  const bytes=await file.readFile(),after=await file.stat();if(before.size!==bytes.length||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs)throw new Error('OPERATOR_FILE_CHANGED');return bytes;
 }finally{await file.close();}
}
export async function boundedSnapshotResponse(response,maximum){
 const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maximum)){await response.body?.cancel();throw new Error('RESPONSE_LIMIT');}
 if(!response.body)return Buffer.alloc(0);
 const chunks=[];let bytes=0;const reader=response.body.getReader();
 try{for(;;){const value=await reader.read();if(value.done)break;bytes+=value.value.length;if(bytes>maximum)throw new Error('RESPONSE_LIMIT');chunks.push(value.value);}return Buffer.concat(chunks);}
 finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
}
export function snapshotControl(origin,token,request=fetch){
 const base=new URL(origin);
 if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.pathname!=='/'||base.search||base.hash||base.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname)||typeof token!=='string'||token.length<32||token.length>256||/[\x00-\x20\x7f]/.test(token))throw new Error('UNSAFE_CONTROL_CONFIGURATION');
 return async(route,{input,bytes=false,signal}={})=>{
  if(!/^[a-zA-Z0-9/-]+$/.test(route))throw new Error('UNSAFE_CONTROL_ROUTE');
  const timeout=bytes?120000:route==='gc'?180000:15000;
  const response=await request(base.origin+'/internal/project-snapshots/verifier/'+route,{method:bytes?'GET':'POST',redirect:'error',headers:{'x-neurocenter-snapshot-verifier':token,...(!bytes?{'content-type':'application/json'}:{})},...(!bytes?{body:JSON.stringify(input??{})}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout)});
  if(!response.ok){await response.body?.cancel();throw new Error('SNAPSHOT_CONTROL_'+response.status);}
  const body=await boundedSnapshotResponse(response,bytes?64*1024**2:32*1024**2);return bytes?body:body.length?JSON.parse(body.toString('utf8')):null;
 };
}
