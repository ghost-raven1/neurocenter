import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {publishProjectSnapshot} from '../src/features/project-snapshot/publish.js';
import {snapshotManifestHash,type SnapshotManifest} from '../src/features/project-snapshot/contract.js';
import {pendingCompletions} from '../src/bridge/completions.js';
import {stateDir} from '../src/bridge/state.js';
import {snapshotFixture,job} from './project-snapshot.fixture.js';

let fixture:Awaited<ReturnType<typeof snapshotFixture>>,server:http.Server;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
afterEach(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}vi.unstubAllEnvs();if(fixture)await fs.rm(fixture.temporary,{recursive:true,force:true});});
async function setup(){
 const chunks=new Map<string,Buffer>(),requests:Array<{method:string;route:string}>=[];let manifest:SnapshotManifest|undefined,accepted=false,putCount=0,completeCalls=0;
 const behavior:{http?:number;badMissing?:boolean;badAck?:boolean;failPut?:number;loseComplete?:boolean;unknownComplete?:boolean;delayedComplete?:boolean;afterPut?:()=>Promise<void>}={};
 server=http.createServer((request,response)=>{void(async()=>{
  const route=request.url!,method=request.method!;requests.push({route,method});
  expect(request.headers.authorization).toBe('Bearer FAKE_SNAPSHOT_DEVICE_TOKEN');expect(request.headers['x-neurocenter-job-id']).toBe(job.id);expect(request.headers['x-neurocenter-job-lease']).toBe(job.lease);
  const json=(value:unknown,status=200)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
  if(behavior.http)return json({message:'FAKE_PRIVATE_ERROR_PROVIDER_KEY /Users/private'},behavior.http);
  if(route.endsWith('/status')){if(accepted&&behavior.unknownComplete){response.destroy();return;}return json({snapshotId:fixture.input.snapshotId,status:accepted?'UPLOADED':'UPLOADING',manifestSha256:manifest?snapshotManifestHash(manifest):null,bytes:manifest?.files.reduce((sum,file)=>sum+file.size,0)??0,fileCount:manifest?.files.length??0,tableCount:manifest?.tables.length??0});}
  const parts:Buffer[]=[];for await(const chunk of request)parts.push(Buffer.from(chunk));const body=Buffer.concat(parts);
  if(route.endsWith('/manifest')){manifest=JSON.parse(body.toString());const all=new Map(manifest!.files.flatMap(file=>file.chunks.map(part=>[part.sha256,part] as const)));return json({manifestSha256:snapshotManifestHash(manifest!),missing:behavior.badMissing?[{sha256:'b'.repeat(64),size:9}]:[...all.values()].filter(part=>!chunks.has(part.sha256))});}
  if(method==='PUT'){const sha=route.split('/').at(-1)!;putCount++;if(putCount===behavior.failPut)return json({message:'FAKE_PRIVATE_ERROR_PROVIDER_KEY'},503);
   expect(body.length).toBe(Number(request.headers['content-length']));expect(digest(body)).toBe(sha);chunks.set(sha,body);await behavior.afterPut?.();return json({sha256:behavior.badAck?'f'.repeat(64):sha,bytes:body.length});}
  if(route.endsWith('/complete')){completeCalls++;expect(JSON.parse(body.toString())).toEqual({manifestSha256:snapshotManifestHash(manifest!)});
   for(const part of manifest!.files.flatMap(file=>file.chunks))expect(chunks.get(part.sha256)?.length).toBe(part.size);
   if(behavior.delayedComplete){response.destroy();setTimeout(()=>{accepted=true;},100);return;}accepted=true;
   if(behavior.loseComplete||behavior.unknownComplete){response.destroy();return;}return json({snapshotId:fixture.input.snapshotId,status:'VERIFYING'});}
  return json({},404);
 })().catch(()=>{response.writeHead(500);response.end();});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as {port:number};fixture=await snapshotFixture('http://127.0.0.1:'+address.port,2);
 const run=(authorize=async()=>{})=>fixture.run(()=>publishProjectSnapshot(fixture.input,authorize,async()=>{}));
 return {chunks,requests,behavior,run,get manifest(){return manifest!;},get accepted(){return accepted;},get completeCalls(){return completeCalls;},get putCount(){return putCount;}};
}

describe('Actual HTTP full-image leased publication',()=>{
 it('sends complete raw files, retains stable receipt, and replays accepted completion without rereading changed source',async()=>{
  const api=await setup(),result=await api.run();expect(Object.keys(result).sort()).toEqual(['bindingId','bytes','fileCount','manifestSha256','projectId','snapshotId','status','tableCount']);
  expect(result).toMatchObject({status:'UPLOADED',projectId:fixture.input.projectId,bindingId:fixture.input.bindingId,manifestSha256:snapshotManifestHash(api.manifest),tableCount:3});
  expect((await pendingCompletions())[0]).toMatchObject({...job,state:'succeeded',result});expect(api.completeCalls).toBe(1);
  expect(Buffer.concat([...api.chunks.values()]).includes(Buffer.from('FAKE_PRIVATE_RUNTIME_KEY'))).toBe(false);
  const before=api.requests.length;await fs.rm(fixture.store,{recursive:true});expect(await api.run()).toEqual(result);expect(api.requests.slice(before)).toEqual([{method:'GET',route:api.requests[0].route}]);
 });
 it('reconciles a real lost complete response through server status and records success exactly once',async()=>{
  const api=await setup();api.behavior.loseComplete=true;expect(await api.run()).toMatchObject({status:'UPLOADED'});expect(api.completeCalls).toBe(1);expect(api.requests.at(-1)!.route).toMatch(/\/status$/);expect(await pendingCompletions()).toHaveLength(1);
 });
 it('does not fabricate failed completion when both complete ACK and reconciliation are unavailable',async()=>{
  const api=await setup();api.behavior.unknownComplete=true;await expect(api.run()).rejects.toMatchObject({localChangesCommitted:true});expect(await pendingCompletions()).toEqual([]);expect(api.completeCalls).toBe(1);
 });
 it('treats a pending status after a lost complete ACK as unknown rather than saving a false failure',async()=>{
  const api=await setup();api.behavior.delayedComplete=true;await expect(api.run()).rejects.toMatchObject({localChangesCommitted:true});await vi.waitFor(()=>expect(api.accepted).toBe(true));expect(await pendingCompletions()).toEqual([]);
 });
 it('resumes only missing chunks after a partial transport failure without altering the original database',async()=>{
  const api=await setup();api.behavior.failPut=2;await expect(api.run()).rejects.toThrow('HTTP 503');expect(api.completeCalls).toBe(0);expect(api.chunks.size).toBe(1);
  const cached=[...api.chunks.keys()][0],firstCount=api.requests.filter(request=>request.route.endsWith(cached)).length;api.behavior.failPut=undefined;
  expect(await api.run()).toMatchObject({status:'UPLOADED'});expect(api.requests.filter(request=>request.route.endsWith(cached))).toHaveLength(firstCount);expect(await fs.readFile(path.join(fixture.store,'runtime-overrides.json'),'utf8')).toContain('FAKE_PRIVATE_RUNTIME_KEY');
 });
 it.each([401,403,409,503])('HTTP %d stops before reading and does not leak upstream diagnostics',async status=>{
  const api=await setup();api.behavior.http=status;let caught:unknown;try{await api.run();}catch(error){caught=error;}
  expect(String(caught)).toContain('HTTP '+status);expect(String(caught)).not.toMatch(/FAKE_PRIVATE_ERROR|\/Users/);expect(api.putCount).toBe(0);expect(api.completeCalls).toBe(0);expect(await pendingCompletions()).toEqual([]);
 });
 it.each(['unknown SHA','bad acknowledgement','source file changed','lease revoked','binding replaced','local receipt unavailable'])('%s cannot produce a false completed image',async failure=>{
  const api=await setup();let revoked=false;
  if(failure==='unknown SHA')api.behavior.badMissing=true;
  if(failure==='bad acknowledgement')api.behavior.badAck=true;
  if(failure==='source file changed')api.behavior.afterPut=async()=>{await fs.writeFile(path.join(fixture.store,'chunks.lance','untracked-file'),'unexpected');};
  if(failure==='lease revoked')api.behavior.afterPut=async()=>{revoked=true;};
  if(failure==='binding replaced')api.behavior.afterPut=async()=>{const file=path.join(fixture.root,'.opencode/neurocenter.json');const value=JSON.parse(await fs.readFile(file,'utf8'));await fs.writeFile(file,JSON.stringify({...value,instanceId:'99999999-9999-4999-8999-999999999999'}));};
  if(failure==='local receipt unavailable')api.behavior.afterPut=async()=>{const folder=path.join(stateDir(),'completions');await fs.rm(folder,{recursive:true,force:true});await fs.writeFile(folder,'prevent local receipt');};
  await expect(api.run(async()=>{if(revoked)throw new Error('lease revoked');})).rejects.toThrow();
  expect(api.completeCalls).toBe(failure==='local receipt unavailable'?1:0);if(failure!=='local receipt unavailable')expect(await pendingCompletions()).toEqual([]);
  if(failure==='unknown SHA')expect(api.putCount).toBe(0);
 });
});
