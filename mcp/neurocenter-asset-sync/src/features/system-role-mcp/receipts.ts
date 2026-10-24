import fs from 'node:fs/promises';
import path from 'node:path';
import {stateDir,hash} from '../../bridge/state.js';
import {atomicText} from '../../bridge/atomic-file.js';
import {readBoundedUtf8} from '../../bridge/read-bounded.js';
import {readPrivateConfiguration,writePrivateConfiguration,removePrivateConfiguration,enforcePrivateWindowsAcl,assertPrivateWindowsAcl} from '../local-configuration/private-store.js';
import {systemRoleMcpDigest,normalizeRoleMcpResult} from './contract.js';
import {roleMcpApi} from './api.js';

interface Pointer {id:string;jobId:string;lease:string;deviceId:string;kind:'list'|'call';digest:string}
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const directory=()=>path.join(stateDir(),'system-role-mcp-receipts');
const key=(id:string)=>hash('system-role-mcp-receipt:'+id);
async function root(){
 const dir=directory();await fs.mkdir(dir,{recursive:true,mode:0o700});const stat=await fs.lstat(dir);
 if(!stat.isDirectory()||stat.isSymbolicLink()||process.platform!=='win32'&&(stat.mode&0o077)!==0)throw new Error('Небезопасный каталог квитанций MCP.');
 await enforcePrivateWindowsAcl(dir,true);return dir;
}
function pointer(raw:unknown):Pointer {
 const value=raw as Pointer;
 if(!value||Object.keys(value).sort().join(',')!=='deviceId,digest,id,jobId,kind,lease'||![value.id,value.jobId,value.lease,value.deviceId].every(uuid)
  ||!['list','call'].includes(value.kind)||!/^[a-f0-9]{64}$/.test(value.digest))throw new Error('Повреждена квитанция MCP.');return value;
}
/** The durable private result is fixed before its public pointer, then only that exact acknowledgement is retried. */
export async function saveRoleMcpResult(body:{jobId:string;lease:string;callId:string;result:unknown},deviceId:string,kind:'list'|'call'){
 const result=normalizeRoleMcpResult(body.result,kind),value={...body,result},dir=await root(),files=await fs.readdir(dir);
 if(files.filter(file=>file.endsWith('.json')).length>=200&&!files.includes(body.callId+'.json'))throw new Error('Доставьте сохранённые квитанции MCP перед новыми действиями.');
 const before=await readPrivateConfiguration(key(body.callId));
 if(before&&systemRoleMcpDigest(before)!==systemRoleMcpDigest(value))throw new Error('Результат вызова MCP уже зафиксирован иначе.');
 if(!before)await writePrivateConfiguration(key(body.callId),value,undefined);
 const item=pointer({id:body.callId,jobId:body.jobId,lease:body.lease,deviceId,kind,digest:systemRoleMcpDigest(value)});
 await atomicText(path.join(dir,item.id+'.json'),JSON.stringify(item),0o600);
}
export async function sendRoleMcpResult(body:{jobId:string;lease:string;callId:string;result:unknown},deviceId:string,kind:'list'|'call',signal?:AbortSignal){
 await saveRoleMcpResult(body,deviceId,kind);
 try{await roleMcpApi('result',body,signal);}catch{return;}
 const value=await readPrivateConfiguration(key(body.callId));
 await fs.rm(path.join(await root(),body.callId+'.json'),{force:true});if(value)await removePrivateConfiguration(key(body.callId),value);
}
/** Recovery sends receipts only: it never reconnects a tool or replays a mutation. */
export async function deliverRoleMcpResults(deviceId:string,signal?:AbortSignal){
 const dir=await root(),files=(await fs.readdir(dir)).filter(file=>/^[a-f0-9-]{36}\.json$/.test(file));
 if(files.length>200)throw new Error('Превышен предел сохранённых квитанций MCP.');
 for(const file of files){
  try{
  const destination=path.join(dir,file);await assertPrivateWindowsAcl(destination);
  const item=pointer(JSON.parse(await readBoundedUtf8(destination,4096)));if(item.id+'.json'!==file||item.deviceId!==deviceId)continue;
  const value=await readPrivateConfiguration<{jobId:string;lease:string;callId:string;result:unknown}>(key(item.id));
  if(!value||systemRoleMcpDigest(value)!==item.digest)throw new Error('Содержимое квитанции MCP изменилось.');
  normalizeRoleMcpResult(value.result,item.kind);
  await roleMcpApi('result',value,signal);await fs.rm(destination,{force:true});await removePrivateConfiguration(key(item.id),value);
  }catch{signal?.throwIfAborted();/* One disconnected or revoked receipt never blocks independent sessions. */}
 }
}
