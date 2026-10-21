import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {useProjectSnapshots} from '../src/features/ProjectSnapshots/useProjectSnapshots';
const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
    const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(value,a[index]));
    return {begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        useState<T>(initial:T){const slot=slots[cursor++]??={value:initial};return [slot.value,(next:T|((old:T)=>T))=>{slot.value=typeof next==='function'?(next as (old:T)=>T)(slot.value as T):next;}];},
        useRef<T>(initial:T){return(slots[cursor++]??={value:{current:initial}}).value;},
        useCallback<T>(value:T,deps:unknown[]){const index=cursor++,old=slots[index];if(!old||!same(old.deps,deps))slots[index]={value,deps};return slots[index].value;},
        useEffect(effect:()=>void|(()=>void),deps?:unknown[]){const index=cursor++,old=slots[index];if(old&&deps&&same(old.deps,deps))return;const slot=slots[index]={deps};effects.push(()=>{old?.cleanup?.();slot.cleanup=effect()||undefined;});},
    };
});
const io=vi.hoisted(()=>({project:vi.fn(),list:vi.fn(),profiles:vi.fn(),capabilities:vi.fn(),epoch:0,owner:'alice',captures:new Map<number,()=>()=>boolean>()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.useState,useRef:hooks.useRef,useCallback:hooks.useCallback,useEffect:hooks.useEffect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{let capture=io.captures.get(io.epoch);if(!capture){const epoch=io.epoch;capture=()=>()=>epoch===io.epoch;io.captures.set(epoch,capture);}return {scope:io.owner,captureOwner:capture};}}));
vi.mock('../src/core/api/bff',()=>({default:{getProject:io.project}}));
vi.mock('../src/features/ProjectSnapshots/api',()=>({projectSnapshotsApi:{list:io.list,profiles:io.profiles,capabilities:io.capabilities}}));
let current:ReturnType<typeof useProjectSnapshots>,projectId='project-one';
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};};
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function render(commit=true){hooks.begin();current=useProjectSnapshots(projectId);if(commit)hooks.commit();return current;}
async function ready(){render();await flush();render();}
beforeEach(()=>{vi.useFakeTimers();vi.clearAllMocks();io.epoch++;io.owner='alice';io.captures.clear();projectId='project-one';io.project.mockImplementation(async id=>({id,head:null,headRevision:0}));io.list.mockResolvedValue([]);io.profiles.mockResolvedValue([]);io.capabilities.mockResolvedValue({available:true});vi.stubGlobal('document',{visibilityState:'visible'});});
afterEach(()=>{hooks.dispose();vi.useRealTimers();vi.unstubAllGlobals();});
describe('Snapshot reads — exact project/owner/current readiness',()=>{
    it('Late prior project response cannot overwrite the current list/CAS',async()=>{const old=deferred<unknown[]>();io.list.mockReturnValueOnce(old.promise);render();projectId='project-two';await ready();expect(current.data?.project.id).toBe('project-two');old.resolve([{snapshotId:'old'}]);await flush();render();expect(current.data?.snapshots).toEqual([]);expect(current.data?.project.id).toBe('project-two');});
    it('Role/project transition hides old data before passive effects; old refresh callback is inert after ABA',async()=>{await ready();const staleRefresh=current.refresh;io.owner='observer';io.epoch++;render(false);expect(current.data).toBeUndefined();expect(current.ready).toBe(false);hooks.commit();await flush();io.owner='alice';io.epoch++;await ready();const count=io.list.mock.calls.length;await staleRefresh();expect(io.list).toHaveBeenCalledTimes(count);expect(current.ready).toBe(true);});
    it('Transient read error retains visible history while blocking writes; access denial removes it',async()=>{await ready();io.list.mockRejectedValueOnce(Error('Network'));await current.refresh();render();expect(current.data).toBeDefined();expect(current.ready).toBe(false);expect(current.error).not.toBe('');io.list.mockRejectedValueOnce({response:{status:403}});await current.refresh();render();expect(current.data).toBeUndefined();expect(current.ready).toBe(false);});
    it('Rejects a cross-project detail response before its head can enable a command',async()=>{io.project.mockResolvedValueOnce({id:'wrong',headRevision:1});await ready();expect(current.ready).toBe(false);expect(current.data).toBeUndefined();expect(current.error).toContain('другому проекту');});
    it('Pending upload refresh never aborts a slow in-flight read; verified state stops periodic reads',async()=>{
        io.list.mockResolvedValueOnce([{snapshotId:'one',status:'UPLOADING'}]);await ready();const slow=deferred<unknown[]>();io.list.mockReturnValueOnce(slow.promise);
        await vi.advanceTimersByTimeAsync(2500);render();expect(io.list).toHaveBeenCalledTimes(2);const signal=io.list.mock.calls[1][1] as AbortSignal;
        await vi.advanceTimersByTimeAsync(10000);expect(io.list).toHaveBeenCalledTimes(2);expect(signal.aborted).toBe(false);
        slow.resolve([{snapshotId:'one',status:'VERIFIED'}]);await flush();render();expect(current.ready).toBe(true);await vi.advanceTimersByTimeAsync(10000);expect(io.list).toHaveBeenCalledTimes(2);
    });
});
