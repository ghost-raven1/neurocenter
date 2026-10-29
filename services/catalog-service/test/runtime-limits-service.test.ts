import 'reflect-metadata';
import {ForbiddenException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {Request} from 'express';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {RuntimeLimitsService} from '../src/runtime-limits/runtime-limits.service';
import {DEFAULT_RUNTIME_LIMIT_POLICY,type RuntimeLimitInput} from '../../shared/runtime-limits.cjs';
import {requireFeatureEnabled} from '../src/features/require-feature-enabled';

vi.mock('../src/features/require-feature-enabled',()=>({requireFeatureEnabled:vi.fn()}));
type State={setting?:{revision:number;policy:unknown;updated_at:Date};receipts:Map<string,{request_hash:string;result:unknown}>;audits:number};
function fixture(){
    const req={headers:{}}as Request,calls:string[]=[],now=new Date('2026-10-29T00:00:00Z');
    let state:State={receipts:new Map(),audits:0},transaction:State|undefined,enabled=true,main=true,writer='owner@example.test',loseAck=false,failedRead=false;
    const clone=(value:State)=>({setting:value.setting?structuredClone(value.setting):undefined,receipts:new Map(value.receipts),audits:value.audits});
    const execute=async(sql:string,values:unknown[]=[],owned=false):Promise<{rows:any[];rowCount:number}>=>{
        calls.push(sql);let rows:any[]=[];
        if(sql==='BEGIN')transaction=clone(state);
        else if(sql==='COMMIT'){state=transaction!;transaction=undefined;if(loseAck){loseAck=false;throw Error('ACK lost after commit');}}
        else if(sql==='ROLLBACK')transaction=undefined;
        else if(sql.startsWith('SELECT enabled'))rows=[{enabled,is_main_admin:main}];
        else if(sql.startsWith('SELECT revision,policy')){if(failedRead)throw Error('read unavailable');const row=(owned?transaction:state)?.setting;rows=row?[row]:[];}
        else if(sql.startsWith('SELECT request_hash,result')){const row=transaction?.receipts.get(values[0]+':'+values[1]);rows=row?[row]:[];}
        else if(sql.startsWith('SELECT result FROM runtime_limit_requests')){const row=state.receipts.get(values[0]+':'+values[1]);rows=row?[{result:row.result}]:[];}
        else if(sql.startsWith('INSERT INTO runtime_limit_settings')){const revision=(transaction?.setting?.revision??0)+1;transaction!.setting={revision,policy:JSON.parse(values[0]as string),updated_at:now};rows=[{revision,updated_at:now}];}
        else if(sql.startsWith('INSERT INTO runtime_limit_requests'))transaction!.receipts.set(values[0]+':'+values[1],{request_hash:values[2]as string,result:JSON.parse(values[3]as string)});
        else if(sql.startsWith('INSERT INTO security_events'))transaction!.audits++;
        else if(!sql.startsWith('SET LOCAL')&&!sql.startsWith('SELECT pg_advisory'))throw Error('Unexpected fixture SQL');
        return {rows,rowCount:rows.length};
    };
    const release=vi.fn(),pool={query:(sql:string,values?:unknown[])=>execute(sql,values),connect:vi.fn(async()=>({query:(sql:string,values?:unknown[])=>execute(sql,values,true),release}))};
    const models={pool,actor:vi.fn(async()=>({email:writer,activeRole:'Главный админ'})),requireMain:vi.fn(async()=>{if(!main)throw new ForbiddenException('Denied');return writer;})};
    const service=new RuntimeLimitsService(models as never),input:RuntimeLimitInput={expectedRevision:0,requestKey:randomUUID(),policy:structuredClone(DEFAULT_RUNTIME_LIMIT_POLICY)};
    return {req,service,models,calls,release,input,get state(){return state;},denyFresh:()=>{enabled=false;},denyRole:()=>{main=false;},writer:(value:string)=>{writer=value;},lostAck:()=>{loseAck=true;},unavailable:()=>{failedRead=true;}};
}
beforeEach(()=>{vi.mocked(requireFeatureEnabled).mockReset().mockResolvedValue();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});

describe('Runtime limits have observable effect and exact atomic configuration',()=>{
    it('returns a sanitized default policy and refuses a failed source instead of silently using new defaults',async()=>{
        const f=fixture(),view=await f.service.read(f.req);expect(view).toMatchObject({revision:0,policy:DEFAULT_RUNTIME_LIMIT_POLICY,updatedAt:null});
        expect(JSON.stringify(view)).not.toMatch(/token|password|CATALOG/);
        f.unavailable();await expect(f.service.effective()).rejects.toHaveProperty('status',503);
    });
    it('admits only browser MainAdmin configuration and validates before acquiring SQL',async()=>{
        const f=fixture();await expect(f.service.save({...f.req,headers:{authorization:'device-token'}}as Request,f.input)).rejects.toHaveProperty('status',403);
        await expect(f.service.save(f.req,{...f.input,policy:{...f.input.policy,hidden:'value'}})).rejects.toHaveProperty('status',400);
        expect(f.models.pool.connect).not.toHaveBeenCalled();
    });
    it('locks a fresh enabled MainAdmin before the first mutation and rolls back revoked access',async()=>{
        const f=fixture();f.denyFresh();await expect(f.service.save(f.req,f.input)).rejects.toHaveProperty('status',403);
        expect(f.calls.some(sql=>sql.startsWith('INSERT'))).toBe(false);expect(f.calls.at(-1)).toBe('ROLLBACK');expect(f.state.audits).toBe(0);
    });
    it('writes policy, audit and receipt atomically; the next GGUF provider read sees it and prior snapshot stays unchanged',async()=>{
        const f=fixture(),before=await f.service.ggufPolicy();f.input.policy.ggufImport.activeUploads=2;f.input.policy.textKnowledge.sources=3;
        const saved=await f.service.save(f.req,f.input);expect(saved).toMatchObject({revision:1,policy:f.input.policy,requestKey:f.input.requestKey});
        expect(await f.service.ggufPolicy()).toMatchObject({activeUploads:2});expect(before.activeUploads).toBe(3);
        expect(f.state.audits).toBe(1);expect(f.state.receipts.size).toBe(1);expect(f.calls.at(-1)).toContain('SELECT revision,policy');
    });
    it('refuses a stale CAS without overwriting another accepted revision or its receipt',async()=>{
        const f=fixture();await f.service.save(f.req,f.input);const before=structuredClone(f.state.setting);
        await expect(f.service.save(f.req,{...f.input,requestKey:randomUUID()})).rejects.toHaveProperty('status',409);
        expect(f.state.setting).toEqual(before);expect(f.state.audits).toBe(1);expect(f.state.receipts.size).toBe(1);
    });
    it('recovers an ACK-lost committed configuration while editor is OFF without a second write',async()=>{
        const f=fixture();f.lostAck();await expect(f.service.save(f.req,f.input)).rejects.toMatchObject({status:503});
        vi.mocked(requireFeatureEnabled).mockRejectedValue(new ForbiddenException('OFF'));
        const accepted=await f.service.save(f.req,f.input);expect(accepted).toEqual(await f.service.receipt(f.req,f.input.requestKey));
        expect(f.state.audits).toBe(1);expect(f.state.receipts.size).toBe(1);
        expect(f.calls.filter(sql=>sql.startsWith('INSERT INTO runtime_limit_settings'))).toHaveLength(1);
    });
    it('same writer/key with a different policy conflicts before editor admission',async()=>{
        const f=fixture();await f.service.save(f.req,f.input);vi.mocked(requireFeatureEnabled).mockClear();
        await expect(f.service.save(f.req,{...f.input,policy:{...f.input.policy,textKnowledge:{...f.input.policy.textKnowledge,sources:1}}})).rejects.toHaveProperty('status',409);
        expect(requireFeatureEnabled).not.toHaveBeenCalled();expect(f.state.audits).toBe(1);
    });
    it('OFF blocks a new configuration; effective current policy and own receipts remain readable',async()=>{
        const f=fixture(),saved=await f.service.save(f.req,f.input);vi.mocked(requireFeatureEnabled).mockRejectedValue(new ForbiddenException('OFF'));
        await expect(f.service.save(f.req,{...f.input,expectedRevision:1,requestKey:randomUUID()})).rejects.toHaveProperty('status',403);
        expect((await f.service.effective()).revision).toBe(1);expect(await f.service.receipt(f.req,f.input.requestKey)).toEqual(saved);
        f.writer('other@example.test');await expect(f.service.receipt(f.req,f.input.requestKey)).rejects.toHaveProperty('status',404);
    });
});
