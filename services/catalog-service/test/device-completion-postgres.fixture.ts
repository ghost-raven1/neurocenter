import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {statfs} from 'node:fs/promises';
import {operationSchema} from './operation-schema.fixture';

/** Completion fixtures require a caller-owned administrative database before opening any socket. */
export function ownedDeviceTestAdminUrl(value:string):URL{
    let url:URL;try{url=new URL(value);}catch{throw new Error('Provide an explicitly owned PostgreSQL test admin URL.');}
    if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||!url.port||url.port==='5432'||url.pathname!=='/postgres'||url.search||url.hash)
        throw new Error('Provide an explicitly owned loopback PostgreSQL admin URL on a non-default port.');
    return url;
}

export async function deviceCompletionFixture(value:string){
    const url=ownedDeviceTestAdminUrl(value),disk=await statfs(process.cwd(),{bigint:true});
    if(disk.bavail*disk.bsize<4n*1024n**3n)throw new Error('Device fixture requires 4 GiB free disk space.');
    const database='nc_device_completion_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url.href,max:1});
    const before=(await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(row=>row.datname);
    let pool:Pool|undefined,observer:Pool|undefined,created=false;
    const dispose=async()=>{
        await observer?.end();await pool?.end();
        if(created)await admin.query('DROP DATABASE '+database);
        const after=(await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(row=>row.datname);
        await admin.end();
        return{database,created,dropped:created&&!after.includes(database),originalDatabasesPreserved:before.every(name=>after.includes(name)),newDatabasesRemaining:after.filter(name=>!before.includes(name))};
    };
    try{
        await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
        pool=new Pool({connectionString:url.href,max:1});observer=new Pool({connectionString:url.href,max:1});
        await pool.query('CREATE TABLE bridge_devices(id text PRIMARY KEY,paused_until timestamptz)');
        await pool.query(`CREATE TABLE bridge_jobs(id text PRIMARY KEY,device_id text NOT NULL,email text NOT NULL,role text NOT NULL,
            project_id text,kind text NOT NULL,state text NOT NULL,percent integer,payload jsonb NOT NULL,result jsonb,
            lease text NOT NULL,lease_until timestamptz NOT NULL,message text,started_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())`);
        await operationSchema(pool);
        return{pool,observer,database,dispose};
    }catch(error){await dispose();throw error;}
}

export type CompletionFault='journal-ack'|'begin-ack'|'commit-before'|'commit-ack';
/** Execute real SQL around one lost acknowledgement; a failed rollback deliberately never reaches PostgreSQL. */
export function completionFaultPool(pool:Pool,fault:CompletionFault,rollbackFails:boolean){
    let pid=0,releaseError:Error|boolean|undefined;
    const failure=new Error('Own '+fault+' failure'),rollbackFailure=new Error('Own rollback not acknowledged');
    const wrapper={connect:async()=>{
        const client=await pool.connect(),query=client.query.bind(client);let injected=false;
        pid=(await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return{
            query:async(sql:string,...args:unknown[])=>{
                if(sql==='ROLLBACK'&&rollbackFails)throw rollbackFailure;
                const target=!injected&&(fault==='journal-ack'?sql.includes('INSERT INTO operations'):fault==='begin-ack'?sql==='BEGIN':sql==='COMMIT');
                if(target&&fault==='commit-before'){injected=true;throw failure;}
                const result=await (query as (...input:unknown[])=>Promise<unknown>)(sql,...args);
                if(target){injected=true;throw failure;}return result;
            },
            release:(error?:Error|boolean)=>{releaseError=error;client.release(error);},
        };
    }} as unknown as Pool;
    return{pool:wrapper,failure,rollbackFailure,pid:()=>pid,releaseError:()=>releaseError};
}
