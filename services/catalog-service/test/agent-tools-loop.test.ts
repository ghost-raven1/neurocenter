import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {AgentToolsLoop} from '../src/agent-tools/agent-tools.loop';
import {agentToolAction,agentToolGrant} from '../src/agent-tools/agent-tools.validation';
import type {AgentToolsRepository} from '../src/agent-tools/agent-tools.repository';
import type {AgentToolOwner,AgentToolScope,AgentToolStepRow} from '../src/agent-tools/agent-tools.types';
const defer=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};};
const grant={protocol:'json-actions-v1' as const,rag:true};
const owner=():AgentToolOwner=>({kind:'model-chat',originId:randomUUID(),turnId:randomUUID(),recipientId:randomUUID(),generation:randomUUID(),ownerEmail:'agent@fixture.test',actorRole:'Разработчик',projectId:'prj-owned',agentId:null,modelId:'model-fixture',modelPin:'a'.repeat(64),grant});
function fixture(){
 const steps=new Map<number,AgentToolStepRow>(),abort=new AbortController();let current=true;
 const assertCurrent=vi.fn(async()=>{if(!current)throw Error('Current grant revoked');abort.signal.throwIfAborted();});
 const repository={reserve:vi.fn(async(o:AgentToolOwner,n:number,action:string,input:Record<string,unknown>)=>{
  if(steps.has(n))return steps.get(n)!;
  const row={id:randomUUID(),sequence:n,action,input,state:'queued',output:null,grant_snapshot:o.grant} as AgentToolStepRow;steps.set(n,row);return row;
 }),dispatch:vi.fn(async(id:string,authorize:()=>Promise<void>)=>{await authorize();const row=[...steps.values()].find(row=>row.id===id)!;if(row.state!=='queued')throw Error('Already dispatched');row.state='dispatched';return row;}),
 complete:vi.fn(async(id:string,output:unknown,authorize:()=>Promise<void>)=>{await authorize();const row=[...steps.values()].find(row=>row.id===id)!;row.state='succeeded';row.output=output;return row;}),
 abandonQueued:vi.fn(async()=>{}),interrupted:vi.fn(async(id:string)=>{const row=[...steps.values()].find(row=>row.id===id)!;if(row.state==='dispatched')row.state='unknown';}),reference:vi.fn()};
 const scope:AgentToolScope={owner:owner(),messages:[{role:'user',content:'Проверь проект'}],settings:{contextWindowTokens:32768,reservedOutputTokens:1024},signal:abort.signal,assertCurrent,
  infer:vi.fn(async()=>JSON.stringify({action:'finish'})),execute:vi.fn(async()=>({status:'ready'}))};
 const feature=vi.fn(async()=>{}),loop=new AgentToolsLoop(repository as unknown as AgentToolsRepository,feature);
 return{loop,scope,steps,repository,feature,abort,revoke:()=>{current=false;}};
}
describe('Explicit agent tools loop',()=>{
 it.each([false,true])('places the planner contract after profile instructions and leaves final answer instructions intact, project metadata first=%s',async metadataFirst=>{
  const f=fixture();f.scope.messages.unshift({role:'system',content:'Ты ревьювер. Ответь пользователю текстом.'},{role:'system',content:'Ответь на текущее сообщение пользователя.'});
  if(metadataFirst)f.scope.messages.unshift({role:'user',content:'Справочные данные проекта'});
  const result=await f.loop.run(f.scope),planned=vi.mocked(f.scope.infer).mock.calls[0][0];
  expect(planned.filter(message=>message.role==='system').at(-1)?.content).toContain('json-actions-v1');
  expect(planned.filter(message=>message.role==='user').slice(0,-1)).toEqual(f.scope.messages.filter(message=>message.role==='user'));
  expect(result.filter(message=>message.role==='system')).toEqual(f.scope.messages.filter(message=>message.role==='system'));
  expect(f.scope.infer).toHaveBeenCalledOnce();expect(f.scope.execute).not.toHaveBeenCalled();
 });
 it('accepts a complete fenced finish without a repair request or a tool call',async()=>{
  const f=fixture();vi.mocked(f.scope.infer).mockResolvedValue('```json\n{"action":"finish"}\n```');
  const result=await f.loop.run(f.scope);expect(result.at(-1)?.content).toContain('Дай самостоятельный ответ');
  expect(f.scope.infer).toHaveBeenCalledOnce();expect(f.scope.execute).not.toHaveBeenCalled();expect(f.steps.get(1)?.state).toBe('succeeded');
 });
 it('does not turn a plain reply into a tool or silently replay it',async()=>{
  const f=fixture();vi.mocked(f.scope.infer).mockResolvedValue('Привет!');
  await expect(f.loop.run(f.scope)).rejects.toThrow('Модель вернула ответ не в формате JSON');
  await expect(f.loop.run(f.scope)).rejects.toThrow('Прежний вызов');
  expect(f.scope.infer).toHaveBeenCalledOnce();expect(f.scope.execute).not.toHaveBeenCalled();
 });
 it('dispatches a real allowed callback once and supplies its sources to the final answer context',async()=>{
  const f=fixture();vi.mocked(f.scope.infer).mockResolvedValueOnce(JSON.stringify({action:'rag_search',query:'ledger'})).mockResolvedValueOnce(JSON.stringify({action:'finish'}));
  vi.mocked(f.scope.execute).mockResolvedValue({sources:[{id:'source',path:'src/index.ts',excerpt:'confirmed source'}]});
  const messages=await f.loop.run(f.scope);expect(f.scope.infer).toHaveBeenCalledTimes(2);expect(f.scope.execute).toHaveBeenCalledOnce();
  expect([...f.steps.values()].map(row=>row.state)).toEqual(['succeeded','succeeded','succeeded']);expect(JSON.stringify(messages)).toContain('confirmed source');
  expect(JSON.stringify(messages)).toContain('mcp');expect(JSON.stringify(messages)).toContain('available');
 });
 it('does not send another paid planner request after a lost acknowledgement',async()=>{
  const f=fixture();vi.mocked(f.scope.infer).mockRejectedValue(new Error('ACK lost after outbound send'));
  await expect(f.loop.run(f.scope)).rejects.toThrow('ACK lost');expect(f.steps.get(1)?.state).toBe('unknown');
  await expect(f.loop.run(f.scope)).rejects.toThrow('Прежний вызов');expect(f.scope.infer).toHaveBeenCalledOnce();expect(f.scope.execute).not.toHaveBeenCalled();
 });
 it('does not publish a late tool result after cancellation',async()=>{
  const f=fixture(),started=defer<void>(),result=defer<unknown>();vi.mocked(f.scope.infer).mockResolvedValue(JSON.stringify({action:'rag_read',sourceId:'source'}));
  vi.mocked(f.scope.execute).mockImplementation(async()=>{started.resolve();return result.promise;});const run=f.loop.run(f.scope);const failure=expect(run).rejects.toThrow();
  await started.promise;f.abort.abort();result.resolve({secret:'late output'});await failure;
  expect(f.steps.get(2)?.state).toBe('unknown');expect(f.steps.get(2)?.output).toBeNull();expect(f.scope.infer).toHaveBeenCalledOnce();
 });
 it('checks current authority again after dispatch and before retaining a result',async()=>{
  const f=fixture();vi.mocked(f.scope.infer).mockImplementation(async()=>{f.revoke();return JSON.stringify({action:'finish'});});
  await expect(f.loop.run(f.scope)).rejects.toThrow('revoked');expect(f.steps.get(1)?.state).toBe('unknown');expect(f.repository.complete).not.toHaveBeenCalled();
 });
 it('keeps completed receipts when execution turns off and does not start the next model call',async()=>{
  const f=fixture();vi.mocked(f.scope.infer).mockResolvedValue(JSON.stringify({action:'rag_read',sourceId:'source'}));let enabled=true;
  vi.mocked(f.scope.execute).mockImplementation(async()=>{enabled=false;return {source:'retained'};});f.feature.mockImplementation(async()=>{if(!enabled)throw Error('Feature off');});
  await expect(f.loop.run(f.scope)).rejects.toThrow('Feature off');expect(f.steps.get(2)?.state).toBe('succeeded');expect(f.steps.get(2)?.output).toEqual({source:'retained'});expect(f.scope.infer).toHaveBeenCalledOnce();
 });
 it('hydrates references before the final context and refuses a source that lost visibility',async()=>{
  const f=fixture();f.scope.owner.grant={protocol:'json-actions-v1',rag:false,publicChats:{modelId:'model-embed',expectedModelPin:'b'.repeat(64),consent:true}};
  vi.mocked(f.scope.infer).mockResolvedValue(JSON.stringify({action:'public_chat_search',query:'context'}));vi.mocked(f.scope.execute).mockResolvedValue({jobId:'job',status:'ready'});
  f.scope.present=vi.fn(async()=>{throw Error('Source closed');});await expect(f.loop.run(f.scope)).rejects.toThrow('Source closed');
  expect(f.steps.get(2)?.output).toEqual({jobId:'job',status:'ready'});expect(f.scope.infer).toHaveBeenCalledOnce();
 });
 it('stops after three actual tool actions and declares the incomplete scope in the answer context',async()=>{
  const f=fixture();vi.mocked(f.scope.infer).mockResolvedValue('{"action":"rag_read","sourceId":"found-source"}');
  const result=await f.loop.run(f.scope);expect(f.scope.execute).toHaveBeenCalledTimes(3);expect(f.scope.infer).toHaveBeenCalledTimes(3);expect(f.steps.size).toBe(6);
  expect(result.at(-1)?.content).toContain('Достигнут предел трёх');
 });
});
describe('Agent tool grant and protocol boundaries',()=>{
 it('preserves exact embedding consent and rejects ungranted or invented native tools',()=>{
  expect(agentToolGrant(undefined,null)).toBeUndefined();expect(()=>agentToolGrant(grant,null)).toThrow();
  expect(()=>agentToolAction('{"action":"mcp_call","tool":"shell"}',grant)).toThrow();expect(()=>agentToolAction('{"action":"request_system_role","roleId":"agent-ai-admin","instruction":"help"}',grant)).toThrow();
  const value={protocol:'json-actions-v1',rag:false,publicChats:{modelId:'model-embed',expectedModelPin:'c'.repeat(64),consent:true}};
  expect(agentToolGrant(value,'prj-owned')).toEqual(value);expect(()=>agentToolGrant({...value,publicChats:{...value.publicChats,consent:false}},'prj-owned')).toThrow();
 });
 it('does not repair incomplete model JSON or accept changes disguised as a tool action',()=>{
  expect(()=>agentToolAction('{"action":"finish"',grant)).toThrow('Автоматического повтора');expect(()=>agentToolAction('{"action":"finish","changes":[1]}',grant)).toThrow();
 });
});
