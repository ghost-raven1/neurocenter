import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {workspaceFixture} from './bridge-fixture.js';
import {isolateAgentHome} from './project-agents.fixture.js';
import {projectBindingId,projectInstanceId} from '../src/bridge/workspace.js';
import {configureProjectAgents} from '../src/features/project-agents/index.js';
import {projectAgentsFailureResult,projectAgentMappings} from '../src/features/project-agents/model-compiler.js';
import {createProjectAgentsPayload,compileProjectAgents,renderProjectAgent,type ProjectAgent} from '../src/features/project-agents/contract.js';
import {agentFile} from '../src/features/project-agents/receipt.js';
import {ollamaAdapterUrl} from '../src/features/opencode-providers/ollama-entry.js';

const agent:ProjectAgent={id:'agent-model',slug:'nc-model',version:1,enabled:true,description:'QA',prompt:'Preserve prompt.',mode:'subagent',permission:{bash:'deny'},model:'neurocenter/model-chat'};
describe('Private native model compilation and cross-scope namespace',()=>{
 let f:Awaited<ReturnType<typeof workspaceFixture>>,home:string,bindingId:string,instanceId:string;
 const global=()=>path.join(home,'.config/opencode/opencode.json');
 const config=(patch:Record<string,unknown>={})=>({provider:{team:{npm:'@ai-sdk/openai-compatible',options:{baseURL:'https://provider.example.test/v1',apiKey:'{file:DO_NOT_READ}'},models:{alias:{id:'upstream-chat',limit:{context:128000},options:{temperature:0}}}}},...patch});
 const payload=()=>createProjectAgentsPayload({schemaVersion:2,projectId:'test-project',bindingId,instanceId,revision:1,agents:[agent],modelRequirements:[{kind:'catalog',agentId:agent.id,catalogModelId:'model-chat',modelPin:'d'.repeat(64),runtime:'remote-openai',runtimeModel:'upstream-chat',baseUrl:'https://provider.example.test/v1',options:{temperature:0,contextWindow:128000},capability:'chat'}]});
 const apply=async(authorize=async()=>undefined)=>{const p=payload();return configureProjectAgents(p,authorize,async()=>undefined,async mappings=>compileProjectAgents(p,mappings));};
 beforeEach(async()=>{f=await workspaceFixture();home=await isolateAgentHome(f.temporary);bindingId=await projectBindingId('test-project');instanceId=await projectInstanceId('test-project');await fs.writeFile(global(),JSON.stringify(config()));});
 afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(f.temporary,{recursive:true,force:true});});
 it('compiles one exact configured alias and never resolves local credential files or reads auth.json',async()=>{
  const auth=path.join(home,'.local/share/opencode/auth.json');await fs.mkdir(path.dirname(auth),{recursive:true});await fs.writeFile(auth,'not JSON and PRIVATE');
  await fs.symlink('/must-not-be-read',path.join(home,'.config/opencode/DO_NOT_READ'));
  const result=await apply();expect(result.schemaVersion).toBe(2);expect(result.compiledManifestSha256).toMatch(/^[a-f0-9]{64}$/);
  const rendered=await fs.readFile(path.join(f.root,agentFile(agent.slug)),'utf8');expect(rendered).toContain('"model": "team/alias"');expect(rendered).not.toContain('neurocenter/model-chat');expect(rendered).toContain(agent.prompt);expect(JSON.stringify(result)).not.toContain('PRIVATE');
 });
 it.each(['codex','loopback'])('native %s is usable on its own computer while server import remains blocked',async kind=>{
  const provider=kind==='codex'?'codexbridge':'team',options=kind==='codex'?{reasoningEffort:'high',store:false}:{};
  await fs.writeFile(global(),JSON.stringify({provider:{[provider]:{npm:kind==='codex'?'@ai-sdk/openai':'@ai-sdk/openai-compatible',options:{baseURL:kind==='codex'?'https://chatgpt.com/backend-api/codex':'http://127.0.0.1:1234/v1'},models:{alias:{id:'upstream-chat',options}}}}}));
  const native={...agent,model:provider+'/alias'},p=createProjectAgentsPayload({schemaVersion:2,projectId:'test-project',bindingId,instanceId,revision:1,agents:[native],modelRequirements:[{kind:'native',agentId:agent.id,selector:native.model}]});
  const mappings=await projectAgentMappings(p,f.root,async()=>undefined);expect(mappings[0]!.provider).toBe(provider);
  if(kind==='codex')expect(mappings[0]!.options).toEqual({apiFormat:'responses',reasoningEffort:'high',store:false});
  await configureProjectAgents(p,async()=>undefined,async()=>undefined,async value=>compileProjectAgents(p,value));
  expect(await fs.readFile(path.join(f.root,agentFile(agent.slug)),'utf8')).toContain('"model": "'+provider+'/alias"');
 });
 it.each(['exact','model','url','options','transport','namespace'])('catalog Ollama %s keeps native transport and exact pinned correspondence on the chosen computer',async issue=>{
  const provider=issue==='namespace'?'manual-ollama':'neurocenter-ollama-'+'a'.repeat(16),c={provider:{[provider]:{npm:issue==='transport'?'@ai-sdk/openai-compatible':ollamaAdapterUrl,
   options:{baseURL:issue==='url'?'http://127.0.0.1:11435':'http://127.0.0.1:11434'},models:{alias:{id:issue==='model'?'wrong-model':'qwen3:8b',limit:{context:8192},options:{temperature:issue==='options'?0.9:0,contextWindow:8192}}}}}};
  await fs.writeFile(global(),JSON.stringify(c));
  const p=createProjectAgentsPayload({schemaVersion:2,projectId:'test-project',bindingId,instanceId,revision:1,agents:[agent],modelRequirements:[{kind:'catalog',agentId:agent.id,catalogModelId:'model-chat',modelPin:'d'.repeat(64),runtime:'remote-ollama',runtimeModel:'qwen3:8b',baseUrl:'http://127.0.0.1:11434',options:{temperature:0,contextWindow:8192},capability:'chat'}]});
  if(issue!=='exact'){await expect(projectAgentMappings(p,f.root,async()=>undefined)).rejects.toHaveProperty('code','OPENCODE_AGENT_MODEL_SETUP_REQUIRED');return;}
  const mappings=await projectAgentMappings(p,f.root,async()=>undefined);expect(mappings).toEqual([expect.objectContaining({provider,runtime:'remote-ollama',model:'qwen3:8b',baseUrl:'http://127.0.0.1:11434'})]);
  expect(compileProjectAgents(p,mappings).mappings).toEqual(mappings);
 });
 it.each(['exact','model','url','options','transport','selector'])('catalog device Codex %s keeps the catalogue pin and exact native source selector',async issue=>{
  const provider=issue==='selector'?'other-codex':'codexbridge';
  await fs.writeFile(global(),JSON.stringify({provider:{[provider]:{npm:issue==='transport'?'@ai-sdk/openai-compatible':'@ai-sdk/openai',options:{baseURL:issue==='url'?'https://another.example.test/v1':'https://chatgpt.com/backend-api/codex'},models:{alias:{id:issue==='model'?'wrong-model':'qa-codex',options:{reasoningEffort:issue==='options'?'low':'high',store:false}}}}}}));
  const p=createProjectAgentsPayload({schemaVersion:2,projectId:'test-project',bindingId,instanceId,revision:1,agents:[agent],modelRequirements:[{
   kind:'catalog',agentId:agent.id,catalogModelId:'model-chat',modelPin:'d'.repeat(64),runtime:'device-codex',runtimeModel:'qa-codex',baseUrl:'https://chatgpt.com/backend-api/codex',options:{apiFormat:'responses',reasoningEffort:'high',store:false},capability:'chat',sourceSelector:'codexbridge/alias',
  }]});
  if(issue!=='exact'){await expect(projectAgentMappings(p,f.root,async()=>undefined)).rejects.toHaveProperty('code','OPENCODE_AGENT_MODEL_SETUP_REQUIRED');return;}
  const mappings=await projectAgentMappings(p,f.root,async()=>undefined);expect(mappings).toEqual([expect.objectContaining({provider:'codexbridge',configKey:'alias',runtime:'remote-openai',model:'qa-codex'})]);
  expect(compileProjectAgents(p,mappings).mappings).toEqual(mappings);
  await configureProjectAgents(p,async()=>undefined,async()=>undefined,async value=>compileProjectAgents(p,value));
  expect(await fs.readFile(path.join(f.root,agentFile(agent.slug)),'utf8')).toContain('"model": "codexbridge/alias"');
  expect(p.agents[0]!.model).toBe('neurocenter/model-chat');expect(p.modelRequirements[0]).toHaveProperty('modelPin','d'.repeat(64));
 });
 it('an unknown native SDK parameter is diagnosed without exporting its value or pretending compilation succeeded',async()=>{
  const privateValue='PRIVATE_NATIVE_PARAMETER';
  await fs.writeFile(global(),JSON.stringify({provider:{codexbridge:{npm:'@ai-sdk/openai',options:{baseURL:'https://chatgpt.com/backend-api/codex'},models:{alias:{options:{custom:{value:privateValue}}}}}}}));
  const native={...agent,model:'codexbridge/alias'},p=createProjectAgentsPayload({schemaVersion:2,projectId:'test-project',bindingId,instanceId,revision:1,agents:[native],modelRequirements:[{kind:'native',agentId:agent.id,selector:native.model}]});
  const error=await projectAgentMappings(p,f.root,async()=>undefined).catch(value=>value);expect(projectAgentsFailureResult(error)).toHaveProperty('code','OPENCODE_AGENT_MODEL_SETUP_REQUIRED');expect(JSON.stringify(projectAgentsFailureResult(error))).not.toContain(privateValue);
  await expect(fs.stat(path.join(f.root,agentFile(agent.slug)))).rejects.toHaveProperty('code','ENOENT');expect(await fs.readFile(global(),'utf8')).toContain(privateValue);
 });
 it('catalog/native Responses correspondence includes protocol, reasoning and store=false exactly',async()=>{
  await fs.writeFile(global(),JSON.stringify({provider:{team:{npm:'@ai-sdk/openai',options:{baseURL:'https://provider.example.test/v1'},models:{alias:{id:'upstream-chat',options:{reasoningEffort:'high',store:false}}}}}}));
  const base=payload(),{manifestSha256:_manifest,compilation:_compilation,...body}=base;
  const p=createProjectAgentsPayload({...body,modelRequirements:body.modelRequirements.map(requirement=>requirement.kind==='catalog'?{...requirement,options:{apiFormat:'responses',reasoningEffort:'high',store:false}}:requirement)});
  const mappings=await projectAgentMappings(p,f.root,async()=>undefined);expect(mappings[0]!.options).toEqual({apiFormat:'responses',reasoningEffort:'high',store:false});expect(compileProjectAgents(p,mappings).mappings).toEqual(mappings);
  await fs.writeFile(global(),JSON.stringify({provider:{team:{npm:'@ai-sdk/openai',options:{baseURL:'https://provider.example.test/v1'},models:{alias:{id:'upstream-chat',options:{reasoningEffort:'high',store:true}}}}}}));
  await expect(projectAgentMappings(p,f.root,async()=>undefined)).rejects.toHaveProperty('code','OPENCODE_AGENT_MODEL_SETUP_REQUIRED');
 });
 it.each(['absent','ambiguous','disabled','options','malformed'])('rejects %s correspondence with actionable public guidance and no file write',async issue=>{
  const c=config() as any;if(issue==='absent')c.provider={};if(issue==='ambiguous')c.provider.team.models.second={...c.provider.team.models.alias};if(issue==='disabled')c.disabled_providers=['team'];if(issue==='options')c.provider.team.models.alias.limit.context=4096;if(issue==='malformed'){await fs.writeFile(global(),'{invalid');}else await fs.writeFile(global(),JSON.stringify(c));
  let error:unknown;try{await apply();}catch(cause){error=cause;}expect(projectAgentsFailureResult(error)).toMatchObject({code:'OPENCODE_AGENT_MODEL_SETUP_REQUIRED',agentId:agent.id,action:'sync-opencode-models'});
  await expect(fs.stat(path.join(f.root,agentFile(agent.slug)))).rejects.toHaveProperty('code','ENOENT');
 });
 it('a provider change after approval is caught before commit and previous files survive',async()=>{
  await apply();const file=path.join(f.root,agentFile(agent.slug)),before=await fs.readFile(file,'utf8'),p=payload();p.revision=2;
  const {manifestSha256:_manifest,compilation:_compilation,...body}=p;const next=createProjectAgentsPayload({...body,agents:[{...agent,prompt:'new prompt'}]});
  await expect(configureProjectAgents(next,async()=>undefined,async()=>undefined,async mappings=>{const approved=compileProjectAgents(next,mappings);await fs.writeFile(global(),JSON.stringify(config({disabled_providers:['team']})));return approved;})).rejects.toHaveProperty('code','OPENCODE_AGENT_MODEL_SETUP_REQUIRED');expect(await fs.readFile(file,'utf8')).toBe(before);
 });
 it.each(['xdg-markdown','home-markdown','custom-markdown','inline-global','inline-env','frontmatter'])('refuses an actual global shadow definition: %s',async source=>{
  if(source==='inline-global')await fs.writeFile(global(),JSON.stringify(config({agent:{'nc-model':{prompt:'global'}}})));
  else if(source==='inline-env')vi.stubEnv('OPENCODE_CONFIG_CONTENT',JSON.stringify({agent:{'nc-model':{prompt:'inline'}}}));
  else{const directory=source==='home-markdown'?path.join(home,'.opencode/agent'):source==='custom-markdown'?path.join(home,'custom/agents'):path.join(home,'.config/opencode/agents');await fs.mkdir(directory,{recursive:true});if(source==='custom-markdown')vi.stubEnv('OPENCODE_CONFIG_DIR',path.dirname(directory));await fs.writeFile(path.join(directory,source==='frontmatter'?'manual.md':'nc-model.md'),source==='frontmatter'?'---\nname: nc-model\n---\nManual':'Manual');}
  await expect(apply()).rejects.toHaveProperty('code','AGENTS_LOCAL_CONFLICT');await expect(fs.stat(path.join(f.root,agentFile(agent.slug)))).rejects.toHaveProperty('code','ENOENT');
 });
 it('a canonical catalogue reference can never be rendered directly',()=>{expect(()=>renderProjectAgent(agent)).toThrow();});
});
