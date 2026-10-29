import {randomUUID} from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createPersonalAccessController,type PersonalAccessState} from '../src/features/RemoteProviderAccess/controller';
import type {PersonalProviderApi} from '../src/features/RemoteProviderAccess/api';
import type {PersonalProviderIntent,PersonalProviderReceipt,PersonalProviderView} from '../src/features/RemoteProviderAccess/model';
const modelId='model-personal',providerId='a'.repeat(64),journal='owned-personal-journal';
const original:PersonalProviderView={modelId,providerId,providerUrl:'https://provider.test/v1',connectionRevision:2,authMode:'required',credentialRevision:0,hasKey:false,updatedAt:null,canStoreKey:true,legacySharedKeyRetained:true};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
let api:PersonalProviderApi,state:PersonalAccessState,values:Map<string,string>,owner:string,enabled:boolean,view:PersonalProviderView,receipts:Map<string,PersonalProviderReceipt>;
const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
function controller(){return createPersonalAccessController({modelId,api,storage,journal,uuid:randomUUID,enabled:()=>enabled,captureOwner:()=>{const at=owner;return()=>owner===at;},onChange:value=>{state=value;}});}
const accepted=(intent:PersonalProviderIntent):PersonalProviderReceipt=>({modelId,providerId:intent.providerId,requestKey:intent.requestKey,requestHash:'b'.repeat(64),connectionRevision:intent.expectedConnectionRevision,credentialRevision:intent.expectedCredentialRevision+1,hasKey:intent.action==='save',acceptedAt:'2026-10-29T12:00:00Z'});
beforeEach(()=>{values=new Map();owner='alice';enabled=true;view={...original};receipts=new Map();api={read:vi.fn(async()=>view),receipt:vi.fn(async(_id,key)=>receipts.get(key)??null),write:vi.fn(async(_id,intent)=>{const receipt=accepted(intent);receipts.set(intent.requestKey,receipt);view={...view,credentialRevision:receipt.credentialRevision,hasKey:receipt.hasKey};return receipt;})};});

describe('personal key draft and receipt identity',()=>{
    it('saves/removes only the personal operation and never persists its secret',async()=>{
        const control=controller();control.activate();await flush();control.setSecret('private-alice-key');await control.save();
        expect(api.write).toHaveBeenCalledOnce();expect(state.secret).toBe('');expect(state.view?.hasKey).toBe(true);expect(values.size).toBe(0);
        await control.remove();expect(vi.mocked(api.write).mock.calls[1][1].action).toBe('delete');expect(vi.mocked(api.write).mock.calls[1][2]).toBe('');expect(state.view?.hasKey).toBe(false);control.dispose();
    });
    it('lost ACK preserves metadata and exact key, keeps secret in memory and recovers an accepted old operation OFF',async()=>{
        const control=controller();control.activate();await flush();control.setSecret('private-only-memory');vi.mocked(api.write).mockRejectedValueOnce(Error('lost ACK'));await control.save();
        const intent=state.pending!;expect(state.secret).toBe('private-only-memory');expect([...values.values()].join()).not.toContain('private-only-memory');expect(JSON.parse(values.get(journal)!)).toEqual(intent);
        control.dispose();enabled=false;receipts.set(intent.requestKey,accepted(intent));view={...view,credentialRevision:8,hasKey:true};const restored=controller();restored.activate();await flush();
        expect(state.pending).toBeUndefined();expect(state.secret).toBe('');expect(state.receipt?.credentialRevision).toBe(1);expect(state.view?.credentialRevision).toBe(8);expect(api.write).toHaveBeenCalledOnce();restored.dispose();
    });
    it('403 after COMMIT retains the UUID until read permission returns, including a controller reload',async()=>{
        const control=controller();control.activate();await flush();control.setSecret('saved-before-revoke');
        vi.mocked(api.write).mockImplementationOnce(async(_id,intent)=>{receipts.set(intent.requestKey,accepted(intent));throw{response:{status:403}};});vi.mocked(api.receipt).mockRejectedValueOnce({response:{status:403}});
        await control.save();const key=state.pending?.requestKey;expect(key).toBeTruthy();expect(state.secret).toBe('saved-before-revoke');expect(values.has(journal)).toBe(true);control.dispose();
        const restored=controller();restored.activate();await flush();expect(state.receipt?.requestKey).toBe(key);expect(values.has(journal)).toBe(false);expect(api.write).toHaveBeenCalledOnce();restored.dispose();
    });
    it('unknown receipt replays the same operation identity; revision conflict requires an explicit choice',async()=>{
        const control=controller();control.activate();await flush();control.setSecret('same-key');vi.mocked(api.write).mockRejectedValueOnce(Error('network'));await control.save();const first=state.pending;
        vi.mocked(api.write).mockRejectedValueOnce({response:{status:409}});view={...view,credentialRevision:4};await control.save();
        expect(vi.mocked(api.write).mock.calls[1][1]).toEqual(first);expect(state.canRebase).toBe(true);expect(state.secret).toBe('same-key');control.rebase();await control.save();
        const last=vi.mocked(api.write).mock.calls[2][1];expect(last.requestKey).not.toBe(first?.requestKey);expect(last.expectedCredentialRevision).toBe(4);control.dispose();
    });
    it('corrupt journal and a failed storage write block new mutations without erasing the key draft',async()=>{
        values.set(journal,'{broken');const control=controller();control.activate();await flush();control.setSecret('draft');await control.save();expect(api.write).not.toHaveBeenCalled();expect(values.get(journal)).toBe('{broken');expect(state.journalError).toContain('повреждён');control.dispose();
        values.clear();const failing=createPersonalAccessController({modelId,api,storage:{...storage,setItem:()=>{throw Error('disk');}},journal,uuid:randomUUID,enabled:()=>true,captureOwner:()=>()=>true,onChange:value=>{state=value;}});
        failing.activate();await flush();failing.setSecret('draft');await failing.save();expect(api.write).not.toHaveBeenCalled();expect(state.secret).toBe('draft');failing.dispose();
    });
    it('a late response for the former auth owner does not confirm or erase that owner journal',async()=>{
        const control=controller();control.activate();await flush();control.setSecret('alice');let finish!:(value:PersonalProviderReceipt)=>void;
        vi.mocked(api.write).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const pending=control.save();await flush();const old=state,intent=state.pending!;owner='bob';finish(accepted(intent));await pending;
        expect(state).toBe(old);expect(values.has(journal)).toBe(true);control.dispose();
    });
    it('malformed accepted revision never clears the journal or secret',async()=>{
        const control=controller();control.activate();await flush();control.setSecret('retain');vi.mocked(api.write).mockImplementationOnce(async(_id,intent)=>({...accepted(intent),credentialRevision:7}));
        await control.save();expect(state.pending).toBeTruthy();expect(state.secret).toBe('retain');expect(values.has(journal)).toBe(true);control.dispose();
    });
    it('a receipt GET never claims the current field was saved and keeps an unsent replacement draft',async()=>{
        const control=controller();control.activate();await flush();control.setSecret('original');vi.mocked(api.write).mockRejectedValueOnce(Error('network'));await control.save();const intent=state.pending!;
        control.setSecret('new-unsent-value');receipts.set(intent.requestKey,accepted(intent));await control.recover();expect(state.secret).toBe('new-unsent-value');expect(state.notice).toContain('новая настройка не отправлялась');control.dispose();
    });
    it('an advanced provider with no receipt permits explicit recovery even if none mode no longer needs a key',async()=>{
        const control=controller();control.activate();await flush();control.setSecret('old');vi.mocked(api.write).mockRejectedValueOnce(Error('network'));await control.save();control.dispose();
        view={...view,connectionRevision:3,authMode:'none'};const restored=controller();restored.activate();await flush();expect(state.canRebase).toBe(true);restored.rebase();
        expect(state.pending).toBeUndefined();expect(values.has(journal)).toBe(false);expect(api.write).toHaveBeenCalledOnce();restored.dispose();
    });
});
