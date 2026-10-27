import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {methodFixture} from './agent-method-workflow.fixture.js';
import {assertMethodCompleted} from '../src/features/agent-method-workflow/completion.js';
import type {AgentMethodWorkflowResult} from '../src/features/agent-method-workflow/contract.js';
describe('Only changed completed method artifacts can finish a full cycle',()=>{
 let fixture:Awaited<ReturnType<typeof methodFixture>>,result:AgentMethodWorkflowResult;
 beforeEach(async()=>{fixture=await methodFixture();result={protocol:fixture.payload.protocol,workflowId:fixture.payload.workflowId,method:'openspec',methodVersion:'1.15.0',runtime:'opencode',state:'unknown',stage:'checks',codeChanged:true,changes:[],artifacts:[],checks:[{command:'node',args:['check.cjs'],exitCode:0,signal:null,state:'passed'}],failure:{code:'UNKNOWN_OUTCOME',action:'inspect-workspace'}};});
 afterEach(async()=>{vi.unstubAllEnvs();await fs.rm(fixture.temporary,{recursive:true,force:true});});
 const artifact=async(file:string,text:string)=>{const target=path.join(fixture.root,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,text);result.changes.push({path:file,beforeSha256:null,afterSha256:'a'.repeat(64)});result.artifacts.push({path:file,sha256:'a'.repeat(64)});};
 it('rejects an old completed task or a new proposal without completed task tracking',async()=>{
  const run=vi.fn(async()=>({code:0,signal:null,stdout:'{}'}));await expect(assertMethodCompleted(fixture.root,fixture.payload,result,run)).rejects.toMatchObject({code:'EXECUTION_FAILED'});
  await artifact('openspec/changes/owned/proposal.md','A new proposal');await expect(assertMethodCompleted(fixture.root,fixture.payload,result,run)).rejects.toMatchObject({code:'EXECUTION_FAILED'});expect(run).not.toHaveBeenCalled();
 });
 it('rejects incomplete tasks even when a caller incorrectly reports all_done',async()=>{
  await artifact('openspec/changes/owned/tasks.md','- [ ] Implement the requested behavior\n');const run=vi.fn(async()=>({code:0,signal:null,stdout:'{"state":"all_done"}'}));
  await expect(assertMethodCompleted(fixture.root,fixture.payload,result,run)).rejects.toMatchObject({code:'EXECUTION_FAILED'});expect(run).not.toHaveBeenCalled();
 });
 it('requires actual CLI all_done progress for the exact changed task directory',async()=>{
  await artifact('openspec/changes/owned/tasks.md','- [x] Implement the requested behavior\n');const run=vi.fn(async()=>({code:0,signal:null,stdout:JSON.stringify({state:'all_done',changeDir:path.join(fixture.root,'openspec/changes/owned'),progress:{total:1,complete:1,remaining:0},tasks:[{done:true}]})}));
  await assertMethodCompleted(fixture.root,fixture.payload,result,run);expect(run).toHaveBeenCalledWith('openspec',['instructions','apply','--change','owned','--json'],true);
 });
 it('BMAD requires a changed done artifact with build and review results',async()=>{
  const payload={...fixture.payload,method:'bmad' as const,methodVersion:'6.12.4'};await artifact('_bmad-output/implementation-artifacts/spec-owned.md','---\nstatus: draft\n---\n## Auto Run Result\nPlanned.\n## Review Triage Log\nNone.\n');
  await expect(assertMethodCompleted(fixture.root,payload,result,async()=>({code:0,signal:null,stdout:''}))).rejects.toMatchObject({code:'EXECUTION_FAILED'});
  await fs.writeFile(path.join(fixture.root,result.changes[0]!.path),'---\nstatus: done\n---\n## Auto Run Result\nImplemented and verified.\n## Review Triage Log\nNo unresolved findings.\n');await assertMethodCompleted(fixture.root,payload,result,async()=>({code:0,signal:null,stdout:''}));
 });
 it('combined reuses accepted BMAD planning but still requires completed changed OpenSpec tasks',async()=>{
  const payload={...fixture.payload,method:'combined' as const,methodVersion:'bmad-6.12.4+openspec-1.15.0'};
  await artifact('openspec/changes/owned/tasks.md','- [x] Implement the requested behavior\n');
  const run=async()=>({code:0,signal:null,stdout:JSON.stringify({state:'all_done',changeDir:path.join(fixture.root,'openspec/changes/owned'),progress:{total:1,complete:1,remaining:0},tasks:[{done:true}]})});
  await expect(assertMethodCompleted(fixture.root,payload,result,run)).rejects.toMatchObject({code:'EXECUTION_FAILED'});
  const brief='_bmad-output/planning-artifacts/product-brief-owned.md';await fs.mkdir(path.dirname(path.join(fixture.root,brief)),{recursive:true});await fs.writeFile(path.join(fixture.root,brief),'---\nstatus: accepted\n---\nAccepted product intent.\n');result.artifacts.push({path:brief,sha256:'a'.repeat(64)});
  await assertMethodCompleted(fixture.root,payload,result,run);expect(result.changes.some(file=>file.path===brief)).toBe(false);
 });
});
