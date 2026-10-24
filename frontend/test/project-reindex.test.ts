import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import api from '../src/core/api/base';import {requireReindexPlan,projectReindexApi,reindexPending,type IProjectReindexPlan} from '../src/features/ProjectEmbedding/reindex';import {useProjectReindex} from '../src/features/ProjectEmbedding/useProjectReindex';import type {ICatalogModel} from '../src/features/ModelCatalog/types';
const hooks=vi.hoisted(()=>{let cursor=0;const slots:Array<{value?:any;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(value,a[index]));return{begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},useRef:(value:unknown)=>(slots[cursor++]??={value:{current:value}}).value,useState:(value:unknown)=>{const slot=slots[cursor++]??={value:typeof value==='function'?value():value};return[slot.value,(next:unknown)=>{slot.value=typeof next==='function'?next(slot.value):next;}];},useCallback:(value:unknown,deps:unknown[])=>{const index=cursor++,prior=slots[index];if(!prior||!same(prior.deps,deps))slots[index]={value,deps};return slots[index].value;},useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>{const index=cursor++,prior=slots[index];if(prior&&same(prior.deps,deps))return;const slot=slots[index]={deps};effects.push(()=>{prior?.cleanup?.();slot.cleanup=effect()||undefined;});}};});
const owner=vi.hoisted(()=>({value:'one',captures:new Map<string,()=>()=>boolean>()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useRef:hooks.useRef,useState:hooks.useState,useEffect:hooks.useEffect,useCallback:hooks.useCallback}));
vi.mock('../src/core/api/base',()=>({default:{get:vi.fn(),post:vi.fn()}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{const value=owner.value;if(!owner.captures.has(value))owner.captures.set(value,()=>()=>owner.value===value);return{scope:value,captureOwner:owner.captures.get(value)!};}}));
const pin='a'.repeat(64),id='12345678-1234-4234-8234-123456789012',generation='initial-'+'b'.repeat(32),project='prj-fixture';
const model={id:'model-fixture',modelPin:pin} as ICatalogModel;
const fixture=(changes:Partial<IProjectReindexPlan>={}):IProjectReindexPlan=>({id,projectId:project,state:'building',digest:'c'.repeat(64),approved:true,progress:0,message:'Готовим',createdAt:'2026-10-20T00:00:00Z',data:{context:{revision:1,dataRevision:2,generation},modelId:model.id,modelPin:pin,profile:{provider:'openai',model:`neurocenter/${model.id}/sha256/${pin}`,dimension:5},sourceSnapshot:null,rowCount:0,requiredBytes:0},...changes});
const applied=vi.fn();let projectId:string|undefined,current:ReturnType<typeof useProjectReindex>;
function render(){hooks.begin();current=useProjectReindex(projectId,applied);hooks.commit();return current;}
async function settle(){for(let n=0;n<20;n++)await Promise.resolve();render();}
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
beforeEach(()=>{vi.useFakeTimers();vi.clearAllMocks();owner.value='one';owner.captures.clear();projectId=project;vi.mocked(api.get).mockResolvedValue({data:null});vi.mocked(api.post).mockResolvedValue({data:fixture()});});
afterEach(()=>{hooks.dispose();vi.useRealTimers();});
describe('Reindex response integrity',()=>{
 it.each([['project',{projectId:'foreign'}],['id',{id:'bad'}],['digest',{digest:'bad'}],['state',{state:'unknown'}],['progress',{progress:101}],['createdAt',{createdAt:'nonsense'}],['local',{local:{jobId:'bad',state:'succeeded',percent:0,message:'bad'}}]])('%s malformed receipt cannot control UI',(_name,patch)=>{expect(()=>requireReindexPlan({...fixture(),...patch},project)).toThrow('неполный');});
 it('A different vector profile or source identity is rejected',()=>{for(const data of [{...fixture().data,profile:{...fixture().data.profile,dimension:16001}},{...fixture().data,modelPin:'b'.repeat(64)},{...fixture().data,context:{revision:0,dataRevision:0,generation:'foreign'}}])expect(()=>requireReindexPlan({...fixture(),data},project)).toThrow();});
 it('Applied server pointer remains pending while an offline local job is queued',()=>{expect(reindexPending(fixture({state:'applied',local:{jobId:id,state:'queued',message:'Offline',percent:null}}))).toBe(true);expect(reindexPending(fixture({state:'applied',local:{jobId:id,state:'succeeded',message:'Ready',percent:100}}))).toBe(false);});
});
describe('Owned one-click intent, retries and polling',()=>{
 it('Undefined project never fetches latest or posts',async()=>{projectId=undefined;render();await settle();await current.request(model);expect(api.get).not.toHaveBeenCalled();expect(api.post).not.toHaveBeenCalled();});
 it('Double click sends one exact selection/target intent',async()=>{render();await settle();const pending=deferred<any>();vi.mocked(api.post).mockReturnValueOnce(pending.promise);const target={deviceId:id,assetId:'rag',assetKind:'mcp' as const,version:9,expectedManifest:'d'.repeat(64),expectedBindingId:'e'.repeat(64),expectedInstanceId:id};void current.request(model,1,target);void current.request(model,1,target);expect(api.post).toHaveBeenCalledOnce();expect(vi.mocked(api.post).mock.calls[0][1]).toMatchObject({expectedSelectionRevision:1,modelId:model.id,expectedModelPin:pin,connection:target});pending.resolve({data:fixture()});await settle();expect(current.pending).toBe(true);});
 it('Lost POST ACK retries identical bytes and request key',async()=>{render();await settle();vi.mocked(api.post).mockRejectedValueOnce(Error('lost ACK'));await current.request(model,1);await settle();expect(current.error).toContain('lost ACK');const first=vi.mocked(api.post).mock.calls[0][1];await current.request(model,1);expect(vi.mocked(api.post).mock.calls[1][1]).toEqual(first);});
 it('Role/session changes during an awaited selection GET never post for the old owner',async()=>{render();await settle();const selection=deferred<any>();vi.mocked(api.get).mockReturnValueOnce(selection.promise);void current.request(model);owner.value='two';render();selection.resolve({data:{projectId:project,revision:1,expectedDimension:0,model:null,modelPin:null,profile:null,activeGeneration:generation,activeSnapshot:null,dataRevision:0}});await settle();expect(api.post).not.toHaveBeenCalled();});
 it('Late POST from the old owner never replaces a new owner plan',async()=>{render();await settle();const post=deferred<any>();vi.mocked(api.post).mockReturnValueOnce(post.promise);void current.request(model,1);owner.value='two';render();await settle();post.resolve({data:fixture({state:'applied'})});await settle();expect(current.plan).toBeUndefined();expect(applied).not.toHaveBeenCalled();});
 it('A stale poll cannot undo cancellation; next request gets a fresh intent',async()=>{render();await settle();await current.request(model,1);render();const poll=deferred<any>();vi.mocked(api.get).mockReturnValueOnce(poll.promise);await vi.advanceTimersByTimeAsync(1500);vi.mocked(api.post).mockResolvedValueOnce({data:fixture({state:'cancelled'})});await current.cancel();render();poll.resolve({data:fixture()});await settle();expect(current.plan?.state).toBe('cancelled');const original=vi.mocked(api.post).mock.calls[0][1] as any;await current.request(model,1);expect((vi.mocked(api.post).mock.calls.at(-1)![1] as any).requestKey).not.toBe(original.requestKey);});
 it('Lost cancel ACK keeps uncertainty; idempotent cancel retries the same plan and held running poll cannot resurrect it',async()=>{
  render();await settle();await current.request(model,1);render();
  const held=deferred<any>();vi.mocked(api.get).mockReturnValueOnce(held.promise);await vi.advanceTimersByTimeAsync(1500);
  let server=fixture();const cancellations:string[]=[];
  vi.mocked(api.post).mockImplementation(async(url)=>{
   cancellations.push(String(url));server=fixture({state:'cancelled',message:'Отмена подтверждена сервером.'});
   if(cancellations.length===1)throw Error('cancel ACK delivery lost');
   return{data:server};
  });
  await current.cancel();render();
  expect(server.state).toBe('cancelled');expect(current.plan?.state).toBe('building');expect(current.error).toContain('cancel ACK delivery lost');
  await current.cancel();render();expect(current.plan).toEqual(server);expect(current.error).toBe('');
  expect(cancellations).toEqual([`/api/projects/${project}/embedding/reindex/${id}/cancel`,`/api/projects/${project}/embedding/reindex/${id}/cancel`]);
  held.resolve({data:fixture({progress:77,message:'Stale running response'})});await settle();
  expect(current.plan).toEqual(server);expect(current.pending).toBe(false);expect(applied).not.toHaveBeenCalled();
  const count=vi.mocked(api.get).mock.calls.length;await vi.advanceTimersByTimeAsync(4500);expect(api.get).toHaveBeenCalledTimes(count);
 });
 it('Lost cancel ACK reconciles from the next GET without a second mutation and keeps the cancelled plan visible',async()=>{
  render();await settle();await current.request(model,1);render();
  const server=fixture({state:'cancelled',message:'Операция отменена.'});vi.mocked(api.post).mockRejectedValueOnce(Error('cancel ACK delivery lost'));
  await current.cancel();render();expect(current.plan?.state).toBe('building');expect(current.error).toContain('cancel ACK delivery lost');
  vi.mocked(api.get).mockResolvedValueOnce({data:server});await vi.advanceTimersByTimeAsync(1500);await settle();
  expect(current.plan).toEqual(server);expect(current.pending).toBe(false);expect(current.error).toBe('');expect(api.post).toHaveBeenCalledTimes(2);
  expect(applied).not.toHaveBeenCalled();
 });
 it('Polling stops when the queued local job succeeds, even though server state remains applied',async()=>{render();await settle();vi.mocked(api.post).mockResolvedValueOnce({data:fixture({state:'applied',local:{jobId:id,state:'queued',message:'offline',percent:null}})});await current.request(model,1);render();vi.mocked(api.get).mockResolvedValueOnce({data:fixture({state:'applied',local:{jobId:id,state:'succeeded',message:'done',percent:100}})});await vi.advanceTimersByTimeAsync(1500);await settle();expect(current.pending).toBe(false);const count=vi.mocked(api.get).mock.calls.length;await vi.advanceTimersByTimeAsync(4500);expect(api.get).toHaveBeenCalledTimes(count);expect(applied).toHaveBeenCalledOnce();});
 it('Retry-local sends the existing plan ID without making another model plan',async()=>{render();await settle();vi.mocked(api.post).mockResolvedValueOnce({data:fixture({state:'applied',local:{jobId:id,state:'failed',message:'offline timeout',percent:null}})});await current.request(model,1);render();await current.retryLocal();expect(vi.mocked(api.post).mock.calls.at(-1)![0]).toContain('/'+id+'/local-retry');});
});
