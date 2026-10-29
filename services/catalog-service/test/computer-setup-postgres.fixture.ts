import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {vi} from 'vitest';
import {ForbiddenException} from '@nestjs/common';
import {AccessDb} from '../src/access/access-db';
import {DeviceJobs} from '../src/devices/device-jobs';
import {DeviceStore,type Device} from '../src/devices/device-store';
import {INSTALLATION_MIGRATIONS} from '../src/devices/installation-migrations';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {deviceCompletionFixture,ownedDeviceTestAdminUrl} from './device-completion-postgres.fixture';

/** Real AccessDb and queue/completion on an explicitly owned disposable database, never the application default. */
export async function computerSetupPostgresFixture(value:string){
    const database=await deviceCompletionFixture(value),url=ownedDeviceTestAdminUrl(value);url.pathname='/'+database.database;
    const probe=new Pool({connectionString:url.href,max:2});
    try{
        await database.pool.query(`ALTER TABLE bridge_devices ADD COLUMN email text,ADD COLUMN role text,ADD COLUMN revoked boolean DEFAULT false,
            ADD COLUMN expires_at timestamptz DEFAULT now()+interval '1 day',ADD COLUMN report jsonb DEFAULT '{}',ADD COLUMN name text DEFAULT 'Owned fixture',
            ADD COLUMN fingerprint text DEFAULT 'fixture',ADD COLUMN last_seen timestamptz,ADD COLUMN token_hash text;
            ALTER TABLE bridge_jobs ALTER COLUMN state SET DEFAULT 'queued',ALTER COLUMN lease DROP NOT NULL,ALTER COLUMN lease_until DROP NOT NULL,
            ADD COLUMN request_key text,ADD COLUMN request_hash text,ADD CONSTRAINT own_request UNIQUE(email,request_key);
            CREATE TABLE projects(id text PRIMARY KEY,name text NOT NULL);
            CREATE TABLE platform_users(email text PRIMARY KEY,enabled boolean NOT NULL DEFAULT true,is_main_admin boolean NOT NULL DEFAULT false);
            CREATE TABLE project_members(project_id text REFERENCES projects(id) ON DELETE CASCADE,principal_name text NOT NULL,role text NOT NULL,PRIMARY KEY(project_id,principal_name));
            CREATE TABLE project_assets(project_id text,asset_id text,asset_kind text)`);
        await database.pool.query(INSTALLATION_MIGRATIONS.find(item=>item.version===4)!.sql);
        const actor={email:'cli-owner@fixture.test',activeRole:'Наблюдатель'},anchor='prj-cli-authority';
        const device:Device={id:randomUUID(),email:actor.email,role:actor.activeRole,name:'Owned fixture',fingerprint:'fixture',last_seen:null,revoked:false,
            report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','opencode-cli-v1']}};
        const access={pool:probe,claims:AccessDb.prototype.claims} as unknown as AccessDb;
        const claims=vi.fn(access.claims.bind(access)),owned=DeviceStore.prototype.owned.bind({pool:database.pool} as DeviceStore);
        const service=new DeviceJobs({pool:database.pool,access:{claims},owned} as unknown as DeviceStore,{} as never,{} as never,{} as never,{} as never);
        // Other expiry owners have independent schema tests; this fixture exercises the real fixed CLI queue.
        vi.spyOn(service as unknown as {expire():Promise<void>},'expire').mockResolvedValue(undefined);
        let enabled=true;
        vi.mocked(requireFeaturesEnabled).mockImplementation(async flags=>{
            if(flags.includes('computer_setup')&&!enabled)throw new ForbiddenException({code:'feature-disabled',feature:'computer_setup',message:'Настройка программ отключена.'});
        });
        await database.pool.query('INSERT INTO bridge_devices(id,email,role,report) VALUES($1,$2,$3,$4)',[device.id,device.email,device.role,device.report]);
        const input=(requestKey=randomUUID())=>({deviceId:device.id,kind:'inspect-opencode-cli',scope:'global' as const,requestKey});
        const observation=(jobId:string,status='installed'):Record<string,unknown>=>({schemaVersion:1,scope:'global',deviceId:device.id,jobId,
            checkedAt:'2026-10-27T00:00:00.000Z',status,...(status==='installed'?{version:'1.14.48'}:{})});
        const row=async(id:string)=>(await database.observer.query('SELECT * FROM bridge_jobs WHERE id=$1',[id])).rows[0];
        const reset=async()=>{
            enabled=true;await database.pool.query('TRUNCATE bridge_job_requests,bridge_jobs,operations,project_members,projects,platform_users CASCADE');
            await database.pool.query('DELETE FROM bridge_devices WHERE id<>$1',[device.id]);
            await database.pool.query('INSERT INTO platform_users(email) VALUES($1)',[actor.email]);
            await database.pool.query('INSERT INTO projects(id,name) VALUES($1,$2)',[anchor,'Role authority']);
            await database.pool.query('INSERT INTO project_members(project_id,principal_name,role) VALUES($1,$2,$3)',[anchor,actor.email,actor.activeRole]);
            await database.pool.query("UPDATE bridge_devices SET email=$2,role=$3,revoked=false,expires_at=now()+interval '1 day',report=$4,token_hash=NULL WHERE id=$1",[device.id,device.email,device.role,device.report]);
            claims.mockReset().mockImplementation(access.claims.bind(access));
        };
        return {...database,probe,actor,anchor,device,claims,service,input,observation,row,reset,enabled:(value:boolean)=>{enabled=value;},
            dispose:async()=>{await probe.end();return database.dispose();}};
    }catch(error){await probe.end();await database.dispose();throw error;}
}
