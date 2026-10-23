import {randomUUID} from 'node:crypto';
import {vi} from 'vitest';
import {ForbiddenException} from '@nestjs/common';
import {DeviceJobs} from '../src/devices/device-jobs';
import {DeviceStore,type Device} from '../src/devices/device-store';
import {INSTALLATION_MIGRATIONS} from '../src/devices/installation-migrations';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {RUNTIME_CACHE_POLICY_CAPABILITY,RUNTIME_CACHE_POLICY_JOB,RUNTIME_CACHE_POLICY_LIMITS,type RuntimeCachePolicyPayload} from '../../shared/runtime-cache-policy.cjs';
import {deviceCompletionFixture} from './device-completion-postgres.fixture';

/** Real queue, owner locks, idempotency receipts and operations in a disposable non-default-port PostgreSQL database. */
export async function runtimeCachePostgresFixture(url:string){
    const database=await deviceCompletionFixture(url);
    try{
        await database.pool.query(`ALTER TABLE bridge_devices ADD COLUMN email text,ADD COLUMN role text,ADD COLUMN revoked boolean DEFAULT false,
            ADD COLUMN expires_at timestamptz DEFAULT now()+interval '1 day',ADD COLUMN report jsonb DEFAULT '{}',ADD COLUMN name text DEFAULT 'Owned fixture',
            ADD COLUMN fingerprint text DEFAULT 'fixture',ADD COLUMN last_seen timestamptz;
            ALTER TABLE bridge_jobs ALTER COLUMN state SET DEFAULT 'queued',ALTER COLUMN lease DROP NOT NULL,ALTER COLUMN lease_until DROP NOT NULL,
            ADD COLUMN request_key text,ADD COLUMN request_hash text,ADD CONSTRAINT own_request UNIQUE(email,request_key);
            CREATE TABLE projects(id text PRIMARY KEY)`);
        await database.pool.query(INSTALLATION_MIGRATIONS.find(item=>item.version===4)!.sql);
        const actor={email:'cache-owner@example.test',activeRole:'Разработчик'},device:Device={id:randomUUID(),email:actor.email,role:actor.activeRole,name:'Owned fixture',fingerprint:'fixture',last_seen:null,revoked:false,
            report:{protocolVersion:2,capabilities:['durable-completions','managed-installations',RUNTIME_CACHE_POLICY_CAPABILITY]}};
        let roles=[actor.activeRole],enabled=true;
        const claims=vi.fn(async()=>({email:actor.email,userRoles:[...roles],projects:[]}));
        const owned=DeviceStore.prototype.owned.bind({pool:database.pool} as DeviceStore);
        const service=new DeviceJobs({pool:database.pool,access:{claims},owned} as unknown as DeviceStore,{} as never,{} as never,{} as never,{} as never);
        // Other expiry workflows have their own schema suites; this slice exercises the real cache queue and completion transactions.
        vi.spyOn(service as unknown as {expire():Promise<void>},'expire').mockResolvedValue(undefined);
        vi.mocked(requireFeaturesEnabled).mockImplementation(async flags=>{if(flags.includes('computer_connections')&&!enabled)throw new ForbiddenException({code:'feature-disabled',message:'Подключения компьютеров отключены.'});});
        await database.pool.query('INSERT INTO bridge_devices(id,email,role,report) VALUES($1,$2,$3,$4)',[device.id,device.email,device.role,device.report]);
        const inspect:RuntimeCachePolicyPayload={schemaVersion:1,action:'inspect'},set:RuntimeCachePolicyPayload={schemaVersion:1,action:'set',expectedRevision:0,limitBytes:3072*1024**2};
        const input=(runtimeCachePolicy:RuntimeCachePolicyPayload=set,requestKey=randomUUID())=>({deviceId:device.id,kind:RUNTIME_CACHE_POLICY_JOB,runtimeCachePolicy,requestKey});
        const report=(payload:RuntimeCachePolicyPayload=set)=>({schemaVersion:1,revision:payload.action==='set'?payload.expectedRevision+1:0,
            limitBytes:payload.action==='set'?payload.limitBytes:RUNTIME_CACHE_POLICY_LIMITS.defaultBytes,usedBytes:1891560621,
            defaultBytes:RUNTIME_CACHE_POLICY_LIMITS.defaultBytes,minBytes:RUNTIME_CACHE_POLICY_LIMITS.minBytes,maxBytes:RUNTIME_CACHE_POLICY_LIMITS.maxBytes,observedAt:new Date().toISOString()});
        const row=async(id:string)=>(await database.observer.query('SELECT * FROM bridge_jobs WHERE id=$1',[id])).rows[0];
        const reset=async()=>{roles=[actor.activeRole];enabled=true;claims.mockClear();await database.pool.query('TRUNCATE bridge_job_requests,bridge_jobs,operations');
            await database.pool.query('UPDATE bridge_devices SET email=$2,role=$3,revoked=false,expires_at=now()+interval \'1 day\',report=$4 WHERE id=$1',[device.id,device.email,device.role,device.report]);};
        return {...database,actor,device,claims,service,inspect,set,input,report,row,reset,roles:(value:string[])=>{roles=value;},enabled:(value:boolean)=>{enabled=value;}};
    }catch(error){await database.dispose();throw error;}
}
