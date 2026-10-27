import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {methodFixture} from './agent-method-workflow.fixture.js';
import {isolateAgentHome,preparedAgentsPayload} from './project-agents.fixture.js';
import {configureProjectAgents} from '../src/features/project-agents/index.js';
import {compileProjectAgents} from '../src/features/project-agents/contract.js';
import {agentFile,AGENTS_RECEIPT} from '../src/features/project-agents/receipt.js';
import {assertSelectedMethodAgent} from '../src/features/agent-method-workflow/selected-agent.js';
import {runAgentMethodWorkflow,stopMethodWorkflows} from '../src/features/agent-method-workflow/executor.js';
import {methodDeliveryResult} from '../src/features/agent-method-workflow/receipts.js';
import {agentMethodWorkflowAgentIdentity} from '../src/features/agent-method-workflow/contract.js';

describe('Selected project agent: real local compilation receipts, safe metadata and harmless subprocesses, no model/API',()=>{
 let f:Awaited<ReturnType<typeof methodFixture>>,home:string;
 const selectedFile=()=>path.join(f.root,agentFile(f.payload.agent!.slug));
 beforeEach(async()=>{
  f=await methodFixture();home=await isolateAgentHome(f.temporary);
  const p=preparedAgentsPayload({schemaVersion:2,projectId:f.payload.projectId,bindingId:f.payload.bindingId,instanceId:f.payload.instanceId,revision:1,
   agents:[{id:'owned-agent',slug:'nc-owned-agent',version:1,enabled:true,description:'Own QA',prompt:'Use only the owned QA project.',mode:'primary',permission:{read:'allow',edit:'allow',bash:'allow'},model:'provider/model'}]});
  const compiled=p.compilation!,result=await configureProjectAgents(p,async()=>{},async()=>{},async mappings=>compileProjectAgents(p,mappings));
  f.payload.agent={agentId:'owned-agent',slug:'nc-owned-agent',version:1,mode:'primary',agentsRevision:result.revision,agentsManifestSha256:result.manifestSha256,
   compiledManifestSha256:result.compiledManifestSha256,fileSha256:result.agents[0]!.sha256,configurationJobId:randomUUID(),model:compiled.mappings[0]!};
 });
 afterEach(async()=>{await stopMethodWorkflows();vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(f.temporary,{recursive:true,force:true});});
 it('verifies a committed real configureProjectAgents result without reading local credentials',async()=>{
  const auth=path.join(home,'.local/share/opencode/auth.json');await fs.mkdir(path.dirname(auth),{recursive:true});await fs.writeFile(auth,'PRIVATE_INVALID_AUTH');
  await expect(assertSelectedMethodAgent(f.root,f.payload,async()=>{})).resolves.toBeUndefined();
  expect(await fs.readFile(auth,'utf8')).toBe('PRIVATE_INVALID_AUTH');
 });
 it.each(['file','receipt','model','namespace','version'] as const)('blocks stale %s before preparing or dispatching a coding process and preserves the local edit',async kind=>{
  const file=kind==='model'?path.join(home,'.config/opencode/opencode.json'):kind==='namespace'?path.join(f.root,'.opencode/opencode.json'):kind==='receipt'?path.join(f.root,AGENTS_RECEIPT):selectedFile();
  if(kind==='file')await fs.appendFile(file,'\nLocal user edit.\n');
  if(kind==='receipt')await fs.writeFile(file,'{}');
  if(kind==='model'){const value=JSON.parse(await fs.readFile(file,'utf8'));value.provider.provider.options.baseURL='https://changed.example.test/v1';await fs.writeFile(file,JSON.stringify(value));}
  if(kind==='namespace')await fs.writeFile(file,JSON.stringify({agent:{'nc-owned-agent':{prompt:'Manual override'}}}));
  if(kind==='version')f.payload.agent!.version++;
  const bytes=await fs.readFile(file),prepare=vi.fn(f.prepare);await runAgentMethodWorkflow(f.job,f.deviceId,async()=>{},async()=>{},{prepare});
  expect(prepare).not.toHaveBeenCalled();expect(await fs.readFile(file)).toEqual(bytes);
  expect(await methodDeliveryResult(f.job.id,f.deviceId,f.payload.workflowId)).toMatchObject({state:'needs_setup',failure:{code:'SELECTED_AGENT_NOT_READY',action:'setup-agent'},checks:[{state:'not_run'}],agent:agentMethodWorkflowAgentIdentity(f.payload.agent!)});
  await expect(fs.stat(path.join(f.root,'dispatch-count'))).rejects.toHaveProperty('code','ENOENT');
 });
 it('retains exactly the selected agent identity in the result while running the existing harmless file/check fixture once',async()=>{
  await runAgentMethodWorkflow(f.job,f.deviceId,async()=>{},async()=>{},{prepare:f.prepare});
  const result=await methodDeliveryResult(f.job.id,f.deviceId,f.payload.workflowId);expect(result).toMatchObject({state:'succeeded',checks:[{state:'passed'}]});
  expect(result.agent).toEqual(agentMethodWorkflowAgentIdentity(f.payload.agent!));expect(JSON.stringify(result.agent)).not.toContain('provider.example');
  expect(await fs.readFile(path.join(f.root,'dispatch-count'),'utf8')).toBe('1');
 },30000);
 it('fails closed when the agent file changes after coding completed and the final check returns zero',async()=>{
  const check=path.join(f.root,'check.cjs');await fs.writeFile(check,(await fs.readFile(check,'utf8'))+`require('node:fs').appendFileSync(${JSON.stringify(agentFile(f.payload.agent!.slug))},'\\nChanged after coding completed.\\n');`);
  await runAgentMethodWorkflow(f.job,f.deviceId,async()=>{},async()=>{},{prepare:f.prepare});
  const result=await methodDeliveryResult(f.job.id,f.deviceId,f.payload.workflowId);expect(result).toMatchObject({state:'needs_setup',failure:{code:'SELECTED_AGENT_NOT_READY',action:'setup-agent'},checks:[{state:'passed',exitCode:0}]});
  expect(result.changes.some(change=>change.path===agentFile(f.payload.agent!.slug))).toBe(true);
 },30000);
 it('polls the actual model mapping and stops an already running owned coding process when it changes',async()=>{
  await fs.writeFile(path.join(f.root,'runtime.cjs'),`require('node:fs').writeFileSync('runtime.started','1');setInterval(()=>{},1000);`);
  const running=runAgentMethodWorkflow(f.job,f.deviceId,async()=>{},async()=>{},{prepare:f.prepare,pollMs:100});
  await vi.waitFor(async()=>expect(await fs.readFile(path.join(f.root,'runtime.started'),'utf8')).toBe('1'),{timeout:15000});
  const config=path.join(home,'.config/opencode/opencode.json'),value=JSON.parse(await fs.readFile(config,'utf8'));value.provider.provider.options.baseURL='https://changed-during-run.example.test/v1';await fs.writeFile(config,JSON.stringify(value));
  await running;expect(await methodDeliveryResult(f.job.id,f.deviceId,f.payload.workflowId)).toMatchObject({state:'needs_setup',failure:{code:'SELECTED_AGENT_NOT_READY',action:'setup-agent'},checks:[{state:'not_run'}]});
  expect(JSON.parse(await fs.readFile(config,'utf8')).provider.provider.options.baseURL).toBe('https://changed-during-run.example.test/v1');
 },30000);
});
