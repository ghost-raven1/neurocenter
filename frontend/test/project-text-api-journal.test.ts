import {beforeEach, describe, expect, it, vi} from 'vitest';
import {projectTextApi} from '../src/features/ProjectTextKnowledge/api';
import instance from '../src/core/api/base';
import {textUploadJournal, type TextUploadIntent} from '../src/features/ProjectTextKnowledge/journal';
import {defaultTextKnowledgeLimits as limits} from '../src/features/ProjectTextKnowledge/limits';
import {durableJournalOwner} from '../src/features/UserBlock/durableJournalOwner';

vi.mock('../src/core/api/base',()=>({default:{get:vi.fn(),post:vi.fn()}}));
const requestKey='00000000-0000-0000-0000-000000000001',projectId='prj-encoded project';
const corpus={mode:'text',projectId,revision:1,corpusHash:'a'.repeat(64),documentCount:1,bytes:10,updatedAt:null};
const receipt={...corpus,requestKey,requestHash:'b'.repeat(64),acceptedAt:'2026-10-29T12:00:00Z',admission:{revision:7,limits}};
beforeEach(()=>vi.resetAllMocks());

describe('text API uses the authenticated client and validates transport data',()=>{
    it('encodes project context and sends the original upload identity with its abort signal',async()=>{
        const body={requestKey,expectedRevision:0,documents:[{path:'README.md',content:'Русский текст\n'}]},abort=new AbortController();
        vi.mocked(instance.post).mockResolvedValue({data:receipt});const value=await projectTextApi.upload(projectId,body,abort.signal);
        expect(instance.post).toHaveBeenCalledWith('/api/projects/prj-encoded%20project/knowledge/text/documents',body,{signal:abort.signal});
        expect(value.admission).toEqual({revision:7,limits});expect(value.requestKey).toBe(requestKey);
    });
    it('receipt lookup remains an independent GET, including null and accepted admission history',async()=>{
        vi.mocked(instance.get).mockResolvedValueOnce({data:null}).mockResolvedValueOnce({data:receipt});
        expect(await projectTextApi.receipt(projectId,requestKey)).toBeNull();expect((await projectTextApi.receipt(projectId,requestKey))?.admission?.revision).toBe(7);
        expect(instance.get).toHaveBeenCalledWith(`/api/projects/prj-encoded%20project/knowledge/text/requests/${requestKey}`,{signal:undefined});
        expect(instance.post).not.toHaveBeenCalled();
    });
    it('only a 404 explicitly identifies the legacy default policy; network and malformed success never guess limits',async()=>{
        vi.mocked(instance.get).mockRejectedValueOnce({response:{status:404}});
        expect(await projectTextApi.limits()).toEqual({revision:0,limits,legacy:true});
        vi.mocked(instance.get).mockRejectedValueOnce(Error('offline'));await expect(projectTextApi.limits()).rejects.toThrow('offline');
        vi.mocked(instance.get).mockResolvedValueOnce({data:{revision:2}});await expect(projectTextApi.limits()).rejects.toThrow();
    });
    it('a valid configurable policy can exceed old product defaults but not technical bounds',async()=>{
        const effective={...limits,documents:limits.documents+1};vi.mocked(instance.get).mockResolvedValueOnce({data:{revision:9,policy:{textKnowledge:effective}}});
        expect(await projectTextApi.limits()).toEqual({revision:9,limits:effective});
        vi.mocked(instance.get).mockResolvedValueOnce({data:{revision:10,policy:{textKnowledge:{...effective,documents:Infinity}}}});await expect(projectTextApi.limits()).rejects.toThrow();
    });
    it('never shows a response from another project or a forged source as an accepted result',async()=>{
        vi.mocked(instance.get).mockResolvedValueOnce({data:{...corpus,projectId:'prj-other'}});await expect(projectTextApi.state(projectId)).rejects.toThrow();
        vi.mocked(instance.post).mockResolvedValueOnce({data:{...corpus,sources:[{id:'source',path:'doc',startLine:0,endLine:2,excerpt:'fake',score:0.5}]}});
        await expect(projectTextApi.search(projectId,'слово',1)).rejects.toThrow();
    });
});

describe('receipt journal preserves unresolved or damaged storage',()=>{
    const intent:TextUploadIntent={version:1,email:'alice@test',projectId,requestKey,expectedRevision:0,requestHash:'a'.repeat(64)};
    const journalOwner=durableJournalOwner({id:'alice',email:intent.email,activeRole:'Главный админ'},'https://test-api');
    it('a corrupt record is preserved even if corruption appears after the panel was opened',()=>{
        const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,raw:string)=>{values.set(key,raw);}};
        const journal=textUploadJournal(storage,projectId,intent.email,journalOwner);journal.write(intent);expect(journal.read()).toEqual(intent);
        const key=[...values.keys()][0];values.set(key,'bad-json');expect(()=>journal.write({...intent,requestKey:'00000000-0000-0000-0000-000000000002'},intent.requestKey)).toThrow();expect(values.get(key)).toBe('bad-json');
    });
    it('does not overwrite a newer known request written by another panel',()=>{
        const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,raw:string)=>{values.set(key,raw);}};
        const first=textUploadJournal(storage,projectId,intent.email,journalOwner),second=textUploadJournal(storage,projectId,intent.email,journalOwner);
        expect(first.read()).toBeNull();second.write(intent);
        expect(()=>first.write({...intent,requestKey:'00000000-0000-0000-0000-000000000002'})).toThrow('другой вкладке');expect(second.read()).toEqual(intent);
    });
    it('stable principal/API journals survive changed grants but isolate another principal, role or API',()=>{
        const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,raw:string)=>{values.set(key,raw);}};
        const principal={id:'alice-id',email:intent.email,activeRole:'Главный админ'},api='https://api-a.test';
        const owner=durableJournalOwner(principal,api);textUploadJournal(storage,projectId,intent.email,owner).write(intent);
        const changedGrants={...principal,projectRoles:['new-project'],policies:{more:['routes']}};
        expect(textUploadJournal(storage,projectId,intent.email,durableJournalOwner(changedGrants,api)).read()?.requestKey).toBe(intent.requestKey);
        for(const different of [durableJournalOwner({...principal,id:'new-account'},api),durableJournalOwner({...principal,email:'bob@test'},api),
            durableJournalOwner({...principal,activeRole:'Наблюдатель'},api),durableJournalOwner(principal,'https://api-b.test')]){
            expect(textUploadJournal(storage,projectId,intent.email,different).read()).toBeNull();
        }
        expect(values.size).toBe(1);
    });
});
