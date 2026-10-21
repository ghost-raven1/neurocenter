import {describe,expect,it} from 'vitest';
import yaml from 'js-yaml';
import {serializeAsset,toAgentRecord,validateAsset} from '@neurocenter/asset-contract';
import {hash} from '../src/bridge/state.js';
import {AGENT_PERMISSION_KEYS,PROJECT_AGENTS_NOTE,agentDefinitionDigest,normalizeAgentDefinition,createProjectAgentsPayload,
    normalizeProjectAgentsPayload,renderProjectAgent,validateProjectAgentsResult,type ProjectAgent} from '../src/features/project-agents/contract.js';

const definition={description:'Reviews code',prompt:'Read the code and explain defects.',mode:'subagent' as const,permission:{edit:'deny' as const,bash:'ask' as const}};
const agent:ProjectAgent={id:'agent-review',slug:'nc-review',version:1,enabled:true,...definition};
const base={schemaVersion:1 as const,projectId:'project',bindingId:'a'.repeat(64),instanceId:'11111111-1111-4111-8111-111111111111',revision:1,agents:[agent]};
const result=()=>{const payload=createProjectAgentsPayload(base);return{schemaVersion:1 as const,projectId:payload.projectId,bindingId:payload.bindingId,instanceId:payload.instanceId,
    revision:payload.revision,manifestSha256:payload.manifestSha256,agents:[{id:agent.id,slug:agent.slug,version:1,enabled:true,sha256:hash(renderProjectAgent(agent))}],changed:true,
    readiness:'configured' as const,checkedAt:'2026-10-21T00:00:00.000Z',note:PROJECT_AGENTS_NOTE};};

describe('Shared native agent contract',()=>{
 it('pins canonical definitions and complete snapshots independent of object/agent order',()=>{
  expect(agentDefinitionDigest(definition)).toBe(agentDefinitionDigest({...definition,permission:{bash:'ask',edit:'deny'}}));
  const other={...agent,id:'agent-a',slug:'nc-other'};
  expect(createProjectAgentsPayload({...base,agents:[agent,other]})).toEqual(createProjectAgentsPayload({...base,agents:[other,agent]}));
  const payload=createProjectAgentsPayload(base);expect(normalizeProjectAgentsPayload(payload)).toEqual(payload);
  payload.agents[0]!.prompt='Changed';expect(()=>normalizeProjectAgentsPayload(payload)).toThrow('конфигурация');
 });
 it('separates UTF8 prompt body from JSON-safe native YAML frontmatter',()=>{
  const rendered=renderProjectAgent({...agent,description:'A: value "quoted" --- model: body-only',prompt:'---\nmodel: body-only\n!`do-not-run`',model:'provider/model',temperature:0,topP:1,steps:7});
  const boundary=rendered.indexOf('\n---\n',4),header=yaml.load(rendered.slice(4,boundary)) as Record<string,unknown>;
  expect(header).toEqual({description:'A: value "quoted" --- model: body-only',mode:'subagent',disable:false,permission:{bash:'ask',edit:'deny'},model:'provider/model',temperature:0,top_p:1,steps:7});
  expect(rendered.slice(boundary+6)).toContain('---\nmodel: body-only');expect(header.prompt).toBeUndefined();
 });
 it.each(['primary','subagent','all'])('supports native mode %s and actual disable flag',mode=>{
  expect(renderProjectAgent({...agent,mode:mode as ProjectAgent['mode'],enabled:false})).toContain('"disable": true');
 });
 it('uses pinned bash permission and rejects deprecated tools/newer shell spelling',()=>{
  expect(AGENT_PERMISSION_KEYS).toContain('bash');expect(AGENT_PERMISSION_KEYS).not.toContain('shell');
  expect(()=>normalizeAgentDefinition({...definition,permission:{shell:'deny'}})).toThrow();
  expect(()=>normalizeAgentDefinition({...definition,tools:{edit:false}})).toThrow();
 });
 it.each([{prompt:''},{prompt:'x'.repeat(65537)},{prompt:'\ud800'},{prompt:'text\0secret'},{description:'x'.repeat(1025)},{description:'line\n---\nmodel: injected'},
  {mode:'custom'},{permission:[]},{permission:{edit:'yes'}},{permission:{bash:{'*':'allow'}}},{model:'https://host/model'},
  {model:'provider/model?key=secret'},{model:'{env:KEY}'},{temperature:Infinity},{temperature:-1},{topP:2},{steps:0},{steps:1001}])('rejects malformed definition %j',patch=>{
   expect(()=>normalizeAgentDefinition({...definition,...patch})).toThrow('конфигурация');
 });
 it.each(['bindingId','instanceId','manifestSha256'])('rejects array/object coercion for %s',key=>{
  const payload=createProjectAgentsPayload(base),value=payload[key as keyof typeof payload];
  for(const invalid of [[value],{value}])expect(()=>normalizeProjectAgentsPayload({...payload,[key]:invalid})).toThrow('конфигурация');
 });
 it('rejects builtin names, paths, duplicate IDs, case aliases, oversized sets and exhausted receipt budget',()=>{
  for(const slug of ['build','plan','nc-../outside','nc-Review','nc-a/b'])expect(()=>createProjectAgentsPayload({...base,agents:[{...agent,slug}]})).toThrow();
  expect(()=>createProjectAgentsPayload({...base,agents:[agent,agent]})).toThrow();
  expect(()=>createProjectAgentsPayload({...base,agents:[agent,{...agent,id:'second'}]})).toThrow();
  expect(()=>createProjectAgentsPayload({...base,agents:Array.from({length:33},(_,index)=>({...agent,id:'a'+index,slug:'nc-a'+index}))})).toThrow();
  expect(()=>createProjectAgentsPayload({...base,agents:Array.from({length:32},(_,index)=>({...agent,id:'a'+index+'x'.repeat(190),slug:'nc-a'+index+'x'.repeat(50)}))})).toThrow();
 });
 it('permits 32 ordinary long names while preserving a compact durable success result',()=>{
  const agents=Array.from({length:32},(_,index)=>({...agent,id:'agent-'+String(index).padStart(2,'0')+'x'.repeat(30),slug:'nc-'+String(index).padStart(2,'0')+'-reviewer-with-readable-name'}));
  const payload=createProjectAgentsPayload({...base,agents});expect(payload.agents).toHaveLength(32);
  const receipt={...result(),manifestSha256:payload.manifestSha256,agents:payload.agents.map(item=>({id:item.id,slug:item.slug,version:item.version,enabled:item.enabled,sha256:hash(renderProjectAgent(item))}))};
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(10000);expect(validateProjectAgentsResult(receipt,payload).agents).toHaveLength(32);
 });
 it('counts the manifest envelope in the two-MiB polling payload limit',()=>{
  const initial=createProjectAgentsPayload({...base,agents:Array.from({length:32},(_,index)=>({...agent,id:'agent-'+index,slug:'nc-a'+index,prompt:'x'.repeat(65000)}))});
  const {manifestSha256:_manifest,...body}=initial;let remaining=2*1024*1024-1-Buffer.byteLength(JSON.stringify(body));
  for(const item of body.agents){const extra=Math.min(65536-item.prompt.length,remaining);item.prompt+='x'.repeat(extra);remaining-=extra;}
  expect(remaining).toBe(0);expect(Buffer.byteLength(JSON.stringify(body))).toBe(2*1024*1024-1);expect(()=>createProjectAgentsPayload(body)).toThrow();
 });
 it.each([{changed:'true'},{readiness:'ready'},{revision:2},{manifestSha256:'b'.repeat(64)},{note:'untrusted prompt'},{checkedAt:'not-a-date'},
  {rolledBack:true},{rolledBack:false},{agents:[]},{recoveryPath:'bad\0path'}])('refuses a stale, changed or rolled-back success receipt %j',patch=>{
   expect(()=>validateProjectAgentsResult({...result(),...patch},createProjectAgentsPayload(base))).toThrow('конфигурация');
 });
 it('retains exact disabled SHA and permits removal through an empty desired set',()=>{
  const disabled=createProjectAgentsPayload({...base,agents:[{...agent,enabled:false}]});
  expect(disabled.manifestSha256).not.toBe(createProjectAgentsPayload(base).manifestSha256);
  expect(createProjectAgentsPayload({...base,agents:[]}).agents).toEqual([]);
 });
 it('roundtrips the pinned source producer into the native projection at shared limits',()=>{
  for(const mode of ['primary','subagent','all'] as const){
   const source={schemaVersion:1,id:'agent-fixture',kind:'agent',version:'1.0.0',source:{type:'archive',sha256:'a'.repeat(64),bytes:1},license:{spdx:'UNLICENSED'},compatibility:{bridgeProtocol:2},
    card:{id:'agent-fixture',slug:'nc-'+ 'a'.repeat(61),name:'Fixture',definition:{description:'Quoted: "description"',prompt:'---\nmode: injected\n'+ 'я'.repeat(100),mode,permission:Object.fromEntries(AGENT_PERMISSION_KEYS.map(key=>[key,'ask'])),model:'provider/'+ 'a'.repeat(191),temperature:2,topP:1,steps:1000}},delivery:{type:'inline'}};
   const before=serializeAsset(validateAsset(source)),projected=toAgentRecord(JSON.parse(before));
   const definition=normalizeAgentDefinition(projected.definition),native={id:projected.id,slug:projected.slug,version:1,enabled:true,...definition} as ProjectAgent;
   const payload=createProjectAgentsPayload({...base,agents:[native]});expect(payload.agents[0]).toEqual(native);
   const rendered=renderProjectAgent(native),boundary=rendered.indexOf('\n---\n',4),header=yaml.load(rendered.slice(4,boundary)) as Record<string,unknown>;
   expect(header).toMatchObject({mode,model:source.card.definition.model,steps:1000,disable:false,permission:source.card.definition.permission});
   expect(rendered.slice(boundary+6)).toBe(source.card.definition.prompt+'\n');expect(serializeAsset(source)).toBe(before);
  }
 });
});
