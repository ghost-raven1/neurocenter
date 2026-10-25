import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {completeDeviceJob} from '../src/devices/device-completion';
import {memoryDigest,normalizeMemorySyncPayload} from '../../shared/project-learning-memory-sync.cjs';

const deviceId='11111111-1111-4111-8111-111111111111',lease='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const payload=normalizeMemorySyncPayload({schemaVersion:1,projectId:'project-fixture',bindingId:'a'.repeat(64),instanceId:'44444444-4444-4444-8444-444444444444',assetId:'memory',version:2,manifest:'b'.repeat(64),learningRevision:1,learningDigest:'c'.repeat(64),mode:'sync'});
const receipt={schemaVersion:1,protocol:'project-learning-memory-v1',projectId:payload.projectId,bindingId:payload.bindingId,instanceId:payload.instanceId,assetId:payload.assetId,manifest:payload.manifest,learningDigest:payload.learningDigest,mode:payload.mode,status:'complete',applied:1,removed:0,remaining:0,receiptDigest:memoryDigest('receipt-fixture'),code:'none'};
function fixture(kind='sync-learning-memory',state='running'){
 const job={id,device_id:deviceId,lease,email:'fixture@example.invalid',role:'Администратор проекта',project_id:payload.projectId,kind,state,message:'Original pending message',percent:0,lease_until:new Date(0),payload:{memory:payload},result:null as unknown};
 const operations:unknown[][]=[],sql:string[]=[];let previous=structuredClone(job);
 const query=vi.fn(async(statement:string,params:unknown[]=[])=>{
  sql.push(statement);
  if(statement==='BEGIN'){previous=structuredClone(job);return {rows:[]};}
  if(statement==='ROLLBACK'){Object.assign(job,previous);return {rows:[]};}
  if(statement==='COMMIT')return {rows:[]};
  if(statement.startsWith('SELECT * FROM bridge_jobs'))return {rows:params[0]===id&&params[1]===deviceId&&params[2]===lease?[structuredClone(job)]:[]};
  if(statement.startsWith('UPDATE bridge_jobs')){job.state=params[1] as string;job.message=params[3] as string;job.result=JSON.parse(params[4] as string);return {rows:[],rowCount:1};}
  if(statement.includes('INSERT INTO operations')){operations.push(params);return {rows:[],rowCount:1};}
  throw new Error('Unexpected SQL in receipt fixture: '+statement);
 });
 const release=vi.fn(),pool={connect:async()=>({query,release})} as unknown as Pool;
 return {job,pool,sql,operations,release,send:(result:Record<string,unknown>=receipt,state:'succeeded'|'failed'='succeeded',device=deviceId,jobLease=lease,message='worker message must not expose source')=>completeDeviceJob(pool,device,id,{lease:jobLease,state,message,result})};
}
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}')));});
afterEach(()=>{vi.unstubAllGlobals();});
describe('Private learning mutations → public device job receipt',()=>{
 it('commits public hashes/counters atomically and replays a lost server ACK without another write',async()=>{
  const f=fixture();expect(await f.send()).toEqual({ok:true,repeated:false});expect(f.job.result).toEqual(receipt);expect(f.operations).toHaveLength(1);
  expect(await f.send()).toEqual({ok:true,repeated:true});expect(f.operations).toHaveLength(1);expect(f.sql.filter(sql=>sql.startsWith('UPDATE bridge_jobs'))).toHaveLength(1);expect(f.sql.at(-1)).toBe('COMMIT');
 });
 it.each(['cancelled','reconciling','failed'])('accepts a late receipt after %s without resurrecting cancellation',async state=>{
  const f=fixture('sync-learning-memory',state);await f.send();expect(f.job.state).toBe(state==='cancelled'?'cancelled':'succeeded');expect(f.job.result).toEqual(receipt);
  expect(await f.send()).toEqual({ok:true,repeated:true});
 });
 it('retains partial progress for explicit continuation and rejects a changed acknowledgement',async()=>{
  const f=fixture(),partial={...receipt,status:'partial',remaining:1,code:'unavailable'};
  await f.send(partial,'failed');expect(f.job.state).toBe('failed');expect(f.job.result).toEqual(partial);
  await expect(f.send({...partial,receiptDigest:'d'.repeat(64)},'failed')).rejects.toThrow('иначе');expect(f.operations).toHaveLength(1);
 });
 it.each(['privateText','binding','siteInstance','source','status'])('rejects %s mismatch and rolls back without a public result',async invalid=>{
  const f=fixture(),bad:Record<string,unknown>={...receipt};
  if(invalid==='privateText')bad.observations=['secret approved text'];if(invalid==='binding')bad.bindingId='d'.repeat(64);if(invalid==='siteInstance')bad.instanceId='55555555-5555-4555-8555-555555555555';if(invalid==='source')bad.learningDigest='d'.repeat(64);if(invalid==='status')bad.status='partial';
  await expect(f.send(bad)).rejects.toThrow();expect(f.job.result).toBeNull();expect(f.operations).toEqual([]);expect(f.sql.at(-1)).toBe('ROLLBACK');expect(f.release).toHaveBeenCalled();
 });
 it.each(['device','lease'])('another %s cannot deliver or read an accepted receipt',async invalid=>{
  const f=fixture();await expect(f.send(receipt,'succeeded',invalid==='device'?'55555555-5555-4555-8555-555555555555':deviceId,invalid==='lease'?'55555555-5555-4555-8555-555555555555':lease)).rejects.toThrow('Аренда');expect(f.job.result).toBeNull();
 });
 it('queued work never accepts an unsolicited completed mutation',async()=>{const f=fixture('sync-learning-memory','queued');await expect(f.send()).rejects.toThrow('не принимал');expect(f.job.result).toBeNull();});
 it.each(['running','cancelled','reconciling'])('quirk %s completion preserves partial imported counts and safely repeats',async state=>{
  const f=fixture('import-learning-quirks',state),result={schemaVersion:1,status:'partial',sourceCount:2,imported:1,skipped:0,remaining:1,fileSha256:'a'.repeat(64),safeRetry:true};
  await f.send(result,'failed');expect(f.job.result).toEqual(result);expect(f.job.state).toBe(state==='cancelled'?'cancelled':'failed');expect(await f.send(result,'failed')).toEqual({ok:true,repeated:true});expect(f.operations).toHaveLength(1);
 });
 it.each(['running','reconciling','failed','cancelled'])('quirk %s early failed completion never claims experience was saved',async state=>{
  const f=fixture('import-learning-quirks',state);
  await f.send({},'failed',deviceId,lease,'ENOENT /private/user/bank/quirks.jsonl raw-source-secret');
  expect(f.job.state).toBe(state==='cancelled'?'cancelled':'failed');expect(f.job.result).toEqual({});
  expect(f.job.message).toContain('сохранение опыта не подтверждено');expect(f.job.message).not.toContain('Сохранена часть');
  expect(JSON.stringify(f.operations)).not.toMatch(/ENOENT|private\/user|quirks.jsonl|raw-source-secret/);
  expect(await f.send({},'failed')).toEqual({ok:true,repeated:true});expect(f.operations).toHaveLength(1);
 });
 it.each([0,1])('quirk partial receipt reports confirmed progress only when imported/skipped counts are nonzero: %s',async imported=>{
  const f=fixture('import-learning-quirks'),result={schemaVersion:1,status:'partial',sourceCount:2,imported,skipped:0,remaining:2-imported,fileSha256:'a'.repeat(64),safeRetry:true};
  await f.send(result,'failed');expect(f.job.result).toEqual(result);
  if(imported===0){expect(f.job.message).toContain('сохранение опыта не подтверждено');expect(f.job.message).not.toContain('Сохранена часть');}
  else expect(f.job.message).toContain('Сохранена часть');
  await expect(f.send({...result,imported:1-imported,remaining:1+imported},'failed')).rejects.toThrow('иначе');expect(f.operations).toHaveLength(1);
 });
 it('quirk cancellation retains a late confirmed partial receipt without resurrecting the job',async()=>{
  const f=fixture('import-learning-quirks','cancelled'),result={schemaVersion:1,status:'partial',sourceCount:2,imported:0,skipped:1,remaining:1,fileSha256:'a'.repeat(64),safeRetry:true};
  await f.send(result,'failed');expect(f.job.state).toBe('cancelled');expect(f.job.message).toContain('частичный результат подтверждён');expect(await f.send(result,'failed')).toEqual({ok:true,repeated:true});
 });
 it.each(['queued','foreign lease'])('quirk %s cannot deliver even a failed empty result',async boundary=>{
  const f=fixture('import-learning-quirks',boundary==='queued'?'queued':'running');
  await expect(f.send({},'failed',deviceId,boundary==='foreign lease'?'55555555-5555-4555-8555-555555555555':lease)).rejects.toThrow();
  expect(f.job.result).toBeNull();expect(f.operations).toEqual([]);expect(f.sql.at(-1)).toBe('ROLLBACK');
 });
 it('quirk full completion no longer depends on an unrelated result.ok boolean',async()=>{
  const f=fixture('import-learning-quirks');const result={schemaVersion:1,status:'complete',sourceCount:2,imported:1,skipped:1,remaining:0,fileSha256:'a'.repeat(64),safeRetry:true};
  await f.send(result);expect(f.job.state).toBe('succeeded');expect(f.job.result).toEqual(result);
 });
});
