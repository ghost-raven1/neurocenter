import {createHash} from 'node:crypto';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createTextKnowledgeController, type TextKnowledgeState} from '../src/features/ProjectTextKnowledge/controller';
import {textUploadJournal} from '../src/features/ProjectTextKnowledge/journal';
import type {ProjectTextApi} from '../src/features/ProjectTextKnowledge/api';
import type {TextCorpusState, TextSearchResult, TextUpload, TextUploadReceipt} from '../src/features/ProjectTextKnowledge/model';
import {defaultTextKnowledgeLimits} from '../src/features/ProjectTextKnowledge/limits';

const projectId = 'prj-text', email = 'alice@example.test';
const requestKey = '00000000-0000-0000-0000-000000000001';
const hash = (value:string) => Promise.resolve(createHash('sha256').update(value).digest('hex'));
const corpus = (revision = 0):TextCorpusState => ({mode:'text', projectId, revision, corpusHash:String(revision).repeat(64), documentCount:revision, bytes:revision*32, updatedAt:null});
const result = (revision = 1):TextSearchResult => ({mode:'text', projectId, revision, corpusHash:String(revision).repeat(64), sources:[{id:'hit',path:'README.md',startLine:2,endLine:3,excerpt:'Авторизация пользователя',score:0.8}]});
const file = (content:string, name = 'README.md') => ({name, size:Buffer.byteLength(content), arrayBuffer:async () => new TextEncoder().encode(content).buffer});
const deferred = <T>() => {let resolve!:(value:T) => void; let reject!:(error:unknown) => void; const promise = new Promise<T>((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject};};
const flush = async () => {for(let i=0;i<30;i++) await Promise.resolve();};
let api:ProjectTextApi, state:TextKnowledgeState, enabled:boolean, writable:boolean, owner:string;
let storage:Map<string,string>, records:Map<string,TextUploadReceipt>, nextKey:number;
const storageApi = {getItem:(key:string) => storage.get(key) ?? null, setItem:(key:string,value:string) => {storage.set(key,value);}};
function controller() {
    return createTextKnowledgeController({projectId,email,api,journal:textUploadJournal(storageApi,projectId,email,'controller-alice-main-api'),hash,
        uuid:() => `00000000-0000-0000-0000-${String(++nextKey).padStart(12,'0')}`,
        enabled:() => enabled,canWrite:() => writable,captureOwner:() => {const captured=owner;return () => captured===owner;},onChange:value => {state=value;}});
}
async function accepted(body:TextUpload):Promise<TextUploadReceipt> {
    const receipt:TextUploadReceipt = {...corpus(body.expectedRevision+1),requestKey:body.requestKey,
        requestHash:await hash(JSON.stringify(body)),acceptedAt:'2026-10-29T12:00:00Z'};
    records.set(body.requestKey,receipt); return receipt;
}
beforeEach(() => {
    enabled=true;writable=true;owner='alice';storage=new Map();records=new Map();nextKey=0;
    api={limits:vi.fn(async () => ({revision:1,limits:defaultTextKnowledgeLimits})),state:vi.fn(async () => corpus()), upload:vi.fn(async (_id,body) => accepted(body)), receipt:vi.fn(async (_id,key) => records.get(key) ?? null),search:vi.fn(async () => result())};
});

describe('explicit text upload ownership and recovery', () => {
    it('lost POST ACK reads the same receipt, persists no file bytes, and refreshes authoritative state', async () => {
        const control=controller();control.activate();await flush();await control.selectFiles([file('secret source code')]);
        vi.mocked(api.upload).mockImplementation(async (_id,body) => {await accepted(body);throw Error('Lost ACK');});
        vi.mocked(api.state).mockResolvedValue(corpus(1));await control.upload();
        expect(api.upload).toHaveBeenCalledOnce();expect(api.receipt).toHaveBeenCalledWith(projectId,requestKey,expect.any(AbortSignal));
        expect(state.receipt?.revision).toBe(1);expect(state.corpus?.revision).toBe(1);expect(state.uploadError).toBe('');
        const durable=[...storage.values()][0];expect(durable).not.toContain('secret');expect(durable).not.toContain('README');
        expect(Object.keys(JSON.parse(durable)).sort()).toEqual(['email','expectedRevision','projectId','requestHash','requestKey','version']);control.dispose();
    });
    it('unknown acknowledgement keeps its exact key and rejects altered reselected bytes before another POST', async () => {
        const control=controller();control.activate();await flush();await control.selectFiles([file('original')]);
        vi.mocked(api.upload).mockRejectedValueOnce(Error('network'));await control.upload();
        expect(state.intent?.requestKey).toBe(requestKey);expect(state.documents[0].content).toBe('original');
        await control.selectFiles([file('altered')]);await control.upload();expect(api.upload).toHaveBeenCalledOnce();expect(state.uploadError).toContain('исходные файлы');
        await control.selectFiles([file('original')]);await control.upload();
        expect(api.upload).toHaveBeenCalledTimes(2);expect(vi.mocked(api.upload).mock.calls[1][1]).toEqual(vi.mocked(api.upload).mock.calls[0][1]);control.dispose();
    });
    it('reload recovers an old accepted receipt while retaining a newer authoritative corpus and allows read recovery OFF', async () => {
        const control=controller();control.activate();await flush();await control.selectFiles([file('first')]);await control.upload();control.dispose();
        enabled=false;vi.mocked(api.state).mockResolvedValue(corpus(8));const reloaded=controller();reloaded.activate();await flush();
        expect(state.receipt?.revision).toBe(1);expect(state.corpus?.revision).toBe(8);expect(state.documents).toEqual([]);
        await reloaded.selectFiles([file('never sent')]);await reloaded.upload();expect(api.upload).toHaveBeenCalledOnce();reloaded.dispose();
    });
    it('409 preserves files/query, refreshes revision and requires explicit rebase before a new key', async () => {
        const control=controller();control.activate();await flush();control.setQuery('авторизация');await control.selectFiles([file('draft')]);
        vi.mocked(api.state).mockResolvedValue(corpus(4));vi.mocked(api.upload).mockRejectedValueOnce({isAxiosError:true,response:{status:409,data:{message:'Ревизия изменилась'}}});
        await control.upload();expect(state.documents[0].content).toBe('draft');expect(state.query).toBe('авторизация');expect(state.canRebase).toBe(true);
        expect(state.corpus?.revision).toBe(4);control.rebase();await control.upload();
        const second=vi.mocked(api.upload).mock.calls[1][1];expect(second.requestKey).not.toBe(requestKey);expect(second.expectedRevision).toBe(4);control.dispose();
    });
    it('permission error and unavailable receipt preserve the draft and never imply acceptance', async () => {
        const control=controller();control.activate();await flush();await control.selectFiles([file('keep this')]);
        vi.mocked(api.upload).mockRejectedValue({isAxiosError:true,response:{status:403}});vi.mocked(api.receipt).mockRejectedValue(Error('no read access'));
        await control.upload();expect(state.documents[0].content).toBe('keep this');expect(state.receipt).toBeUndefined();expect(state.intent).toBeTruthy();
        writable=false;await control.upload();expect(api.upload).toHaveBeenCalledOnce();control.dispose();
    });
    it('a changed auth owner before cleanup rejects a late ACK and an aborted project controller cannot repaint', async () => {
        const ack=deferred<TextUploadReceipt>();const control=controller();control.activate();await flush();await control.selectFiles([file('A')]);
        vi.mocked(api.upload).mockReturnValue(ack.promise);const upload=control.upload();await flush();const old=state;
        owner='bob';ack.resolve(await accepted(vi.mocked(api.upload).mock.calls[0][1]));await upload;
        expect(state).toBe(old);expect(state.receipt).toBeUndefined();control.dispose();
    });
    it('corrupt journal is preserved and blocks uploads without blocking state reads', async () => {
        storage.set(`neurocenter:text-upload:v1:controller-alice-main-api:${projectId}`,'{broken');
        const control=controller();control.activate();await flush();await control.selectFiles([file('new')]);await control.upload();
        expect(state.journalError).toContain('повреждён');expect(state.corpus).toBeTruthy();expect(api.upload).not.toHaveBeenCalled();expect([...storage.values()]).toContain('{broken');control.dispose();
    });
    it('storage write failure never sends a mutation', async () => {
        const control=createTextKnowledgeController({projectId,email,api,journal:{read:()=>null,write:()=>{throw Error('quota');}},hash,uuid:()=>requestKey,
            enabled:()=>true,canWrite:()=>true,captureOwner:()=>()=>true,onChange:value=>{state=value;}});
        control.activate();await flush();await control.selectFiles([file('draft')]);await control.upload();
        expect(api.upload).not.toHaveBeenCalled();expect(state.documents).toHaveLength(1);expect(state.uploadError).toContain('не отправлена');control.dispose();
    });
    it('dispose aborts a pending upload and refuses its late success', async () => {
        const ack=deferred<TextUploadReceipt>();const control=controller();control.activate();await flush();await control.selectFiles([file('A')]);
        vi.mocked(api.upload).mockReturnValue(ack.promise);const upload=control.upload();await flush();const previous=state;
        const [,_body,signal]=vi.mocked(api.upload).mock.calls[0];control.dispose();expect(signal?.aborted).toBe(true);
        ack.resolve(await accepted(_body));await upload;expect(state).toBe(previous);
    });
    it('lowered effective limits preserve the old unknown intent for exact replay and block larger NEW files', async () => {
        const control=controller();control.activate();await flush();await control.selectFiles([file('1234567890')]);
        vi.mocked(api.upload).mockRejectedValueOnce(Error('network'));await control.upload();
        vi.mocked(api.limits).mockResolvedValue({revision:2,limits:{...defaultTextKnowledgeLimits,fileBytes:4}});await control.refreshLimits();
        await control.selectFiles([file('1234567890')]);await control.upload();expect(api.upload).toHaveBeenCalledTimes(2);
        expect(vi.mocked(api.upload).mock.calls[1][1]).toEqual(vi.mocked(api.upload).mock.calls[0][1]);
        await control.selectFiles([file('too large')]);expect(state.documents).toEqual([]);expect(state.uploadError).toContain('превышает');control.dispose();
    });
    it('unavailable limits never guess a new admission and retain the selected draft', async () => {
        const control=controller();control.activate();await flush();await control.selectFiles([file('saved')]);
        vi.mocked(api.limits).mockRejectedValue(Error('policy offline'));await control.upload();
        expect(api.upload).not.toHaveBeenCalled();expect(state.documents[0].content).toBe('saved');expect(state.limitsError).toBe('policy offline');control.dispose();
    });
});

describe('revision-bound word search', () => {
    it('shows verified source lines and invalidates the old result when query or corpus changes', async () => {
        vi.mocked(api.state).mockResolvedValue(corpus(1));const control=controller();control.activate();await flush();control.setQuery('Авторизация');await control.search();
        expect(api.search).toHaveBeenCalledWith(projectId,'Авторизация',1,expect.any(AbortSignal));expect(state.result?.sources[0].startLine).toBe(2);
        control.setQuery('другое');expect(state.result).toBeUndefined();await control.search();vi.mocked(api.state).mockResolvedValue(corpus(2));await control.refresh();expect(state.result).toBeUndefined();control.dispose();
    });
    it('a held search ACK cannot attach former sources after query changes or OFF', async () => {
        vi.mocked(api.state).mockResolvedValue(corpus(1));const control=controller();control.activate();await flush();control.setQuery('first');
        const ack=deferred<TextSearchResult>();vi.mocked(api.search).mockReturnValue(ack.promise);const pending=control.search();await flush();control.setQuery('second');enabled=false;ack.resolve(result());await pending;
        expect(state.result).toBeUndefined();expect(state.query).toBe('second');await control.search();expect(api.search).toHaveBeenCalledOnce();control.dispose();
    });
    it('a mismatched result is rejected, empty results remain empty, and read denial clears old citations', async () => {
        vi.mocked(api.state).mockResolvedValue(corpus(1));const control=controller();control.activate();await flush();control.setQuery('слово');
        vi.mocked(api.search).mockResolvedValueOnce(result(2));await control.search();expect(state.result).toBeUndefined();expect(state.searchError).toContain('изменилась');
        vi.mocked(api.search).mockResolvedValueOnce({...result(),sources:[]});await control.search();expect(state.result?.sources).toEqual([]);
        vi.mocked(api.state).mockRejectedValue({response:{status:403}});await control.refresh();expect(state.result).toBeUndefined();expect(state.corpus).toBeUndefined();expect(state.query).toBe('слово');control.dispose();
    });
    it('a late old state response never rolls the current corpus back', async () => {
        const old=deferred<TextCorpusState>();vi.mocked(api.state).mockReturnValueOnce(old.promise).mockResolvedValue(corpus(7));
        const control=controller();control.activate();await control.refresh();old.resolve(corpus(1));await flush();expect(state.corpus?.revision).toBe(7);control.dispose();
    });
});
