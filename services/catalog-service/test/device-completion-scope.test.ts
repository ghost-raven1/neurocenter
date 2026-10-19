import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {completeDeviceJob} from '../src/devices/device-completion';

describe('Область результата MCP при действующей аренде',()=>{
    const query=vi.fn(),release=vi.fn();
    const pool={connect:async()=>({query,release})} as unknown as Pool;
    const row={id:'job',device_id:'computer',email:'owner@example.test',project_id:'project',kind:'sync-rag',state:'running',
        lease_until:new Date(Date.now()+60000),percent:35,payload:{bindingId:'b'.repeat(64)}};
    const input={lease:'lease',state:'succeeded' as const,message:'Готово',result:{projectId:'project',bindingId:row.payload.bindingId,
        ok:true,applied:true,complete:true,remaining:0,fingerprintVersion:1,indexProfile:{provider:'ollama',model:'fixture',dimension:3},
        snapshotHash:'c'.repeat(64),localCount:3,written:3}};
    beforeEach(()=>{
        query.mockReset();release.mockClear();
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[row]:[]}));
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));
    });
    afterEach(()=>vi.unstubAllGlobals());
    it.each(['sync-rag','restore-rag'])('%s не принимает пустой или чужой успех до истечения аренды',async kind=>{
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{...row,kind}]:[]}));
        for(const result of [{},{projectId:'another',ok:true},{projectId:'project',ok:false}]){
            await expect(completeDeviceJob(pool,'computer','job',{...input,result})).rejects.toMatchObject({status:409});
        }
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE')||sql.startsWith('INSERT'))).toBe(false);
    });
    it('Выбор корня не становится успешным с пустой папкой при действующей аренде',async()=>{
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{...row,kind:'choose-root',project_id:null}]:[]}));
        for(const result of [{},{root:''},{root:123}]){
            await expect(completeDeviceJob(pool,'computer','job',{...input,result})).rejects.toMatchObject({status:409});
        }
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE')||sql.startsWith('INSERT'))).toBe(false);
    });
    it.each(['sync-rag','restore-rag'])('%s сохраняет исходный успех и принимает потерянный ACK',async kind=>{
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{...row,kind}]:[]}));
        await expect(completeDeviceJob(pool,'computer','job',input)).resolves.toEqual({ok:true,repeated:false});
        query.mockClear();
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{...row,kind,state:'succeeded',result:input.result}]:[]}));
        await expect(completeDeviceJob(pool,'computer','job',input)).resolves.toEqual({ok:true,repeated:true});
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE')||sql.startsWith('INSERT'))).toBe(false);
    });
    it.each(['sync-rag','restore-rag'])('%s не подтверждает частичный, пустой или чужой индекс',async kind=>{
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{...row,kind,state:'reconciling'}]:[]}));
        for(const change of [{bindingId:'d'.repeat(64)},{complete:false},{remaining:1},{localCount:0,written:0},
            {indexProfile:null},{snapshotHash:''},{storePath:'/Users/private/project'}]) {
            await expect(completeDeviceJob(pool,'computer','job',{...input,result:{...input.result,...change}})).rejects.toHaveProperty('status',409);
        }
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
    });
    it('Уже принятый результат прежнего контракта получает ACK без повторного применения',async()=>{
        const result={projectId:'project',ok:true};
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{...row,state:'succeeded',payload:{},result}]:[]}));
        await expect(completeDeviceJob(pool,'computer','job',{...input,result})).resolves.toEqual({ok:true,repeated:true});
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
    });
    it.each(['running','reconciling'])('Старый непроверенный успех %s освобождает очередь с отказом и требует повторной синхронизации',async state=>{
        const legacy={projectId:'project',ok:true,remaining:500,storePath:'/Users/private/project'};
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{...row,state,payload:{}}]:[]}));
        await expect(completeDeviceJob(pool,'computer','job',{...input,result:legacy})).resolves.toEqual({ok:true,repeated:false});
        expect(query.mock.calls.find(([sql])=>sql.startsWith('UPDATE bridge_jobs'))?.[1]).toEqual([
            'job','failed',35,expect.stringContaining('Индекс не подтверждён'),{code:'rag-contract-upgrade-required',needsResync:true},
        ]);
        query.mockClear();
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{...row,state:'failed',payload:{},result:{code:'rag-contract-upgrade-required',needsResync:true}}]:[]}));
        await expect(completeDeviceJob(pool,'computer','job',{...input,result:legacy})).resolves.toEqual({ok:true,repeated:true});
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
    });
    it('Старый непроверенный результат другого проекта не получает ACK миграции',async()=>{
        query.mockImplementation(async(sql:string)=>({rows:sql.startsWith('SELECT')?[{...row,payload:{}}]:[]}));
        await expect(completeDeviceJob(pool,'computer','job',{...input,result:{projectId:'foreign',ok:true}})).rejects.toHaveProperty('status',409);
        expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
    });
});
