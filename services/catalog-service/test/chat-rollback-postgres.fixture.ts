import {Pool,type PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {statfs,writeFile} from 'node:fs/promises';
import {CHAT_SCHEMA_SQL} from '../src/model-chat/chat.schema';
import {CHAT_GROUP_SCHEMA_SQL} from '../src/model-chat/chat-group.schema';

const {ownedTestPostgresAdmin}=createRequire(import.meta.url)('../../../scripts/test/owned-postgres.fixture.mjs') as {ownedTestPostgresAdmin:(value:string|undefined)=>URL};
export const connection=process.env.CHAT_ROLLBACK_TEST_ADMIN_PG_URL??process.env.TEST_ADMIN_PG_URL;
const cleanup:unknown[]=[];

/** Guard before Pool construction; each case owns only its UUID database and its sessions. */
export async function chatRollbackFixture(){
    const url=ownedTestPostgresAdmin(connection),disk=await statfs(process.cwd(),{bigint:true});
    if(disk.bavail*disk.bsize<4n*1024n**3n)throw Error('Chat rollback fixture requires 4GiB free space.');
    const name='nc_chatrollback_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url.href,max:1});
    let created=false,pool:Pool|undefined,observer:Pool|undefined;
    const close=async()=>{
        await pool?.end();await observer?.end();
        try{
            if(created)await admin.query('DROP DATABASE '+name);
            const databases=Number((await admin.query('SELECT count(*) AS n FROM pg_database WHERE datname=$1',[name])).rows[0].n);
            const sessions=Number((await admin.query('SELECT count(*) AS n FROM pg_stat_activity WHERE datname=$1',[name])).rows[0].n);
            cleanup.push({database:name,created,dropped:created&&databases===0,databasesRemaining:databases,sessionsRemaining:sessions});
            if(process.env.CHAT_ROLLBACK_CLEANUP_FILE)await writeFile(process.env.CHAT_ROLLBACK_CLEANUP_FILE,JSON.stringify(cleanup,null,2)+'\n');
        }finally{await admin.end();}
    };
    try{
        await admin.query('CREATE DATABASE '+name);created=true;url.pathname='/'+name;
        pool=new Pool({connectionString:url.href,max:1});observer=new Pool({connectionString:url.href,max:1});
        await pool.query('CREATE TABLE model_catalog(id text PRIMARY KEY); CREATE TABLE projects(id text PRIMARY KEY)');
        await pool.query(CHAT_SCHEMA_SQL);await pool.query(CHAT_GROUP_SCHEMA_SQL);
        await pool.query("INSERT INTO model_catalog(id) VALUES('owned-model')");
        return{pool,observer,name,close};
    }catch(error){await close();throw error;}
}

export type ChatOwner='create'|'owned';
export type ChatFault='begin-ack'|'commit-ack'|'none';
export type ChatRollbackFault='not-dispatched'|'ack-lost'|'normal';
/** Real SQL executes first; the wrapper faults only its driver-facing acknowledgement. */
export function chatFaultPool(pool:Pool,fault:ChatFault,rollback:ChatRollbackFault){
    const failure=new Error('Own chat '+fault+' acknowledgement lost'),rollbackFailure=new Error('Own chat rollback acknowledgement lost');
    let pid=0,releaseError:Error|boolean|undefined,injected=false,queryFailure:unknown;
    const events:Array<{sql:string;executed:boolean}>=[];
    const wrapper={connect:async()=>{
        const client=await pool.connect(),query=client.query.bind(client);pid=(await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return{
            query:async(sql:string,...args:unknown[])=>{
                if(sql==='ROLLBACK'&&rollback==='not-dispatched'){events.push({sql,executed:false});throw rollbackFailure;}
                let result:unknown;
                try{result=await (query as (...input:unknown[])=>Promise<unknown>)(sql,...args);}catch(error){queryFailure=error;throw error;}
                events.push({sql,executed:true});
                if(sql==='ROLLBACK'&&rollback==='ack-lost')throw rollbackFailure;
                if(!injected&&(fault==='begin-ack'&&sql==='BEGIN'||fault==='commit-ack'&&sql==='COMMIT')){injected=true;throw failure;}
                return result;
            },
            release:(error?:Error|boolean)=>{releaseError=error;client.release(error);},
        } as unknown as PoolClient;
    }} as unknown as Pool;
    return{pool:wrapper,failure,rollbackFailure,events,pid:()=>pid,releaseError:()=>releaseError,queryFailure:()=>queryFailure};
}
