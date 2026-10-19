import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {completeDeviceJob} from '../src/devices/device-completion';

describe('Область результата MCP при действующей аренде',()=>{
    const query=vi.fn(),release=vi.fn();
    const pool={connect:async()=>({query,release})} as unknown as Pool;
    const row={id:'job',device_id:'computer',email:'owner@example.test',project_id:'project',kind:'sync-rag',state:'running',
        lease_until:new Date(Date.now()+60000),percent:35,payload:{}};
    const input={lease:'lease',state:'succeeded' as const,message:'Готово',result:{projectId:'project',ok:true}};
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
});
