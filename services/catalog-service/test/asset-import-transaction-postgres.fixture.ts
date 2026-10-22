import {Pool,type PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {statfs,writeFile} from 'node:fs/promises';
import {ACCESS_SCHEMA_SQL} from '../src/access/access-schema';
import {ASSET_SOURCE_SCHEMA_SQL} from '../src/asset-sources/asset-source-schema';
import {BRIDGE_SOURCE_SCHEMA_SQL} from '../src/asset-sources/bridge-source.schema';
import {SOURCE_ARCHIVE_SCHEMA_SQL} from '../src/asset-sources/source-archive.schema';

const {ownedTestPostgresAdmin}=createRequire(import.meta.url)('../../../scripts/test/owned-postgres.fixture.mjs') as {ownedTestPostgresAdmin:(value:string|undefined)=>URL};
export const connection=process.env.ASSET_IMPORT_TX_TEST_ADMIN_PG_URL??process.env.TEST_ADMIN_PG_URL;
const cleanup:unknown[]=[];

/** The shared native guard runs before Pool construction; each case owns one UUID database. */
export async function assetImportTransactionFixture(){
    const url=ownedTestPostgresAdmin(connection),disk=await statfs(process.cwd(),{bigint:true});
    if(disk.bavail*disk.bsize<4n*1024n**3n)throw Error('Asset import fixture requires 4GiB free space.');
    const name='nc_asset_import_tx_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url.href,max:1});
    const before=(await admin.query<{datname:string}>('SELECT datname FROM pg_database ORDER BY datname')).rows.map(row=>row.datname);
    let created=false,pool:Pool|undefined,observer:Pool|undefined;
    const close=async()=>{
        await pool?.end();await observer?.end();
        try{
            if(created)await admin.query('DROP DATABASE '+name);
            const after=(await admin.query<{datname:string}>('SELECT datname FROM pg_database ORDER BY datname')).rows.map(row=>row.datname);
            cleanup.push({database:name,dropped:created&&!after.includes(name),originalDatabasesPreserved:before.every(value=>after.includes(value)),newDatabasesRemaining:after.filter(value=>!before.includes(value))});
            if(process.env.ASSET_IMPORT_TX_CLEANUP_FILE)await writeFile(process.env.ASSET_IMPORT_TX_CLEANUP_FILE,JSON.stringify(cleanup,null,2)+'\n');
        }finally{await admin.end();}
    };
    try{
        await admin.query('CREATE DATABASE '+name);created=true;url.pathname='/'+name;
        pool=new Pool({connectionString:url.href,max:1});observer=new Pool({connectionString:url.href,max:1});
        await pool.query(ACCESS_SCHEMA_SQL);await pool.query(ASSET_SOURCE_SCHEMA_SQL);await pool.query(BRIDGE_SOURCE_SCHEMA_SQL);await pool.query(SOURCE_ARCHIVE_SCHEMA_SQL);
        return{pool,observer,name,close};
    }catch(error){await close();throw error;}
}

export type ImportOwner='create'|'resolve';
export type ImportFault='write-ack'|'begin-ack'|'commit-ack'|'none';
export type RollbackFault='not-dispatched'|'ack-lost'|'normal';
/** Only the driver-facing ACK is faulted; mutations and the independent observer use real PostgreSQL. */
export function importFaultPool(pool:Pool,owner:ImportOwner,fault:ImportFault,rollback:RollbackFault){
    const failure=new Error('Own '+owner+' '+fault+' acknowledgement lost'),rollbackFailure=new Error('Own rollback acknowledgement lost');
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
                const target=fault==='write-ack'?sql.startsWith(owner==='create'?'INSERT INTO asset_source_jobs':'UPDATE asset_source_jobs SET state=')
                    :fault==='begin-ack'?sql==='BEGIN':fault==='commit-ack'&&sql==='COMMIT';
                if(target&&!injected){injected=true;throw failure;}return result;
            },
            release:(error?:Error|boolean)=>{releaseError=error;client.release(error);},
        } as unknown as PoolClient;
    }} as unknown as Pool;
    return{pool:wrapper,failure,events,pid:()=>pid,releaseError:()=>releaseError,queryFailure:()=>queryFailure};
}
