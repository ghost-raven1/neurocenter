import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {useWebRestore} from '../src/modules/Maintenance/restore/useWebRestore';
import type {RestoreIntent,RestoreJob,RestorePreview,RestoreStatus} from '../src/modules/Maintenance/restore/types';
import {createAuthRequestOwner} from '../src/features/UserBlock/authRequestOwner';
const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void;effect?:()=>void|(()=>void)}>=[],effects:Array<()=>void>=[];
    const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(value,a[index]));
    return{begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),replayEffects:()=>{for(const slot of slots){if(slot.effect){slot.cleanup?.();slot.cleanup=slot.effect()||undefined;}}},dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        useState<T>(initial?:T){const slot=slots[cursor++]??={value:initial};return[slot.value,(next:T|((old:T)=>T))=>{slot.value=typeof next==='function'?(next as (old:T)=>T)(slot.value as T):next;}];},
        useRef<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},
        useCallback<T>(value:T,deps:unknown[]){const index=cursor++,previous=slots[index];if(!previous||!same(previous.deps,deps))slots[index]={value,deps};return slots[index].value;},
        useEffect(effect:()=>void|(()=>void),deps?:unknown[]){const index=cursor++,previous=slots[index];if(previous&&deps&&same(previous.deps,deps))return;const slot=slots[index]={deps,effect};effects.push(()=>{previous?.cleanup?.();slot.cleanup=effect()||undefined;});},
    };
});
const io=vi.hoisted(()=>({read:vi.fn(),save:vi.fn(),clear:vi.fn(),submit:vi.fn(),request:vi.fn(),status:vi.fn(),cancel:vi.fn(),cancelRequest:vi.fn(),epoch:0,owner:'alice',captures:new Map<number,()=>()=>boolean>(),lifecycleOwner:undefined as ReturnType<typeof createAuthRequestOwner>|undefined}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.useState,useRef:hooks.useRef,useCallback:hooks.useCallback,useEffect:hooks.useEffect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{if(io.lifecycleOwner)return{scope:io.owner,captureOwner:io.lifecycleOwner.captureOwner};let capture=io.captures.get(io.epoch);if(!capture){const born=io.epoch;capture=()=>()=>io.epoch===born;io.captures.set(born,capture);}return {scope:io.owner,captureOwner:capture};}}));
vi.mock('../src/modules/Maintenance/restore/restoreDraftStore',()=>({readRestoreIntent:io.read,saveRestoreIntent:io.save,clearRestoreIntent:io.clear}));
vi.mock('../src/modules/Maintenance/restore/api',()=>({webRestoreApi:{submit:io.submit,request:io.request,status:io.status,cancel:io.cancel,cancelRequest:io.cancelRequest}}));
const records=new Map<string,RestoreIntent>(),status:RestoreStatus={runner:{available:true,targetPrefix:'nc-restore'},checkpoints:[{id:'one',label:'One',sha256:'a'.repeat(64),createdAt:'2026-10-21T00:00:00Z'}],jobs:[]};
const selection=()=>({checkpointId:'one',checkpointSha256:'a'.repeat(64),targetProject:'nc-restore-one'});
const queued:RestoreJob={id:'11111111-1111-4111-8111-111111111111',requestKey:'22222222-2222-4222-8222-222222222222',kind:'preview',state:'queued',input:{...selection(),requestKey:'22222222-2222-4222-8222-222222222222'},preview:null,receipt:null,errorCode:null,message:'Ожидание',createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z'};
const preview:RestorePreview={...selection(),configDigest:'b'.repeat(64),checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),digest:'c'.repeat(64),impact:{databases:['catalog','rag'],volumes:['skills','projects','backups','runtime-artifacts'],files:2,bytes:100,applicationsStarted:false,currentStackChanged:false}};
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(cause:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
let current:ReturnType<typeof useWebRestore>;
const flush=async()=>{for(let index=0;index<15;index++)await Promise.resolve();};
function render(){hooks.begin();current=useWebRestore(io.owner);hooks.commit();return current;}
async function ready(){render();await flush();render();}
async function switchOwner(owner:string){io.epoch++;io.owner=owner;hooks.dispose();await ready();}
beforeEach(()=>{vi.useFakeTimers();vi.resetAllMocks();records.clear();io.epoch++;io.owner='alice';io.lifecycleOwner=undefined;io.captures.clear();io.read.mockImplementation(async owner=>records.get(owner));io.status.mockResolvedValue(status);io.request.mockRejectedValue({response:{status:404}});io.cancelRequest.mockResolvedValue({cancelled:true});io.submit.mockImplementation(async intent=>({...queued,requestKey:intent.input.requestKey,input:intent.input,kind:intent.kind}));io.save.mockImplementation(async(owner,intent,expected)=>{const old=records.get(owner);if(old&&old.input.requestKey!==expected&&JSON.stringify(old)!==JSON.stringify(intent))throw Error('CAS changed');records.set(owner,structuredClone(intent));return intent;});io.clear.mockImplementation(async(owner,key)=>{const old=records.get(owner);if(old&&old.input.requestKey!==key)return false;records.delete(owner);return true;});});
afterEach(()=>{hooks.dispose();vi.useRealTimers();});
describe('Restore intent ownership and unknown HTTP outcome',()=>{
 it('StrictMode effect replay with a pending IDB read finishes the current unavailable state',async()=>{
  const first=deferred<RestoreIntent|undefined>(),second=deferred<RestoreIntent|undefined>();
  io.lifecycleOwner=createAuthRequestOwner('alice',()=>io.owner);io.lifecycleOwner.activate();
  io.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);io.status.mockResolvedValue({runner:{available:false},checkpoints:[],jobs:[]});
  render();expect(io.read).toHaveBeenCalledOnce();
  io.lifecycleOwner.dispose();io.lifecycleOwner.activate();hooks.replayEffects();
  expect(io.read).toHaveBeenCalledTimes(2);second.resolve(undefined);await flush();render();
  expect(current.loading).toBe(false);expect(current.status?.runner.available).toBe(false);expect(current.error).toBe('');
  first.reject(Error('Stale IDB response'));await flush();render();
  expect(current.loading).toBe(false);expect(current.error).toBe('');expect(io.status).toHaveBeenCalledOnce();expect(io.submit).not.toHaveBeenCalled();
 });
 it('In-place owner ABA starts a fresh read and an old finally cannot unlock the newer read',async()=>{
  const oldA=deferred<RestoreStatus>(),oldB=deferred<RestoreStatus>(),newA=deferred<RestoreStatus>();
  io.status.mockReturnValueOnce(oldA.promise).mockReturnValueOnce(oldB.promise).mockReturnValueOnce(newA.promise);
  render();await flush();expect(io.status).toHaveBeenCalledOnce();
  io.epoch++;io.owner='bob';render();await flush();expect(io.status).toHaveBeenCalledTimes(2);
  oldA.resolve(status);await flush();render();expect(current.loading).toBe(true);expect(current.status).toBeUndefined();
  await current.refresh();expect(io.status).toHaveBeenCalledTimes(2);
  io.epoch++;io.owner='alice';render();await flush();expect(io.status).toHaveBeenCalledTimes(3);
  oldB.reject(Error('Old owner failed'));await flush();render();expect(current.loading).toBe(true);expect(current.error).toBe('');
  newA.resolve({runner:{available:false},checkpoints:[],jobs:[]});await flush();render();
  expect(current.loading).toBe(false);expect(current.status?.runner.available).toBe(false);expect(io.submit).not.toHaveBeenCalled();
 });
 it('Late durable save after owner ABA remains available for explicit recovery without automatic deletion or POST',async()=>{
  await ready();const gate=deferred<void>();
  io.save.mockImplementationOnce(async(owner,intent)=>{await gate.promise;records.set(owner,intent);return intent;});
  const sending=current.check(selection());await flush();const saved=io.save.mock.calls[0][1];
  io.epoch++;io.owner='bob';render();await flush();io.epoch++;io.owner='alice';render();await flush();
  gate.resolve();await sending;render();expect(io.submit).not.toHaveBeenCalled();expect(io.clear).not.toHaveBeenCalled();expect(records.get('alice')).toEqual(saved);
  await current.refresh();render();expect(current.intent).toEqual(saved);expect(current.missing).toBe(true);
 });
 it('Commits exact confirmation before POST and ignores double clicks',async()=>{await ready();const saved=deferred<RestoreIntent>();io.save.mockReturnValue(saved.promise);const one=current.check(selection()),two=current.check(selection());await flush();expect(io.save).toHaveBeenCalledOnce();expect(io.submit).not.toHaveBeenCalled();saved.resolve(io.save.mock.calls[0][1]);await Promise.all([one,two]);expect(io.submit).toHaveBeenCalledOnce();expect(io.submit.mock.calls[0][0]).toEqual(io.save.mock.calls[0][1]);});
 it('Storage rejection prevents POST and blocks the form until recovery succeeds',async()=>{await ready();io.save.mockRejectedValueOnce(Error('Storage denied'));await current.check(selection());render();expect(current.blocked).toBe(true);expect(io.submit).not.toHaveBeenCalled();await current.refresh();render();expect(current.blocked).toBe(false);await current.check(selection());expect(io.submit).toHaveBeenCalledOnce();});
 it('Lost ACK survives reload; GET runs first and manual retry keeps exact UUID/source/target',async()=>{await ready();io.submit.mockRejectedValueOnce(Error('Lost ACK'));await current.check(selection());const intent=records.get('alice')!;hooks.dispose();await ready();expect(io.request).toHaveBeenCalledWith(intent.input.requestKey);expect(io.submit).toHaveBeenCalledOnce();expect(current.missing).toBe(true);await current.repeat();expect(io.submit.mock.calls[1][0]).toEqual(intent);});
 it('Pending storage commit after A → B → A does not POST or erase the newer tab intent',async()=>{await ready();const save=deferred<RestoreIntent>();io.save.mockReturnValueOnce(save.promise);const sending=current.check(selection());await flush();const old=io.save.mock.calls[0][1];await switchOwner('bob');const replacement:RestoreIntent={kind:'preview',input:{...selection(),requestKey:crypto.randomUUID()}};records.set('alice',replacement);await switchOwner('alice');save.resolve(old);await sending;render();expect(io.submit).not.toHaveBeenCalled();expect(records.get('alice')).toEqual(replacement);expect(current.intent).toEqual(replacement);});
 it('Late POST response does not populate the next account',async()=>{await ready();const response=deferred<RestoreJob>();io.submit.mockReturnValueOnce(response.promise);const sending=current.check(selection());await flush();await switchOwner('bob');response.resolve(queued);await sending;render();expect(current.intent).toBeUndefined();expect(current.job).toBeUndefined();expect(records.has('alice')).toBe(true);});
 it('Typed confirmation + exact ready preview atomically replaces only that preview intent',async()=>{await ready();io.submit.mockResolvedValueOnce({...queued,state:'ready',preview});await current.check(selection());render();await current.confirm(preview,'yes');expect(io.submit).toHaveBeenCalledOnce();const prior=records.get('alice')!;await current.confirm(preview,'RESTORE '+preview.targetProject);expect(io.save.mock.calls[1][2]).toBe(prior.input.requestKey);expect(io.submit.mock.calls[1][0]).toMatchObject({kind:'restore',input:{previewId:queued.id,digest:preview.digest,confirmation:'RESTORE '+preview.targetProject}});});
 it('New-check CAS conflict keeps the other tab confirmation and reloads it before any POST',async()=>{await ready();io.submit.mockResolvedValueOnce({...queued,state:'failed'});await current.check(selection());render();const next:RestoreIntent={kind:'preview',input:{...selection(),requestKey:crypto.randomUUID()}};records.set('alice',next);await current.newCheck();render();expect(current.blocked).toBe(true);expect(records.get('alice')).toEqual(next);await current.check(selection());expect(io.submit).toHaveBeenCalledOnce();await current.refresh();render();expect(current.intent).toEqual(next);expect(current.blocked).toBe(false);});
 it('Late clear conflict after owner ABA cannot block or clear the new form',async()=>{await ready();io.submit.mockResolvedValueOnce({...queued,state:'failed'});await current.check(selection());render();const clear=deferred<boolean>();io.clear.mockReturnValueOnce(clear.promise);const pending=current.newCheck();await switchOwner('bob');records.delete('alice');await switchOwner('alice');clear.resolve(false);await pending;render();expect(current.blocked).toBe(false);expect(current.error).toBe('');});
 it('New form after404 waits for server tombstone; lost cancellation ACK keeps the durable intent',async()=>{await ready();io.submit.mockRejectedValueOnce(Error('Lost POST ACK'));await current.check(selection());hooks.dispose();await ready();expect(current.missing).toBe(true);const saved=records.get('alice')!;io.cancelRequest.mockRejectedValueOnce(Error('Cancel ACK lost'));await current.newCheck();render();expect(records.get('alice')).toEqual(saved);expect(io.clear).not.toHaveBeenCalled();expect(current.intent).toEqual(saved);await current.newCheck();render();expect(io.cancelRequest).toHaveBeenLastCalledWith(saved.input.requestKey);expect(io.clear).toHaveBeenCalledWith('alice',saved.input.requestKey);expect(current.intent).toBeUndefined();});

});
