import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {methodFixture} from './agent-method-workflow.fixture.js';
import {runAgentMethodWorkflow,stopMethodWorkflows} from '../src/features/agent-method-workflow/executor.js';
import {methodDeliveryResult,recoverMethodCompletions,readMethodReceipt,writeMethodReceipt} from '../src/features/agent-method-workflow/receipts.js';
import {agentMethodWorkflowDigest} from '../src/features/agent-method-workflow/contract.js';
import {saveCompletion,deliverCompletions,pendingCompletions} from '../src/bridge/completions.js';

describe('Actual bounded local workflow subprocesses (harmless fixture runtime, no model)',()=>{
 let fixture:Awaited<ReturnType<typeof methodFixture>>;
 beforeEach(async()=>{fixture=await methodFixture();});
 afterEach(async()=>{await stopMethodWorkflows();vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(fixture.temporary,{recursive:true,force:true});});
 it('changes the owned QA file, runs the real check and redelivers after lost ACK without execution replay',async()=>{
  const completion=await runAgentMethodWorkflow(fixture.job,fixture.deviceId,async()=>{},async()=>{},{prepare:fixture.prepare});
  const result=await methodDeliveryResult(fixture.job.id,fixture.deviceId,fixture.payload.workflowId);
  expect(result).toMatchObject({state:'succeeded',stage:'completed',codeChanged:true,checks:[{exitCode:0,state:'passed'}]});
  expect(result.changes.find(row=>row.path==='app.js')).toMatchObject({beforeSha256:expect.any(String),afterSha256:expect.any(String)});
  expect(result.changes.some(row=>row.path==='unrelated.txt')).toBe(false);expect(await fs.readFile(path.join(fixture.root,'unrelated.txt'),'utf8')).toBe('user work must survive\n');
  expect(JSON.stringify({completion,result})).not.toContain('PRIVATE_OUTPUT_FAKE_TOKEN');
  await saveCompletion({id:fixture.job.id,lease:fixture.job.lease,deviceId:fixture.deviceId,...completion});
  const delivered:unknown[]=[];await expect(deliverCompletions(async value=>{delivered.push(value);throw Error('ACK lost');})).rejects.toThrow('ACK lost');
  await deliverCompletions(async value=>{delivered.push(value);});expect(delivered[0]).toEqual(delivered[1]);expect(await pendingCompletions()).toEqual([]);
  const prepare=vi.fn(fixture.prepare);await runAgentMethodWorkflow(fixture.job,fixture.deviceId,async()=>{},async()=>{},{prepare});expect(prepare).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(fixture.root,'dispatch-count'),'utf8')).toBe('1');
 },30000);
 it('reports the check executable exit instead of the cleanup wrapper exit',async()=>{
  await fs.writeFile(path.join(fixture.root,'check.cjs'),`require('node:fs').writeFileSync('check-result.txt','partial check output');process.exit(7);`);await runAgentMethodWorkflow(fixture.job,fixture.deviceId,async()=>{},async()=>{},{prepare:fixture.prepare});
  const result=await methodDeliveryResult(fixture.job.id,fixture.deviceId,fixture.payload.workflowId);expect(result).toMatchObject({state:'failed',failure:{code:'CHECK_FAILED'},checks:[{exitCode:7,state:'failed'}]});expect(result.changes.some(row=>row.path==='check-result.txt')).toBe(true);
 },30000);
 it('recovers a started marker as unknown without spawning another coding runtime',async()=>{
  const result={protocol:fixture.payload.protocol,workflowId:fixture.payload.workflowId,method:fixture.payload.method,methodVersion:fixture.payload.methodVersion,runtime:'opencode' as const,state:'unknown' as const,stage:'execution' as const,codeChanged:false,changes:[],artifacts:[],checks:fixture.payload.checks.map(check=>({...check,exitCode:null,signal:null,state:'not_run' as const})),failure:{code:'UNKNOWN_OUTCOME' as const,action:'inspect-workspace' as const}};
  await writeMethodReceipt({schemaVersion:1,jobId:fixture.job.id,lease:fixture.job.lease,deviceId:fixture.deviceId,workflowId:fixture.payload.workflowId,payloadHash:agentMethodWorkflowDigest(fixture.payload),state:'started',result},undefined);
  await recoverMethodCompletions(saveCompletion);const prepare=vi.fn(fixture.prepare);await runAgentMethodWorkflow(fixture.job,fixture.deviceId,async()=>{},async()=>{},{prepare});
  expect(prepare).not.toHaveBeenCalled();expect((await readMethodReceipt(fixture.payload.workflowId))?.result.state).toBe('unknown');await expect(fs.stat(path.join(fixture.root,'dispatch-count'))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('kills the owned runtime and descendants when authorization is revoked',async()=>{
  await fs.writeFile(path.join(fixture.root,'runtime.cjs'),`const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('child.pid',String(child.pid));setInterval(()=>{},1000);`);
  let denied=false;const running=runAgentMethodWorkflow(fixture.job,fixture.deviceId,async()=>{if(denied)throw Error('PRIVATE backend denial');},async()=>{},{prepare:fixture.prepare,pollMs:50});
  await vi.waitFor(async()=>expect(await fs.readFile(path.join(fixture.root,'child.pid'),'utf8')).toMatch(/^\d+$/),{timeout:15000});
  const pid=Number(await fs.readFile(path.join(fixture.root,'child.pid'),'utf8'));denied=true;await running;
  expect(await methodDeliveryResult(fixture.job.id,fixture.deviceId,fixture.payload.workflowId)).toMatchObject({state:'failed',failure:{code:'AUTHORIZATION_LOST'},checks:[{state:'not_run'}]});
  expect(()=>process.kill(pid,0)).toThrow();
 },30000);
 it('stops the runtime on worker cancellation and leaves checks not run',async()=>{
  await fs.writeFile(path.join(fixture.root,'runtime.cjs'),`require('node:fs').writeFileSync('app.js','partial cancelled implementation');require('node:fs').writeFileSync('runtime.started','1');setInterval(()=>{},1000);`);
  const running=runAgentMethodWorkflow(fixture.job,fixture.deviceId,async()=>{},async()=>{},{prepare:fixture.prepare});
  await vi.waitFor(async()=>expect(await fs.readFile(path.join(fixture.root,'runtime.started'),'utf8')).toBe('1'),{timeout:15000});
  await stopMethodWorkflows();await running;
  const result=await methodDeliveryResult(fixture.job.id,fixture.deviceId,fixture.payload.workflowId);expect(result).toMatchObject({state:'cancelled',failure:{code:'CANCELLED'},codeChanged:true,checks:[{state:'not_run'}]});expect(result.changes.some(row=>row.path==='app.js')).toBe(true);
  expect(result.changes.some(row=>row.path==='.opencode/neurocenter/files.lock')).toBe(false);
 },30000);
 it('bounds output and preserves a failed result without returning captured secrets',async()=>{
  await fs.writeFile(path.join(fixture.root,'runtime.cjs'),`process.stdout.write('PRIVATE_TOKEN'.repeat(100000));setInterval(()=>{},1000);`);
  await runAgentMethodWorkflow(fixture.job,fixture.deviceId,async()=>{},async()=>{},{prepare:fixture.prepare});const result=await methodDeliveryResult(fixture.job.id,fixture.deviceId,fixture.payload.workflowId);
  expect(result).toMatchObject({state:'failed',failure:{code:'OUTPUT_LIMIT'},checks:[{state:'not_run'}]});expect(JSON.stringify(result)).not.toContain('PRIVATE_TOKEN');
 },30000);
 it('rejects a stale binding before preparing or dispatching local code',async()=>{
  fixture.payload.bindingId='b'.repeat(64);const prepare=vi.fn(fixture.prepare);await runAgentMethodWorkflow(fixture.job,fixture.deviceId,async()=>{},async()=>{},{prepare});
  expect(prepare).not.toHaveBeenCalled();expect(await methodDeliveryResult(fixture.job.id,fixture.deviceId,fixture.payload.workflowId)).toMatchObject({state:'failed',failure:{code:'WORKSPACE_CHANGED'}});
 });
 it('does not report a full cycle from exit zero and old completed artifacts when only code was touched',async()=>{
  const directory=path.join(fixture.root,'openspec/changes/old');await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'tasks.md'),'- [x] Old completed task\n');
  await fs.writeFile(path.join(fixture.root,'runtime.cjs'),`require('node:fs').writeFileSync('app.js','implemented fixture\\n');console.log(JSON.stringify({type:'agent_method_completed',protocol:'opencode-http-v1'}));`);
  await runAgentMethodWorkflow(fixture.job,fixture.deviceId,async()=>{},async()=>{},{prepare:async()=>({...await fixture.prepare(),outputProtocol:'opencode-http-v1'})});
  expect(await methodDeliveryResult(fixture.job.id,fixture.deviceId,fixture.payload.workflowId)).toMatchObject({state:'failed',failure:{code:'EXECUTION_FAILED'},checks:[{state:'passed'}]});
 },30000);
 it('closes stdin for a noninteractive CLI before waiting for execution',async()=>{
  await fs.writeFile(path.join(fixture.root,'runtime.cjs'),`process.stdin.resume();process.stdin.once('end',()=>require('node:fs').writeFileSync('app.js','implemented fixture\\n'));`);
  await runAgentMethodWorkflow(fixture.job,fixture.deviceId,async()=>{},async()=>{},{prepare:fixture.prepare});
  expect(await methodDeliveryResult(fixture.job.id,fixture.deviceId,fixture.payload.workflowId)).toMatchObject({state:'succeeded',checks:[{state:'passed',exitCode:0}]});
 },30000);
 it('blocks a corrupt Quirk source before any coding preparation and preserves its exact bytes',async()=>{
  const file=path.join(fixture.root,'.opencode/rag_db/quirks.jsonl');await fs.mkdir(path.dirname(file),{recursive:true});const bytes='{broken owned fixture}\n';await fs.writeFile(file,bytes);const before=await fs.stat(file),prepare=vi.fn(fixture.prepare);
  await runAgentMethodWorkflow(fixture.job,fixture.deviceId,async()=>{},async()=>{},{prepare});
  expect(prepare).not.toHaveBeenCalled();expect(await methodDeliveryResult(fixture.job.id,fixture.deviceId,fixture.payload.workflowId)).toMatchObject({state:'needs_setup',failure:{code:'QUIRK_STORAGE_INVALID',action:'inspect-workspace'},checks:[{state:'not_run'}]});
  expect(await fs.readFile(file,'utf8')).toBe(bytes);expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);expect(await fs.readdir(path.dirname(file))).toEqual(['quirks.jsonl']);
 });
 it('crash recovery preserves newer durable passed checks and file facts instead of the initial pointer',async()=>{
  const initial={protocol:fixture.payload.protocol,workflowId:fixture.payload.workflowId,method:fixture.payload.method,methodVersion:fixture.payload.methodVersion,runtime:'opencode' as const,state:'unknown' as const,stage:'checks' as const,codeChanged:false,changes:[],artifacts:[],checks:fixture.payload.checks.map(check=>({...check,exitCode:null,signal:null,state:'not_run' as const})),failure:{code:'UNKNOWN_OUTCOME' as const,action:'inspect-workspace' as const}};
  const receipt={schemaVersion:1 as const,jobId:fixture.job.id,lease:fixture.job.lease,deviceId:fixture.deviceId,workflowId:fixture.payload.workflowId,payloadHash:agentMethodWorkflowDigest(fixture.payload),state:'started' as const,result:initial};await writeMethodReceipt(receipt,undefined);
  const newer={...receipt,result:{...initial,codeChanged:true,changes:[{path:'app.js',beforeSha256:'a'.repeat(64),afterSha256:'b'.repeat(64)}],checks:fixture.payload.checks.map(check=>({...check,exitCode:0,signal:null,state:'passed' as const}))}};await writeMethodReceipt(newer,receipt);
  await recoverMethodCompletions(saveCompletion);expect(await methodDeliveryResult(fixture.job.id,fixture.deviceId,fixture.payload.workflowId)).toMatchObject({state:'unknown',codeChanged:true,changes:newer.result.changes,checks:[{state:'passed',exitCode:0}]});
 });
});
