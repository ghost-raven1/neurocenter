import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {retiredRagApi} from '../src/features/RetiredRagDatabases/api';
import {useRetiredRagDatabases} from '../src/features/RetiredRagDatabases/useRetiredRagDatabases';
import type {IRetiredRagDatabase,IRetiredRagPreview} from '../src/features/RetiredRagDatabases/types';

const hooks=vi.hoisted(()=>{let cursor=0;const slots:Array<{value?:any;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(value,a[index]));return{begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},useRef:(value:unknown)=>(slots[cursor++]??={value:{current:value}}).value,useState:(value:unknown)=>{const slot=slots[cursor++]??={value:typeof value==='function'?value():value};return[slot.value,(next:unknown)=>{slot.value=typeof next==='function'?next(slot.value):next;}];},useCallback:(value:unknown,deps:unknown[])=>{const index=cursor++,prior=slots[index];if(!prior||!same(prior.deps,deps))slots[index]={value,deps};return slots[index].value;},useEffect:(effect:()=>void|(()=>void),deps:unknown[])=>{const index=cursor++,prior=slots[index];if(prior&&same(prior.deps,deps))return;const slot=slots[index]={deps};effects.push(()=>{prior?.cleanup?.();slot.cleanup=effect()||undefined;});}};});
vi.mock('react',async original=>({...await original<typeof import('react')>(),useRef:hooks.useRef,useState:hooks.useState,useEffect:hooks.useEffect,useCallback:hooks.useCallback}));
vi.mock('../src/features/RetiredRagDatabases/api',()=>({retiredRagApi:{list:vi.fn(),preview:vi.fn(),purge:vi.fn(),retry:vi.fn(),retention:vi.fn()}}));
const row={id:'retirement',projectId:'prj-one',projectName:'Own fixture',retention:{revision:3,retainUntil:null,reason:'',automaticPurge:false},database:{databaseName:'nc_rag_'+'a'.repeat(32),state:'retained',present:true,bytes:100},blockers:[],job:null} as IRetiredRagDatabase;
const plan={id:'preview-one',digest:'a'.repeat(64),facts:{retirementId:row.id},projectName:row.projectName} as IRetiredRagPreview;
const defer=<T>()=>{let resolve!:(v:T)=>void,reject!:(v:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
let current:ReturnType<typeof useRetiredRagDatabases>;
function render(){hooks.begin();current=useRetiredRagDatabases();hooks.commit();return current;}
async function settle(){for(let n=0;n<20;n++)await Promise.resolve();return render();}
beforeEach(()=>{vi.useFakeTimers();vi.resetAllMocks();vi.mocked(retiredRagApi.list).mockResolvedValue([row]);vi.mocked(retiredRagApi.preview).mockResolvedValue(plan);vi.mocked(retiredRagApi.purge).mockResolvedValue({id:'job-one'} as any);});
afterEach(()=>{hooks.dispose();vi.useRealTimers();});
describe('Retired RAG ownership, durable repeated intent and error handling',()=>{
    it('Late inventory and preview from an unmounted owner cannot populate the next account',async()=>{
        render();await settle();const pending=defer<IRetiredRagPreview>();vi.mocked(retiredRagApi.preview).mockReturnValueOnce(pending.promise);const old=current.open(row);hooks.dispose();vi.mocked(retiredRagApi.list).mockResolvedValue([]);render();await settle();pending.resolve(plan);await old;await settle();expect(current.items).toEqual([]);expect(current.preview).toBeNull();expect(current.busy).toBe(false);
    });
    it('Double click starts one preview and one physical purge request',async()=>{
        render();await settle();const pending=defer<IRetiredRagPreview>();vi.mocked(retiredRagApi.preview).mockReturnValueOnce(pending.promise);const first=current.open(row);await current.open(row);expect(retiredRagApi.preview).toHaveBeenCalledOnce();pending.resolve(plan);await first;render();
        const drop=defer<any>();vi.mocked(retiredRagApi.purge).mockReturnValueOnce(drop.promise);const work=current.purge();await current.purge();expect(retiredRagApi.purge).toHaveBeenCalledOnce();drop.resolve({id:'own-job'});await work;render();expect(current.preview).toBeNull();
    });
    it('Lost HTTP ACK retains the exact request key for an explicit repeat of the same reviewed plan',async()=>{
        render();await settle();await current.open(row);render();vi.mocked(retiredRagApi.purge).mockRejectedValueOnce({isAxiosError:true,response:{status:503,data:{message:'Сверка продолжается'}}});await current.purge();render();expect(current.preview).toEqual(plan);expect(current.error).toContain('Сверка продолжается');await current.purge();expect(vi.mocked(retiredRagApi.purge).mock.calls[0]).toEqual(vi.mocked(retiredRagApi.purge).mock.calls[1]);expect(retiredRagApi.purge).toHaveBeenCalledWith(row.id,plan,expect.any(String));
    });
    it('403 refresh clears retained data and the destructive preview',async()=>{
        render();await settle();await current.open(row);render();vi.mocked(retiredRagApi.list).mockRejectedValueOnce({response:{status:403}});await current.refresh();render();expect(current.items).toEqual([]);expect(current.preview).toBeNull();expect(current.selected).toBeNull();
    });
    it('A stale inventory response cannot overwrite a newer job receipt after reload/poll',async()=>{
        const old=defer<IRetiredRagDatabase[]>();vi.mocked(retiredRagApi.list).mockReturnValueOnce(old.promise);render();const completed={...row,job:{id:'durable-job',state:'succeeded',message:'Удалена'} as any};vi.mocked(retiredRagApi.list).mockResolvedValueOnce([completed]);await current.refresh();render();old.resolve([row]);await settle();expect(current.items[0].job?.id).toBe('durable-job');
    });
    it('Pending job survives component reload through server inventory; no local destructive request is repeated',async()=>{
        vi.mocked(retiredRagApi.list).mockResolvedValue([{...row,job:{id:'surviving-job',state:'running',digest:'a'.repeat(64)} as any}]);render();await settle();hooks.dispose();render();await settle();expect(current.items[0].job?.id).toBe('surviving-job');expect(retiredRagApi.purge).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(5000);expect(retiredRagApi.list).toHaveBeenCalledTimes(3);
    });
    it('Retention uses the current revision and refreshes the durable inventory',async()=>{render();await settle();await current.retention(row,'2027-01-01T00:00:00Z','Own hold');expect(retiredRagApi.retention).toHaveBeenCalledWith(row,'2027-01-01T00:00:00Z','Own hold');expect(retiredRagApi.list).toHaveBeenCalledTimes(2);});
});
