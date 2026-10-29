import {describe,expect,it,vi} from 'vitest';
import {readCliJob,newerCliJob} from '../src/features/ComputerSetup/model';
import type {CliIntent} from '../src/features/ComputerSetup/model';
import {cliStorageKey,readCliIntent,writeCliIntent} from '../src/features/ComputerSetup/storage';
import {normalizeOpenCodeCliRequest} from '../../services/shared/computer-setup.cjs';

const email='owner@example.test',deviceId='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222',requestKey='33333333-3333-4333-8333-333333333333';
const at='2026-10-28T00:00:00.000Z';
const observed=(status='installed')=>({schemaVersion:1,scope:'global',deviceId,jobId,checkedAt:at,status,...(status==='installed'?{version:'1.14.48'}:{})});
const job=(changes:Record<string,unknown>={})=>({id:jobId,deviceId,kind:'inspect-opencode-cli',projectId:null,state:'succeeded',createdAt:at,updatedAt:at,result:observed(),...changes});
const intent:CliIntent={version:1,email,role:'Наблюдатель',request:{deviceId,kind:'inspect-opencode-cli',scope:'global',requestKey}};
const store=(value:string|null)=>{let raw=value;return {getItem:vi.fn(()=>raw),setItem:vi.fn((_key:string,next:string)=>{raw=next;}),value:()=>raw};};

describe('User CLI observation truthfulness and target identity',()=>{
    it('uppercase UUIDs never become a different accepted target or job',()=>{
        const upperDevice='A1111111-1111-4111-8111-111111111111',upperJob='B2222222-2222-4222-8222-222222222222';
        expect(()=>normalizeOpenCodeCliRequest({...intent.request,deviceId:upperDevice})).toThrow();
        expect(()=>readCliJob(job({deviceId:upperDevice,state:'running'}),upperDevice)).toThrow();
        expect(()=>readCliJob(job({id:upperJob,state:'running'}),deviceId)).toThrow();
    });
    it.each(['installed','missing','failed','timed-out'])('Only a validated %s receipt becomes an observation',status=>{
        const value=readCliJob(job({state:['installed','missing'].includes(status)?'succeeded':'failed',result:observed(status)}),deviceId,jobId);
        expect(value.observation?.status).toBe(status);
        expect(value.observation&&'version' in value.observation).toBe(status==='installed');
    });
    it.each([{},null,undefined])('Worker or admission failure %j never invents a CLI version/status/time',result=>{
        expect(readCliJob(job({state:'failed',result}),deviceId,jobId).observation).toBeUndefined();
    });
    it.each([{deviceId:requestKey},{jobId:requestKey},{stdout:'private output'},{path:'/private/opencode'},{checkedAt:'yesterday'},{version:'opencode private output'}])('Rejects an untrusted result %j',change=>{
        expect(()=>readCliJob(job({result:{...observed(),...change}}),deviceId,jobId)).toThrow();
    });
    it('Does not accept a succeeded missing receipt as installed, a failed installed result, or another job target',()=>{
        expect(readCliJob(job({result:observed('missing')}),deviceId).observation?.status).toBe('missing');
        expect(()=>readCliJob(job({state:'failed'}),deviceId)).toThrow();
        expect(()=>readCliJob(job({deviceId:requestKey}),deviceId)).toThrow();
        expect(()=>readCliJob(job(),deviceId,requestKey)).toThrow();
        expect(()=>readCliJob(job({projectId:'prj-other'}),deviceId)).toThrow();
    });
    it('An old running snapshot cannot erase a terminal result or a newer receipt',()=>{
        const finished=readCliJob(job(),deviceId),running=readCliJob(job({state:'running',result:null,updatedAt:'2026-10-27T23:59:00.000Z'}),deviceId);
        expect(newerCliJob(finished,running)).toBe(finished);
        expect(newerCliJob(running,finished)).toBe(finished);
    });
});

describe('Exact own-device observation journal',()=>{
    const key=cliStorageKey(email,deviceId);
    it('Keeps the same request key and accepted job through another read; it never removes a journal',()=>{
        const storage=store(null),raw=writeCliIntent(storage,key,intent,null);
        const saved=readCliIntent(storage,key,email,deviceId);expect(saved.intent?.request).toEqual(intent.request);
        const accepted={...saved.intent!,jobId};writeCliIntent(storage,key,accepted,raw);
        expect(readCliIntent(storage,key,email,deviceId).intent).toEqual(accepted);
        expect(storage.value()).not.toBeNull();
    });
    it.each(['{"request":','null','[]',JSON.stringify({...intent,email:'other@example.test'}),JSON.stringify({...intent,request:{...intent.request,deviceId:jobId}})])('A corrupt/foreign journal stays intact: %s',raw=>{
        const storage=store(raw);expect(()=>readCliIntent(storage,key,email,deviceId)).toThrow();
        expect(storage.value()).toBe(raw);expect(storage.setItem).not.toHaveBeenCalled();
    });
    it('Does not replace an intent observed later in another tab',()=>{
        const foreign=JSON.stringify({...intent,request:{...intent.request,requestKey:jobId}}),storage=store(foreign);
        expect(()=>writeCliIntent(storage,key,intent,null)).toThrow('другой вкладке');
        expect(storage.value()).toBe(foreign);expect(storage.setItem).not.toHaveBeenCalled();
    });
    it('Storage failure does not turn an existing pending request into a new one',()=>{
        const raw=JSON.stringify(intent),storage=store(raw);storage.setItem.mockImplementation(()=>{throw Error('quota');});
        expect(()=>writeCliIntent(storage,key,{...intent,jobId},raw)).toThrow('quota');
        expect(storage.value()).toBe(raw);expect(readCliIntent(storage,key,email,deviceId).intent?.request.requestKey).toBe(requestKey);
    });
});
