import 'reflect-metadata';
import {UnauthorizedException} from '@nestjs/common';
import type {Request} from 'express';
import type {Pool} from 'pg';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createPool} from '../src/database/pool';
import type {AccessDb} from '../src/access/access-db';
import {DeviceController} from '../src/devices/device.controller';
import {DeviceStore,digest} from '../src/devices/device-store';

vi.mock('../src/database/pool',()=>({createPool:vi.fn()}));
const token='a'.repeat(64),id='old-device';
const revokedMessage='Мост отключён во время выполнения. Проверьте локальные файлы перед повтором.';
type Maintenance={pause(token:unknown):Promise<{activeJobs:number}>;resume(token:unknown):Promise<{ok:boolean}>};
/** Mocked SQL proves the capability boundary and cleanup; native tests own database/race acceptance. */
function fixture(state:Record<string,unknown>={}){
    const release=vi.fn(),claims=vi.fn(async()=>({userRoles:[]}));
    const query=vi.fn(async(sql:string,_values?:unknown[])=>{
        if(sql.startsWith('SELECT id FROM bridge_devices WHERE token_hash='))return {rows:[{id,...state}],rowCount:1};
        if(sql.startsWith('SELECT count(*) FROM bridge_jobs'))return {rows:[{count:'2'}],rowCount:1};
        return {rows:[],rowCount:sql.startsWith('UPDATE')?1:0};
    });
    const direct=vi.fn(async()=>({rows:[],rowCount:0})),connect=vi.fn(async()=>({query,release}));
    vi.mocked(createPool).mockReturnValue({query:direct,connect} as unknown as Pool);
    const store=new DeviceStore({claims} as unknown as AccessDb);
    return {store,maintenance:store as unknown as Maintenance,query,direct,connect,release,claims};
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});

describe('Retained bridge token — pause/resume capability only',()=>{
    it.each([
        {reason:'revoked',revoked:true},
        {reason:'expired',expires_at:'2000-01-01T00:00:00Z'},
        {reason:'role removed',role:'Разработчик'},
    ].flatMap(state=>(['pause','resume'] as const).map(operation=>({...state,operation}))))('$operation accepts a retained $reason token under its own row lock',async({operation,...state})=>{
        const f=fixture(state),result=await f.maintenance[operation](token);
        expect(result).toEqual(operation==='pause'?{activeJobs:2}:{ok:true});
        expect(f.query.mock.calls[0]).toEqual(['BEGIN']);
        expect(f.query.mock.calls[1]).toEqual(['SELECT id FROM bridge_devices WHERE token_hash=$1 FOR UPDATE',[digest(token)]]);
        const mutations=f.query.mock.calls.filter(([sql])=>sql.startsWith('UPDATE'));
        expect(mutations).toEqual([[operation==='pause'?"UPDATE bridge_devices SET paused_until=now()+interval '1 minute' WHERE id=$1":'UPDATE bridge_devices SET paused_until=NULL WHERE id=$1',[id]]]);
        expect(f.query.mock.calls.at(-1)).toEqual(['COMMIT']);
        expect(f.release).toHaveBeenCalledExactlyOnceWith();
        expect(f.claims).not.toHaveBeenCalled();expect(f.direct).not.toHaveBeenCalled();
    });
    it.each(['pause','resume'] as const)('%s refuses an unknown or rotated token without mutation',async operation=>{
        const f=fixture(),previous=f.query.getMockImplementation()!;
        f.query.mockImplementation(async(sql,values)=>sql.startsWith('SELECT id FROM bridge_devices')?{rows:[],rowCount:0}:previous(sql,values));
        await expect(f.maintenance[operation](token)).rejects.toMatchObject({status:401});
        expect(f.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE')||sql==='COMMIT')).toBe(false);
        expect(f.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);expect(f.release).toHaveBeenCalledExactlyOnceWith();
    });
    it.each([undefined,null,'','a'.repeat(63),'g'.repeat(64),{token}].flatMap(value=>(['pause','resume'] as const).map(operation=>({value,operation}))))('$operation rejects malformed credentials before checkout: $value',async({value,operation})=>{
        const f=fixture();await expect(f.maintenance[operation](value)).rejects.toMatchObject({status:401});
        expect(f.connect).not.toHaveBeenCalled();expect(f.direct).not.toHaveBeenCalled();
    });
    it('Counts revoked uncertain failures even after role changes, including a non-null progress result',async()=>{
        const f=fixture({revoked:false});await f.maintenance.pause(token);
        const count=f.query.mock.calls.find(([sql])=>sql.startsWith('SELECT count(*) FROM bridge_jobs'))!;
        expect(count[1]).toEqual([id]);
        expect(count[0]).toContain("state IN ('running','reconciling')");
        expect(count[0]).toContain("state='failed' AND message='"+revokedMessage+"'");
        expect(count[0]).not.toMatch(/revoked|result|lease_until/);
    });
    it.each((['pause','resume'] as const).flatMap(operation=>(['normal','not-dispatched','ack-lost'] as const).map(rollback=>({operation,rollback}))))('$operation retains the exact primary failure; rollback=$rollback',async({operation,rollback})=>{
        const f=fixture(),primary=Object.assign(new Error('Mutation ACK lost'),{code:'ECONNRESET'}),secondary=new Error('ROLLBACK ACK lost'),executed:string[]=[];
        const previous=f.query.getMockImplementation()!;
        f.query.mockImplementation(async(sql,values)=>{
            if(sql==='ROLLBACK'&&rollback==='not-dispatched')throw secondary;
            const result=await previous(sql,values);executed.push(sql);
            if(sql==='ROLLBACK'&&rollback==='ack-lost')throw secondary;
            if(sql.startsWith('UPDATE bridge_devices'))throw primary;
            return result;
        });
        await expect(f.maintenance[operation](token)).rejects.toBe(primary);
        expect(f.connect).toHaveBeenCalledOnce();expect(f.query.mock.calls.filter(([sql])=>sql.startsWith('UPDATE'))).toHaveLength(1);
        expect(f.query.mock.calls.filter(([sql])=>sql==='ROLLBACK')).toHaveLength(1);
        expect(executed.filter(sql=>sql==='ROLLBACK')).toHaveLength(rollback==='not-dispatched'?0:1);
        expect(f.query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
        if(rollback==='normal')expect(f.release).toHaveBeenCalledExactlyOnceWith();else expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    });
});

describe('Only worker maintenance controller routes accept retained tokens',()=>{
    const request=(internal='own-gateway')=>({headers:{'x-neurocenter-internal':internal,authorization:'Bearer '+token},body:{deviceId:'other-device'}} as unknown as Request);
    const controller=(store:DeviceStore)=>new DeviceController(store,{} as never,{} as never,{} as never,{} as never);
    it.each(['pause','resume'] as const)('%s bypasses only ordinary device identity, keeps internal gateway identity',async operation=>{
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','own-gateway');const f=fixture();
        const identity=vi.spyOn(f.store,'identity').mockRejectedValue(new UnauthorizedException('Revoked identity'));
        await expect(controller(f.store)[operation](request())).resolves.toEqual(operation==='pause'?{activeJobs:2}:{ok:true});
        expect(identity).not.toHaveBeenCalled();expect(f.query.mock.calls[1]?.[1]).toEqual([digest(token)]);
    });
    it.each(['pause','resume'] as const)('%s refuses a caller outside the gateway before checking the retained key',async operation=>{
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','own-gateway');const f=fixture();
        await expect(controller(f.store)[operation](request('wrong-gateway'))).rejects.toMatchObject({status:403});
        expect(f.connect).not.toHaveBeenCalled();expect(f.direct).not.toHaveBeenCalled();
    });
    it('Identity, heartbeat, degraded presence and claim retain the ordinary revoked-device denial',async()=>{
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','own-gateway');const f=fixture(),api=controller(f.store);
        const denied=new UnauthorizedException('Revoked identity'),identity=vi.spyOn(f.store,'identity').mockRejectedValue(denied);
        await expect(api.identity(request())).rejects.toBe(denied);
        await expect(api.heartbeat(request(),{})).rejects.toBe(denied);
        await expect(api.presence(request(),{} as never)).rejects.toBe(denied);
        await expect(api.claim(request())).rejects.toBe(denied);
        expect(identity).toHaveBeenCalledTimes(4);expect(f.connect).not.toHaveBeenCalled();
    });
});
