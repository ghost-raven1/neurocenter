import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {configureProjectAgents} from '../src/features/project-agents/index.js';
import {createProjectAgentsPayload,renderProjectAgent,validateProjectAgentsResult,type ProjectAgent} from '../src/features/project-agents/contract.js';
import {AGENTS_RECEIPT,agentFile,agentsJournalKey} from '../src/features/project-agents/receipt.js';
import {workspaceFixture} from './bridge-fixture.js';
import {bindProject,projectBindingId,projectInstanceId} from '../src/bridge/workspace.js';
import {hash,jobContext,stateDir,writeState} from '../src/bridge/state.js';
import {deliverCompletions,pendingCompletions} from '../src/bridge/completions.js';
import {recoverFileJobs} from '../src/bridge/installation-files.js';
import {journalDirectory} from '../src/bridge/installation-journal.js';

const agent:ProjectAgent={id:'agent-review',slug:'nc-review',version:1,enabled:true,description:'Code reviewer',prompt:'Review carefully.',mode:'subagent',permission:{edit:'deny',bash:'ask'}};
const authorize=async()=>undefined,progress=async()=>undefined;
describe('Atomic project agent delivery with private ownership',()=>{
 let fixture:Awaited<ReturnType<typeof workspaceFixture>>,bindingId:string,instanceId:string;
 const file=(relative:string)=>path.join(fixture.root,relative);
 const payload=(revision=1,agents=[agent])=>createProjectAgentsPayload({schemaVersion:1,projectId:'test-project',bindingId,instanceId,revision,agents});
 const apply=(revision=1,agents=[agent],auth=authorize)=>configureProjectAgents(payload(revision,agents),auth,progress);
 beforeEach(async()=>{fixture=await workspaceFixture();bindingId=await projectBindingId('test-project');instanceId=await projectInstanceId('test-project');});
 afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(fixture.temporary,{recursive:true,force:true});});

 it('installs native agents and replays without rewriting files, private history or unrelated settings',async()=>{
  await fs.writeFile(file('opencode.jsonc'),'// user settings\n{"theme":"dark"}\n');
  await fs.mkdir(file('.opencode/agents'),{recursive:true});await fs.writeFile(file('.opencode/agents/user.md'),'Keep me');
  const result=await apply();expect(validateProjectAgentsResult(result,payload()).readiness).toBe('configured');
  expect(await fs.readFile(file(agentFile(agent.slug)),'utf8')).toBe(renderProjectAgent(agent));
  const pointer=path.join(journalDirectory(fixture.root),'assets',agentsJournalKey('test-project')+'.json'),proof=await fs.readFile(pointer,'utf8');
  const before=(await fs.stat(file(agentFile(agent.slug)))).mtimeMs;
  expect((await apply()).changed).toBe(false);expect((await fs.stat(file(agentFile(agent.slug)))).mtimeMs).toBe(before);expect(await fs.readFile(pointer,'utf8')).toBe(proof);
  expect(await fs.readFile(file('opencode.jsonc'),'utf8')).toBe('// user settings\n{"theme":"dark"}\n');expect(await fs.readFile(file('.opencode/agents/user.md'),'utf8')).toBe('Keep me');
 });
 it('edits prompt/settings, disables, reenables and removes only tracked files',async()=>{
  await apply();const edited={...agent,prompt:'Project instructions',model:'provider/model',temperature:0.2,topP:0.8,steps:5};
  await apply(2,[edited]);expect(await fs.readFile(file(agentFile(agent.slug)),'utf8')).toBe(renderProjectAgent(edited));
  await apply(3,[{...edited,enabled:false}]);expect(await fs.readFile(file(agentFile(agent.slug)),'utf8')).toContain('"disable": true');
  await apply(4,[edited]);expect(await fs.readFile(file(agentFile(agent.slug)),'utf8')).toBe(renderProjectAgent(edited));
  await fs.writeFile(file('.opencode/agents/user.md'),'manual agent');await apply(5,[]);
  await expect(fs.stat(file(agentFile(agent.slug)))).rejects.toMatchObject({code:'ENOENT'});expect(await fs.readFile(file('.opencode/agents/user.md'),'utf8')).toBe('manual agent');
  expect((await apply(5,[])).changed).toBe(false);
 });
 it('does not adopt an identical foreign file or a forged project receipt',async()=>{
  await fs.mkdir(file('.opencode/agents'),{recursive:true});await fs.writeFile(file(agentFile(agent.slug)),renderProjectAgent(agent));
  await expect(apply()).rejects.toThrow(/владения|управляется/);expect(await fs.readFile(file(agentFile(agent.slug)),'utf8')).toBe(renderProjectAgent(agent));
  await fs.rm(file(agentFile(agent.slug)));await apply();await fs.rm(journalDirectory(fixture.root),{recursive:true});
  await expect(apply(2,[{...agent,prompt:'must not replace'}])).rejects.toThrow('Квитанция');
  expect(await fs.readFile(file(agentFile(agent.slug)),'utf8')).toBe(renderProjectAgent(agent));
 });
 it.each(['update','disable','remove'])('preserves manual edits and aborts the entire set on %s',async action=>{
  await apply();const originalReceipt=await fs.readFile(file(AGENTS_RECEIPT),'utf8');await fs.writeFile(file(agentFile(agent.slug)),'Manual changes');
  const agents=action==='remove'?[]:[{...agent,enabled:action!=='disable',prompt:'Changed remotely'}];
  await expect(apply(2,agents)).rejects.toThrow('изменён вручную');expect(await fs.readFile(file(agentFile(agent.slug)),'utf8')).toBe('Manual changes');expect(await fs.readFile(file(AGENTS_RECEIPT),'utf8')).toBe(originalReceipt);
 });
 it('does not bless an empty snapshot when reserved files remain without private ownership',async()=>{
  await fs.mkdir(file('.opencode/agents'),{recursive:true});await fs.writeFile(file('.opencode/agents/nc-orphan.md'),'foreign');
  await expect(apply(1,[])).rejects.toThrow('владения');expect(await fs.readFile(file('.opencode/agents/nc-orphan.md'),'utf8')).toBe('foreign');
 });
 it.each(['legacy','jsonc','case-alias','mode-json','mode-file','frontmatter-alias','nested-alias'])('refuses a shadowing local definition: %s',async source=>{
  if(source==='legacy'){await fs.mkdir(file('.opencode/agent'),{recursive:true});await fs.writeFile(file('.opencode/agent/nc-review.md'),'legacy manual');}
  if(source==='case-alias'){await fs.mkdir(file('.opencode/agents'),{recursive:true});await fs.writeFile(file('.opencode/agents/NC-REVIEW.md'),'case alias');}
  if(source==='jsonc')await fs.writeFile(file('opencode.jsonc'),'// hand edited\n{"agent":{"nc-review":{"prompt":"manual"}}}');
  if(source==='mode-json')await fs.writeFile(file('opencode.jsonc'),'{"mode":{"nc-review":{"prompt":"manual"}}}');
  if(source==='mode-file'){await fs.mkdir(file('.opencode/modes'));await fs.writeFile(file('.opencode/modes/nc-review.md'),'legacy mode');}
  if(source==='frontmatter-alias'){await fs.mkdir(file('.opencode/agents'));await fs.writeFile(file('.opencode/agents/manual.md'),'---\nname: nc-review\n---\nmanual');}
  if(source==='nested-alias'){await fs.mkdir(file('.opencode/agents/nested'),{recursive:true});await fs.writeFile(file('.opencode/agents/nested/manual.md'),'---\nname: nc-review\n---\nmanual');}
  await expect(apply()).rejects.toThrow(/агент|Имя/);await expect(fs.stat(file(AGENTS_RECEIPT))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('rejects malformed JSON, symlinks and non-regular native targets before writing',async()=>{
  await fs.writeFile(file('opencode.jsonc'),'{not-json');await expect(apply()).rejects.toThrow('JSON');await fs.rm(file('opencode.jsonc'));
  const outside=path.join(fixture.temporary,'outside');await fs.mkdir(outside);await fs.symlink(outside,file('.opencode/agents'));
  await expect(apply()).rejects.toThrow('симлинк');expect(await fs.readdir(outside)).toEqual([]);await fs.rm(file('.opencode/agents'));
  await fs.mkdir(file(agentFile(agent.slug)),{recursive:true});await expect(apply()).rejects.toThrow();
 });
 it('rejects stale project tuples/revisions and a second payload for the same revision',async()=>{
  await apply(2);await expect(apply(1)).rejects.toThrow('устарели');await expect(apply(2,[{...agent,prompt:'different'}])).rejects.toThrow('устарели');
  await expect(configureProjectAgents({...payload(3),bindingId:'b'.repeat(64)},authorize,progress)).rejects.toThrow('конфигурация');
  const {manifestSha256:_manifest,...body}=payload(3);
  const wrong=createProjectAgentsPayload({...body,bindingId:'b'.repeat(64)});await expect(configureProjectAgents(wrong,authorize,progress)).rejects.toThrow('устарели');
 });
 it('authorization loss and same-byte inode replacement are caught before commit',async()=>{
  await apply();const before=await fs.readFile(file(AGENTS_RECEIPT),'utf8');
  await expect(apply(2,[{...agent,prompt:'denied'}],async()=>{throw Error('revoked');})).rejects.toThrow('revoked');expect(await fs.readFile(file(AGENTS_RECEIPT),'utf8')).toBe(before);
  let replaced=false;await expect(apply(2,[{...agent,prompt:'pending'}],async()=>{if(!replaced){replaced=true;await fs.rename(file(agentFile(agent.slug)),file('original.md'));await fs.writeFile(file(agentFile(agent.slug)),renderProjectAgent(agent));}})).rejects.toThrow('изменился');
  expect(await fs.readFile(file(AGENTS_RECEIPT),'utf8')).toBe(before);
 });
 it('rolls back a partial two-agent filesystem failure without a false receipt',async()=>{
  const second={...agent,id:'agent-z',slug:'nc-z'},link=fs.link.bind(fs);let failed=false;
  vi.spyOn(fs,'link').mockImplementation(async(from,to)=>{if(!failed&&to===file(agentFile(second.slug))){failed=true;throw Object.assign(Error('write denied'),{code:'EACCES'});}return link(from,to);});
  await expect(apply(1,[agent,second])).rejects.toThrow('write denied');await expect(fs.stat(file(agentFile(agent.slug)))).rejects.toMatchObject({code:'ENOENT'});await expect(fs.stat(file(AGENTS_RECEIPT))).rejects.toMatchObject({code:'ENOENT'});
  await expect(apply(1,[agent,second])).resolves.toMatchObject({changed:true});
 });
 it('keeps the exact durable success across lost ACK and only redelivers completion',async()=>{
  const context={id:randomUUID(),lease:randomUUID(),deviceId:randomUUID()};await writeState('credentials',{deviceId:context.deviceId,token:'fixture',email:'owner@example.test'});
  const result=await jobContext.run(context,()=>apply());const pending=await pendingCompletions();expect(pending).toHaveLength(1);expect(pending[0]!.result).toEqual(result);
  const before=await fs.stat(file(agentFile(agent.slug)));await expect(deliverCompletions(async()=>{throw Error('network');})).rejects.toThrow('network');
  await recoverFileJobs();const delivered:unknown[]=[];await deliverCompletions(async value=>{delivered.push(value);});expect(delivered).toEqual(pending);expect(await pendingCompletions()).toEqual([]);expect((await fs.stat(file(agentFile(agent.slug)))).mtimeMs).toBe(before.mtimeMs);
 });
 it('recovers committed file changes after private history publication failed',async()=>{
  const link=fs.link.bind(fs);let failed=false;vi.spyOn(fs,'link').mockImplementation(async(from,to)=>{if(!failed&&String(to).includes('/history/')){failed=true;throw Error('archive temporarily unavailable');}return link(from,to);});
  await expect(jobContext.run({id:randomUUID(),lease:randomUUID()},()=>apply())).rejects.toMatchObject({localChangesCommitted:true});
  expect(await fs.readFile(file(agentFile(agent.slug)),'utf8')).toBe(renderProjectAgent(agent));await recoverFileJobs();expect((await pendingCompletions())[0]!.state).toBe('succeeded');expect((await apply()).changed).toBe(false);
 });
 it.each(['partial','committed'])('recovers an actual SIGKILL at the %s transaction boundary',async boundary=>{
  const context={id:randomUUID(),lease:randomUUID(),deviceId:randomUUID()},target=boundary==='partial'?file(agentFile(agent.slug)):path.join(journalDirectory(fixture.root),'history');
  const feature=new URL('../src/features/project-agents/index.ts',import.meta.url).href,bridge=new URL('../src/bridge/state.ts',import.meta.url).href;
  const source=`import fs from 'node:fs/promises';import {configureProjectAgents} from ${JSON.stringify(feature)};import {jobContext} from ${JSON.stringify(bridge)};const link=fs.link.bind(fs);fs.link=async function(from,to){if(${boundary==='partial'?`to===${JSON.stringify(target)}`:`String(to).startsWith(${JSON.stringify(target+'/')})`}){${boundary==='partial'?'await link(from,to);':''}process.kill(process.pid,'SIGKILL');}return link(from,to);};await jobContext.run(${JSON.stringify(context)},()=>configureProjectAgents(${JSON.stringify(payload())},async()=>undefined,async()=>undefined));`;
  const child=spawn(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),'--input-type=module','-e',source],{env:process.env,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  const exit=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});expect(exit.signal,stderr).toBe('SIGKILL');
  await recoverFileJobs();const pending=await pendingCompletions();expect(pending).toHaveLength(1);expect(pending[0]!.state).toBe(boundary==='partial'?'failed':'succeeded');
  if(boundary==='partial'){
   await expect(fs.stat(file(agentFile(agent.slug)))).rejects.toMatchObject({code:'ENOENT'});expect(pending[0]!.result).toEqual({});
   const {assertAgentConfigurationResult}=await import('../../../services/catalog-service/src/agents/agent-jobs.ts');
   expect(()=>assertAgentConfigurationResult({kind:'configure-project-agents',project_id:'test-project',payload:payload()},pending[0]!.result,true)).not.toThrow();
  }
  else{expect(await fs.readFile(file(agentFile(agent.slug)),'utf8')).toBe(renderProjectAgent(agent));expect(validateProjectAgentsResult(pending[0]!.result,payload()).readiness).toBe('configured');expect((await apply()).changed).toBe(false);}
 },15000);
 it('reconnects a deleted whole .opencode and reinstalls from private proof without removing the bridge',async()=>{
  const credentials={deviceId:randomUUID(),token:'preserve-device',email:'owner@example.test'};await writeState('credentials',credentials);await apply();
  const credentialsBefore=await fs.readFile(path.join(stateDir(),'credentials.json'),'utf8');await fs.rm(file('.opencode'),{recursive:true});await expect(apply()).rejects.toThrow();
  await bindProject('test-project',path.basename(fixture.root));expect(await projectBindingId('test-project')).toBe(bindingId);expect(await projectInstanceId('test-project')).toBe(instanceId);
  await expect(apply()).resolves.toMatchObject({changed:true});expect(await fs.readFile(path.join(stateDir(),'credentials.json'),'utf8')).toBe(credentialsBefore);
 });
 it('does not hide individual file deletion or a missing receipt with surviving local files',async()=>{
  await apply();await fs.rm(file(agentFile(agent.slug)));await expect(apply(2)).rejects.toThrow('удалён');
  await fs.writeFile(file(agentFile(agent.slug)),renderProjectAgent(agent));await fs.rm(file(AGENTS_RECEIPT));await expect(apply(2)).rejects.toThrow('Квитанция агентов удалена');
 });
});
