import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {SourceUpload,SourceUploadIntent} from '../src/modules/Store/packaging/uploadTypes';
const hooks=vi.hoisted(()=>{
 let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
 const equal=(a?:unknown[],b?:unknown[])=>!!a&&!!b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
 return {begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
 useState<T>(initial:T){const slot=slots[cursor++]??={value:initial};return [slot.value,(next:T|((value:T)=>T))=>{slot.value=typeof next==='function'?(next as (value:T)=>T)(slot.value as T):next;}];},useRef<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},
 useEffect(effect:()=>void|(()=>void),deps:unknown[]){const at=cursor++,old=slots[at];if(old&&equal(old.deps,deps))return;const slot=slots[at]={deps};effects.push(()=>{old?.cleanup?.();slot.cleanup=effect()||undefined;});}};
});
const state=vi.hoisted(()=>({scope:'actor-a',epoch:0,stored:new Map<string,SourceUploadIntent>(),order:[] as string[]}));
const api=vi.hoisted(()=>({create:vi.fn(),content:vi.fn(),lookup:vi.fn(),get:vi.fn(),cancel:vi.fn()}));
const disk=vi.hoisted(()=>({read:vi.fn(),save:vi.fn(),clear:vi.fn()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.useState,useRef:hooks.useRef,useEffect:hooks.useEffect}));
vi.mock('../src/modules/Store/packaging/sourceUploadApi',()=>({sourceUploadApi:api}));
vi.mock('../src/modules/Store/packaging/uploadDraftStore',()=>({readUploadIntent:disk.read,saveUploadIntent:disk.save,clearUploadIntent:disk.clear}));
import {hashSourceUpload,useSourceUpload} from '../src/modules/Store/packaging/useSourceUpload';
const capture=()=>{const epoch=state.epoch;return()=>state.epoch===epoch;};
const render=()=>{hooks.begin();const view=useSourceUpload(state.scope,capture);hooks.commit();return view;};
const tick=async()=>{for(let n=0;n<10;n++)await Promise.resolve();};
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};};
const file=()=>new File(['ready source'], 'program.zip');
const ready=(intent:SourceUploadIntent):SourceUpload=>({id:intent.requestKey,...intent,state:'READY',expiresAt:'2027-01-01',metadata:{entrypoint:'bin/server',candidates:['bin/server'],requiresEntrypointChoice:false,runnableKinds:['mcp'],choices:[{entrypoint:'bin/server',adapter:'native',targets:['darwin-arm64']}]}});
beforeEach(()=>{
 hooks.dispose();vi.clearAllMocks();state.scope='actor-a';state.epoch=0;state.stored.clear();state.order=[];
 disk.read.mockImplementation(async(scope:string)=>state.stored.get(scope));disk.save.mockImplementation(async(scope:string,intent:SourceUploadIntent)=>{state.order.push('saved');state.stored.set(scope,structuredClone(intent));return intent;});disk.clear.mockImplementation(async(scope:string,key?:string)=>{const old=state.stored.get(scope);if(old&&old.requestKey!==key)return false;state.stored.delete(scope);return true;});
 api.create.mockImplementation(async(intent:SourceUploadIntent)=>{state.order.push('create');return {...ready(intent),state:'WAITING'};});api.content.mockImplementation(async(_id:string,_file:File,_signal:AbortSignal,progress:(value:number)=>void)=>{progress(99);return ready(state.stored.get(state.scope)!);});api.lookup.mockRejectedValue({isAxiosError:true,response:{status:404}});api.cancel.mockResolvedValue({state:'CANCELLED'});
});
afterEach(()=>{hooks.dispose();vi.unstubAllGlobals();});
describe('Upload owner, persistence and raw stream lifecycle',()=>{
 it('Hash/read failure and over-limit file happen before an intent or server call',async()=>{
  render();await tick();let view=render();await view.select({name:'large.zip',size:268435457,arrayBuffer:vi.fn()} as unknown as File);expect(disk.save).not.toHaveBeenCalled();expect(api.create).not.toHaveBeenCalled();
  await expect(hashSourceUpload({name:'limit.zip',size:268435456,arrayBuffer:async()=>{throw new Error('reader unavailable');}})).rejects.toThrow('ещё не создана');expect(api.create).not.toHaveBeenCalled();
 });
 it('The full 256 MiB boundary hashes through WebCrypto before creating a control intent',async()=>{
  const expected=createHash('sha256'),chunk=Buffer.alloc(64*1024);for(let index=0;index<4096;index++)expected.update(chunk);
  const checked=await hashSourceUpload({name:'limit.bin',size:256*1024**2,arrayBuffer:async()=>new ArrayBuffer(256*1024**2)});
  expect(checked).toEqual({name:'limit.bin',bytes:256*1024**2,sha256:expected.digest('hex')});expect(api.create).not.toHaveBeenCalled();expect(disk.save).not.toHaveBeenCalled();
 });
 it('Durable exact intent commits before metadata POST and binary PUT',async()=>{render();await tick();await render().select(file());expect(state.order).toEqual(['saved','create']);expect(api.content).toHaveBeenCalledOnce();expect(render().upload?.state).toBe('READY');expect(JSON.stringify(state.stored.get('actor-a'))).not.toContain('ready source');});
 it('Storage refusal prevents both upload create and binary transfer',async()=>{render();await tick();disk.save.mockRejectedValue(new Error('Storage blocked'));await render().select(file());expect(api.create).not.toHaveBeenCalled();expect(api.content).not.toHaveBeenCalled();expect(render().error).toContain('Storage blocked');});
 it('Unknown create response keeps UUID; a same-file retry submits that exact intent',async()=>{render();await tick();api.create.mockRejectedValueOnce(new Error('connection lost'));await render().select(file());const original=structuredClone(state.stored.get('actor-a')!);expect(api.content).not.toHaveBeenCalled();await render().select(file());expect(api.create.mock.calls[1][0]).toEqual(original);expect(render().upload?.state).toBe('READY');});
 it('A changed file cannot reuse retained UUID',async()=>{render();await tick();api.create.mockRejectedValueOnce(new Error('lost'));await render().select(file());await render().select(new File(['different'], 'program.zip'));expect(api.create).toHaveBeenCalledOnce();expect(render().error).toContain('Другой файл не отправится');});
 it('Cancel of an unknown create uses request UUID; late create cannot start binary PUT',async()=>{render();await tick();const pending=deferred<SourceUpload>();api.create.mockReturnValue(pending.promise);const running=render().select(file());await vi.waitFor(()=>expect(api.create).toHaveBeenCalledOnce());const intent=state.stored.get('actor-a')!;expect(intent).toBeDefined();await render().cancel();pending.resolve({...ready(intent),state:'WAITING'});await running;expect(api.cancel).toHaveBeenCalledWith(intent.requestKey,expect.any(AbortSignal));expect(api.content).not.toHaveBeenCalled();expect(state.stored.has('actor-a')).toBe(false);});
 it('Two cancels during a pending durable write settle the same UUID without creating or leaving a hidden intent',async()=>{
  render();await tick();const pending=deferred<SourceUploadIntent>();disk.save.mockImplementation((scope:string)=>pending.promise.then(intent=>{state.stored.set(scope,intent);return intent;}));
  const selecting=render().select(file());await vi.waitFor(()=>expect(disk.save).toHaveBeenCalledOnce());const intent=disk.save.mock.calls[0][1] as SourceUploadIntent;
  const first=render().cancel(),second=render().cancel();pending.resolve(intent);await Promise.all([selecting,first,second]);
  expect(api.cancel).toHaveBeenCalledOnce();expect(api.cancel.mock.calls[0][0]).toBe(intent.requestKey);expect(api.create).not.toHaveBeenCalled();expect(state.stored.has('actor-a')).toBe(false);expect(render().intent).toBeUndefined();
 });
 it('An unknown cancel response after a late durable write retains its exact UUID for another cancel',async()=>{
  render();await tick();const pending=deferred<SourceUploadIntent>();disk.save.mockImplementation((scope:string)=>pending.promise.then(intent=>{state.stored.set(scope,intent);return intent;}));
  const selecting=render().select(file());await vi.waitFor(()=>expect(disk.save).toHaveBeenCalledOnce());const intent=disk.save.mock.calls[0][1] as SourceUploadIntent;
  api.cancel.mockRejectedValueOnce(new Error('lost cancel reply'));const cancelling=render().cancel();pending.resolve(intent);await Promise.all([selecting,cancelling]);
  expect(render().intent).toEqual(intent);expect(state.stored.get('actor-a')).toEqual(intent);await render().cancel();expect(api.cancel.mock.calls.map(call=>call[0])).toEqual([intent.requestKey,intent.requestKey]);expect(state.stored.has('actor-a')).toBe(false);
 });
 it('Owner A → B → A while reading a file cannot create an upload or update the new form',async()=>{
  render();await tick();const pending=deferred<ArrayBuffer>(),bytes=new TextEncoder().encode('old').buffer;const running=render().select({name:'old.zip',size:3,arrayBuffer:()=>pending.promise} as File);
  state.scope='actor-b';state.epoch++;render();await tick();state.scope='actor-a';state.epoch++;render();await tick();pending.resolve(bytes);await running;expect(disk.save).not.toHaveBeenCalled();expect(api.create).not.toHaveBeenCalled();expect(render().upload).toBeUndefined();
 });
 it('Recovered READY metadata is read by exact UUID without resending binary bytes',async()=>{
  const intent={requestKey:crypto.randomUUID(),name:'ready.zip',bytes:3,sha256:'a'.repeat(64)};state.stored.set('actor-a',intent);api.lookup.mockResolvedValue(ready(intent));render();await tick();expect(render().upload?.state).toBe('READY');expect(api.lookup).toHaveBeenCalledWith(intent.requestKey,expect.any(AbortSignal));expect(api.create).not.toHaveBeenCalled();expect(api.content).not.toHaveBeenCalled();
 });
 it('Restoring a saved build source waits for control recovery and failed restore does not loop',async()=>{
  const pending=deferred<SourceUploadIntent|undefined>();disk.read.mockReturnValue(pending.promise);const view=render(),source={type:'upload' as const,uploadId:crypto.randomUUID(),sha256:'a'.repeat(64),bytes:3,entrypoint:'bin/server'};api.get.mockRejectedValue(new Error('not available'));
  const restoring=view.restore(source);await tick();expect(api.get).not.toHaveBeenCalled();pending.resolve(undefined);await restoring;await render().restore(source);expect(api.get).toHaveBeenCalledOnce();await render().recheck();expect(api.get).toHaveBeenCalledTimes(2);
 });
 it('After a failed historical build, choosing another source forgets only control metadata and uses a fresh upload UUID',async()=>{
  render();await tick();await render().select(file());const first=state.stored.get('actor-a')!;
  expect(await render().forget()).toBe(true);expect(api.cancel).not.toHaveBeenCalled();expect(render().upload).toBeUndefined();
  await render().select(new File(['another ready source'],'another.zip'));const second=state.stored.get('actor-a')!;
  expect(second.requestKey).not.toBe(first.requestKey);expect(api.create).toHaveBeenCalledTimes(2);expect(api.cancel).not.toHaveBeenCalled();
 });
 it.each(['cancel','forget'] as const)('A second-tab CAS conflict during %s offers recovery of the new exact intent',async action=>{
  render();await tick();await render().select(file());const old=state.stored.get('actor-a')!,fresh={...old,requestKey:crypto.randomUUID()};state.stored.set('actor-a',fresh);
  await render()[action]();expect(state.stored.get('actor-a')).toEqual(fresh);expect(render().blocked).toBe(true);
  api.lookup.mockResolvedValue(ready(fresh));render().retryRecovery();render();await tick();expect(render().intent).toEqual(fresh);expect(render().upload?.id).toBe(fresh.requestKey);expect(render().blocked).toBeUndefined();
 });
 it('Forgetting a restored historical source without a local intent still detects a new request in another tab',async()=>{
  render();await tick();const historical={requestKey:crypto.randomUUID(),name:'historical.zip',bytes:3,sha256:'a'.repeat(64)},fresh={...historical,requestKey:crypto.randomUUID()};api.get.mockResolvedValue(ready(historical));
  await render().restore({type:'upload',uploadId:historical.requestKey,sha256:historical.sha256,bytes:historical.bytes,entrypoint:'bin/server'});state.stored.set('actor-a',fresh);
  expect(await render().forget()).toBe(false);expect(render().blocked).toBe(true);expect(state.stored.get('actor-a')).toEqual(fresh);expect(api.cancel).not.toHaveBeenCalled();
  api.lookup.mockResolvedValue(ready(fresh));render().retryRecovery();render();await tick();expect(render().intent).toEqual(fresh);
 });
 it('A newly observed save conflict is recoverable before any source POST',async()=>{
  render();await tick();const fresh={requestKey:crypto.randomUUID(),name:'other.zip',bytes:3,sha256:'a'.repeat(64)};state.stored.set('actor-a',fresh);disk.save.mockRejectedValue(new Error('Уже сохранена другая загрузка.'));
  await render().select(file());expect(render().blocked).toBe(true);expect(api.create).not.toHaveBeenCalled();api.lookup.mockResolvedValue(ready(fresh));render().retryRecovery();render();await tick();expect(render().intent).toEqual(fresh);
 });

});
