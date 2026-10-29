// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {DEFAULT_RUNTIME_LIMIT_POLICY,RUNTIME_LIMIT_CEILINGS} from '@neurocenter/runtime-limits';
import {useRuntimeLimits} from '../src/features/RuntimeLimits/useRuntimeLimits';
import {baseApi} from '../src/core/api';
import {durableJournalOwner} from '../src/features/UserBlock/durableJournalOwner';
const owner=vi.hoisted(()=>({current:true,scope:'main-admin-fixture',id:'alice-id',email:'alice@example.test',role:'Главный админ',capture:()=>{const captured=owner.scope;return()=>owner.current&&captured===owner.scope;}}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:owner.scope,captureOwner:owner.capture})}));
vi.mock('react-redux',()=>({useSelector:(select:(state:unknown)=>unknown)=>select({userBlock:{user:{id:owner.id,email:owner.email,activeRole:owner.role}}})}));
vi.mock('../src/core/api',()=>({baseApi:{get:vi.fn(),patch:vi.fn(),defaults:{baseURL:'http://runtime-limits.test'}}}));
const view=(revision=0,enabled=true)=>({revision,policy:structuredClone(DEFAULT_RUNTIME_LIMIT_POLICY),ceilings:RUNTIME_LIMIT_CEILINGS,updatedAt:null,configurationEnabled:enabled});
const receipt=(input:any,revision=1)=>({requestKey:input.requestKey,requestHash:'a'.repeat(64),policy:input.policy,revision,acceptedAt:'2026-10-29T00:00:00Z'});
const cleanups:Array<()=>void>=[];
function renderHook(hook:()=>ReturnType<typeof useRuntimeLimits>){
    let current!:ReturnType<typeof useRuntimeLimits>,mounted=true;const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);
    const Probe=()=>{current=hook();return null;};act(()=>root.render(createElement(Probe)));
    const unmount=()=>{if(mounted){act(()=>root.unmount());container.remove();mounted=false;}};cleanups.push(unmount);
    return {result:{get current(){return current;}},unmount,rerender:()=>act(()=>root.render(createElement(Probe)))};
}
const waitFor=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{await Promise.resolve();});check();},{timeout:1200,interval:5});
beforeEach(()=>{localStorage.clear();owner.current=true;owner.scope='main-admin-fixture';owner.id='alice-id';owner.email='alice@example.test';owner.role='Главный админ';vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('crypto',{randomUUID:()=>webcrypto.randomUUID()});vi.mocked(baseApi.get).mockReset().mockResolvedValue({data:view()});vi.mocked(baseApi.patch).mockReset();});
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function fixture(){const f=renderHook(()=>useRuntimeLimits());await waitFor(()=>expect(f.result.current.view).toBeDefined());return f;}

describe('Main administrator edits real runtime limits',()=>{
    it('loads effective policy, saves changed fields with CAS and removes the durable pending journal on ACK',async()=>{
        const f=await fixture();act(()=>f.result.current.change('textKnowledge','documents',8));
        vi.mocked(baseApi.patch).mockImplementation(async(_path,input)=>({data:receipt(input)}));
        await act(async()=>{await f.result.current.save();});
        expect(baseApi.patch).toHaveBeenCalledOnce();expect(vi.mocked(baseApi.patch).mock.calls[0][1]).toMatchObject({expectedRevision:0,policy:{textKnowledge:{documents:8}}});
        expect(f.result.current.pending).toBeUndefined();expect(f.result.current.view?.revision).toBe(1);expect(f.result.current.stale).toBe(false);expect(f.result.current.dirty).toBe(false);expect(localStorage.length).toBe(0);
    });
    it('network ambiguity locks the intent; explicit retry sends the identical key and policy',async()=>{
        const f=await fixture();act(()=>f.result.current.change('textKnowledge','sources',2));vi.mocked(baseApi.patch).mockRejectedValueOnce(Error('network unavailable'));
        await act(async()=>{await f.result.current.save();});const accepted=vi.mocked(baseApi.patch).mock.calls[0][1];
        expect(f.result.current.pending).toEqual(accepted);act(()=>f.result.current.change('textKnowledge','sources',4));expect(f.result.current.draft?.textKnowledge.sources).toBe(2);
        vi.mocked(baseApi.patch).mockImplementation(async(_path,input)=>({data:receipt(input)}));await act(async()=>{await f.result.current.save();});
        expect(vi.mocked(baseApi.patch).mock.calls[1][1]).toEqual(accepted);expect(f.result.current.pending).toBeUndefined();
    });
    it('reload recovers the same journal and reads its own receipt even while configuration is OFF',async()=>{
        const f=await fixture();act(()=>f.result.current.change('textKnowledge','sources',2));vi.mocked(baseApi.patch).mockRejectedValueOnce(Error('ACK lost'));
        await act(async()=>{await f.result.current.save();});const input=f.result.current.pending!;f.unmount();
        vi.mocked(baseApi.get).mockResolvedValueOnce({data:view(1,false)}).mockResolvedValueOnce({data:receipt(input)});
        const next=await fixture();expect(next.result.current.pending).toEqual(input);await act(async()=>{await next.result.current.receipt();});
        expect(next.result.current.pending).toBeUndefined();expect(localStorage.length).toBe(0);expect(baseApi.patch).toHaveBeenCalledOnce();
    });
    it('a missing receipt retains the key because absence does not prove a failed commit',async()=>{
        const f=await fixture();act(()=>f.result.current.change('textKnowledge','sources',2));vi.mocked(baseApi.patch).mockRejectedValueOnce(Error('ACK lost'));
        await act(async()=>{await f.result.current.save();});const key=f.result.current.pending?.requestKey;
        vi.mocked(baseApi.get).mockRejectedValueOnce({response:{status:404}});await act(async()=>{await f.result.current.receipt();});
        expect(f.result.current.pending?.requestKey).toBe(key);expect(f.result.current.error).toContain('не подтверждает отказ');
    });
    it('CAS conflict preserves the draft and requires an explicit current-revision choice',async()=>{
        const f=await fixture();act(()=>f.result.current.change('textKnowledge','sources',2));vi.mocked(baseApi.patch).mockRejectedValueOnce({response:{status:409,data:{message:'Лимиты изменились'}}});
        await act(async()=>{await f.result.current.save();});expect(f.result.current.pending).toBeUndefined();expect(f.result.current.draft?.textKnowledge.sources).toBe(2);
        vi.mocked(baseApi.get).mockResolvedValueOnce({data:view(2)});await act(async()=>{await f.result.current.read();});expect(f.result.current.stale).toBe(true);
        await act(async()=>{await f.result.current.save();});expect(baseApi.patch).toHaveBeenCalledOnce();
        act(()=>f.result.current.keepDraft());vi.mocked(baseApi.patch).mockImplementation(async(_path,input)=>({data:receipt(input,3)}));await act(async()=>{await f.result.current.save();});
        expect(vi.mocked(baseApi.patch).mock.calls[1][1]).toMatchObject({expectedRevision:2,policy:{textKnowledge:{sources:2}}});
    });
    it('OFF and a stale account cannot dispatch a new configuration or accept a late read',async()=>{
        vi.mocked(baseApi.get).mockResolvedValueOnce({data:view(0,false)});const f=await fixture();act(()=>f.result.current.change('textKnowledge','sources',2));
        await act(async()=>{await f.result.current.save();});expect(baseApi.patch).not.toHaveBeenCalled();f.unmount();
        let resolve!:(value:any)=>void;vi.mocked(baseApi.get).mockImplementationOnce(()=>new Promise(yes=>{resolve=yes;}));
        const next=renderHook(()=>useRuntimeLimits());owner.current=false;await act(async()=>{resolve({data:view()});});
        expect(next.result.current.view).toBeUndefined();await act(async()=>{await next.result.current.save();});expect(baseApi.patch).not.toHaveBeenCalled();
    });

    it('a post-COMMIT 403 retains the exact recovery key until authorization is restored',async()=>{
        const f=await fixture();act(()=>f.result.current.change('textKnowledge','sources',2));
        vi.mocked(baseApi.patch).mockRejectedValueOnce({response:{status:403,data:{message:'Role revoked after commit'}}});
        await act(async()=>{await f.result.current.save();});const intent=vi.mocked(baseApi.patch).mock.calls[0][1]as any;
        expect(f.result.current.pending?.requestKey).toBe(intent.requestKey);expect(localStorage.length).toBe(1);
        vi.mocked(baseApi.get).mockResolvedValueOnce({data:receipt(intent)});await act(async()=>{await f.result.current.receipt();});
        expect(f.result.current.pending).toBeUndefined();expect(baseApi.patch).toHaveBeenCalledOnce();
    });

    it.each(['another-account','same-account-observer-role'])('fences old owner state on mounted %s switch and preserves the old journal',async nextScope=>{
        const f=await fixture();act(()=>f.result.current.change('textKnowledge','sources',2));vi.mocked(baseApi.patch).mockRejectedValueOnce(Error('ACK lost'));
        await act(async()=>{await f.result.current.save();});const oldKey=localStorage.key(0)!,oldJournal=localStorage.getItem(oldKey),oldRequest=f.result.current.pending?.requestKey;
        let resolve!:(value:any)=>void;vi.mocked(baseApi.get).mockImplementationOnce(()=>new Promise(yes=>{resolve=yes;}));
        owner.scope=nextScope;if(nextScope==='another-account'){owner.id='bob-id';owner.email='bob@example.test';}else owner.role='Наблюдатель';f.rerender();
        expect(f.result.current.pending).toBeUndefined();expect(f.result.current.view).toBeUndefined();expect(f.result.current.draft).toBeUndefined();
        await act(async()=>{await f.result.current.save();});expect(baseApi.patch).toHaveBeenCalledOnce();
        await act(async()=>{resolve({data:view()});});expect(f.result.current.draft?.textKnowledge.sources).toBe(DEFAULT_RUNTIME_LIMIT_POLICY.textKnowledge.sources);
        await act(async()=>{await f.result.current.save();});expect(baseApi.patch).toHaveBeenCalledOnce();
        act(()=>f.result.current.change('textKnowledge','sources',4));vi.mocked(baseApi.patch).mockImplementation(async(_path,input)=>({data:receipt(input)}));
        await act(async()=>{await f.result.current.save();});expect((vi.mocked(baseApi.patch).mock.calls[1][1]as any).requestKey).not.toBe(oldRequest);
        expect(localStorage.getItem(oldKey)).toBe(oldJournal);
    });

    it('successful reads never erase a corrupt journal warning or overwrite unknown recovery bytes',async()=>{
        const key='neurocenter:runtime-limits:'+durableJournalOwner({id:owner.id,email:owner.email,activeRole:owner.role},'http://runtime-limits.test'),raw='{"requestKey":"unknown-pending-intent"';localStorage.setItem(key,raw);
        const f=await fixture();expect(f.result.current.error).toMatch(/журнал.*повреждён/);
        act(()=>f.result.current.change('textKnowledge','sources',2));await act(async()=>{await f.result.current.save();});
        expect(baseApi.patch).not.toHaveBeenCalled();expect(localStorage.getItem(key)).toBe(raw);
        await act(async()=>{await f.result.current.read();});expect(f.result.current.error).toMatch(/журнал.*повреждён/);expect(localStorage.getItem(key)).toBe(raw);
    });

    it.each(['revision-type','wrong-revision','invalid-date','invalid-hash'])('malformed %s ACK does not confirm or erase the pending intent',async invalid=>{
        const f=await fixture();act(()=>f.result.current.change('textKnowledge','sources',2));
        vi.mocked(baseApi.patch).mockImplementation(async(_path,input)=>({data:{...receipt(input),
            ...(invalid==='revision-type'?{revision:'1'}:invalid==='wrong-revision'?{revision:2}:invalid==='invalid-date'?{acceptedAt:'not-a-date'}:{requestHash:'invalid'})}}));
        await act(async()=>{await f.result.current.save();});expect(f.result.current.pending).toBeDefined();expect(localStorage.length).toBe(1);
        expect(f.result.current.notice).toBe('');expect(f.result.current.view?.revision).toBe(0);
    });

    it('same principal with changed permissions recovers a post-COMMIT403 through the same journal and receipt',async()=>{
        const f=await fixture();act(()=>f.result.current.change('textKnowledge','sources',2));vi.mocked(baseApi.patch).mockRejectedValueOnce({response:{status:403}});
        await act(async()=>{await f.result.current.save();});const intent=f.result.current.pending!,key=localStorage.key(0)!;
        owner.scope='same-alice-main-new-project-and-policy';vi.mocked(baseApi.get).mockResolvedValueOnce({data:view(1)});f.rerender();
        await waitFor(()=>expect(f.result.current.view).toBeDefined());expect(f.result.current.pending?.requestKey).toBe(intent.requestKey);expect(localStorage.key(0)).toBe(key);
        vi.mocked(baseApi.get).mockResolvedValueOnce({data:receipt(intent)});await act(async()=>{await f.result.current.receipt();});
        expect(f.result.current.pending).toBeUndefined();expect(baseApi.patch).toHaveBeenCalledOnce();expect(localStorage.length).toBe(0);
    });

    it('a late ACK from the previous permission scope cannot confirm the restored same-principal journal',async()=>{
        const f=await fixture();act(()=>f.result.current.change('textKnowledge','sources',2));let resolve!:(value:any)=>void;
        vi.mocked(baseApi.patch).mockImplementationOnce(()=>new Promise(yes=>{resolve=yes;}));let running!:Promise<void>;
        await act(async()=>{running=f.result.current.save();await Promise.resolve();});const intent=f.result.current.pending!;
        owner.scope='same-alice-main-permissions-v2';vi.mocked(baseApi.get).mockResolvedValueOnce({data:view(1)});f.rerender();
        await waitFor(()=>expect(f.result.current.view).toBeDefined());await act(async()=>{resolve({data:receipt(intent)});await running;});
        expect(f.result.current.pending?.requestKey).toBe(intent.requestKey);expect(f.result.current.notice).toBe('');expect(localStorage.length).toBe(1);
    });
});
