import fs from 'node:fs/promises';
import path from 'node:path';
import {syncDirectory,atomicText} from '../../bridge/atomic-file.js';
import {readBoundedSnapshot} from '../../bridge/read-bounded.js';
import {systemRoleMcpDigest,normalizeRoleMcpResult} from './contract.js';
import {roleMcpApi,captureRoleMcpIdentity,type RoleMcpIdentity} from './api.js';
import {sessionDirectory} from './session-journal.js';

interface ResultBody {jobId:string;lease:string;callId:string;result:unknown}
type Scope=Omit<RoleMcpIdentity,'profile'>;
interface Receipt {schemaVersion:2;identity:Scope;kind:'list'|'call';body:ResultBody;digest:string}
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const scope=({profile:_,...value}:RoleMcpIdentity)=>value;
const matches=(identity:RoleMcpIdentity,item:Receipt)=>Object.entries(scope(identity)).every(([key,value])=>item.identity?.[key as keyof Scope]===value);
async function current(identity:RoleMcpIdentity){const actual=await captureRoleMcpIdentity();if(Object.keys(actual).some(key=>actual[key as keyof RoleMcpIdentity]!==identity[key as keyof RoleMcpIdentity]))throw new Error('Подключение результата MCP изменилось.');}
async function read(identity:RoleMcpIdentity,file:string){
 const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==process.getuid!()||(info.mode&0o077)!==0)throw new Error('Небезопасная квитанция результата MCP.');
 const snapshot=await readBoundedSnapshot(file,8*1024*1024),item=JSON.parse(snapshot.bytes.toString('utf8'))as Receipt;
 // Legacy pointers and their private values are retained, never silently adopted
 // into a different API or credential epoch by the v2 recovery lane.
 if(item.schemaVersion!==2)return undefined;
 if(Object.keys(item).sort().join(',')!=='body,digest,identity,kind,schemaVersion'||!['list','call'].includes(item.kind)
  ||!item.identity||Object.keys(item.identity).sort().join(',')!=='apiUrl,credentialHash,deviceId,profileKey,siteUrl'||!item.body
  ||![item.body.jobId,item.body.lease,item.body.callId].every(uuid)||path.basename(file)!==item.body.callId+'.json'
  ||systemRoleMcpDigest(item.body)!==item.digest)throw new Error('Повреждена квитанция результата MCP.');
 normalizeRoleMcpResult(item.body.result,item.kind);return {item,snapshot,file};
}
/** Exact scope and normalized result are fsynced before any network delivery. */
export async function saveRoleMcpResult(body:ResultBody,deviceId:string,kind:'list'|'call',identity=undefined as RoleMcpIdentity|undefined){
 const exact=identity??await captureRoleMcpIdentity();await current(exact);if(exact.deviceId!==deviceId)throw new Error('Результат MCP относится к другому компьютеру.');
 if(![body.jobId,body.lease,body.callId].every(uuid))throw new Error('Некорректная квитанция результата MCP.');
 const normalized={...body,result:normalizeRoleMcpResult(body.result,kind)},directory=await sessionDirectory(exact,'system-role-mcp-receipts'),file=path.join(directory,body.callId+'.json');
 const record:Receipt={schemaVersion:2,identity:scope(exact),kind,body:normalized,digest:systemRoleMcpDigest(normalized)};
 const files=(await fs.readdir(directory)).filter(name=>name.endsWith('.json'));if(files.length>=200&&!files.includes(body.callId+'.json'))throw new Error('Доставьте сохранённые квитанции MCP перед новыми действиями.');
 try{const prior=await read(exact,file);if(!prior||!matches(exact,prior.item)||JSON.stringify(prior.item)!==JSON.stringify(record))throw new Error('Результат MCP уже сохранён иначе.');return prior.item;}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 await current(exact);await atomicText(file,JSON.stringify(record),0o600);return record;
}
async function deliver(identity:RoleMcpIdentity,item:Receipt,signal?:AbortSignal){
 if(!matches(identity,item))return;const file=path.join(await sessionDirectory(identity,'system-role-mcp-receipts'),item.body.callId+'.json'),before=await read(identity,file);
 if(!before||JSON.stringify(before.item)!==JSON.stringify(item))throw new Error('Квитанция результата MCP изменена.');
 const ack=await roleMcpApi<{ok?:boolean}>('result',item.body,signal,identity);if(ack?.ok!==true)throw new Error('Результат MCP не подтверждён.');
 const after=await readBoundedSnapshot(file,8*1024*1024);if(after.fingerprint!==before.snapshot.fingerprint||!after.bytes.equals(before.snapshot.bytes))throw new Error('Квитанция результата MCP заменена.');
 await fs.unlink(file);await syncDirectory(path.dirname(file));
}
export async function sendRoleMcpResult(body:ResultBody,deviceId:string,kind:'list'|'call',signal?:AbortSignal,identity?:RoleMcpIdentity){
 const exact=identity??await captureRoleMcpIdentity(),item=await saveRoleMcpResult(body,deviceId,kind,exact);
 try{await deliver(exact,item,signal);}catch{/* Uncertain results remain private and never replay the tool. */}
}
/** Recovery retries results only within their original physical profile and credential epoch. */
export async function deliverRoleMcpResults(deviceId:string,signal?:AbortSignal){
 const identity=await captureRoleMcpIdentity();if(identity.deviceId!==deviceId)return;
 const directory=await sessionDirectory(identity,'system-role-mcp-receipts'),files=(await fs.readdir(directory)).filter(file=>/^[a-f0-9-]{36}\.json$/.test(file));
 if(files.length>200)throw new Error('Превышен предел сохранённых результатов MCP.');
 for(const name of files){try{const saved=await read(identity,path.join(directory,name));if(saved&&matches(identity,saved.item))await deliver(identity,saved.item,signal);}catch{signal?.throwIfAborted();}}
}
