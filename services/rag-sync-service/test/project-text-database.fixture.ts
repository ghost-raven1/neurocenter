import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {RagDb} from '../src/rag/rag-db';
import {ProjectTextStore} from '../src/project-text/text-store';
import {ownedQuotaRollbackUrl} from './platform-quota-rollback.fixture';
import {indexSnapshotHash,rowFingerprint} from '../../shared/rag-index-contract.cjs';

/** A dedicated loopback cluster, real pgvector schema, and one disposable database per scenario. */
export async function textDatabaseFixture(connection:string){
    const url=ownedQuotaRollbackUrl(connection),name='nc_text_'+randomUUID().replaceAll('-','');
    const admin=new Pool({connectionString:url.href,max:1});let created=false,db:RagDb|undefined,pool:Pool|undefined;
    const dispose=async()=>{
        try{
            await db?.close();await pool?.end();if(created)await admin.query('DROP DATABASE '+name);
            const databases=(await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[name])).rows;
            const sessions=(await admin.query('SELECT pid FROM pg_stat_activity WHERE datname=$1',[name])).rows;
            if(databases.length||sessions.length)throw Error('Owned text fixture resources remain.');
            return {database:name,dropped:created,databasesRemaining:databases,sessionsRemaining:sessions};
        }finally{await admin.end();}
    };
    try{
        await admin.query('CREATE DATABASE '+name);created=true;url.pathname='/'+name;
        db=new RagDb({url:url.href});await db.setup();pool=new Pool({connectionString:url.href,max:4});
        const project='prj-'+randomUUID(),text=new ProjectTextStore(pool);
        return {db,pool,project,text,dispose};
    }catch(error){await dispose();throw error;}
}

export async function semanticSeed(f:Awaited<ReturnType<typeof textDatabaseFixture>>){
    const generation='initial-'+createHash('md5').update(f.project).digest('hex');
    const profile={provider:'openai',model:'neurocenter/model-embed/sha256/'+'a'.repeat(64),dimension:3};
    const row={id:'retained',filePath:'semantic.ts',content:'original semantic bytes',description:'Original',startLine:1,endLine:1,
        language:'typescript',kind:'code',role:null,quirkType:null,tags:null,contentHash:createHash('sha256').update('original semantic bytes').digest('hex'),embedding:[1,0,0]};
    const snapshot=indexSnapshotHash(profile,{retained:rowFingerprint(row)});
    await f.db.applyDelta(f.project,generation,[row],[],{indexProfile:profile,snapshot:{hash:snapshot,rowCount:1,complete:false}});
    await f.db.applyDelta(f.project,generation,[],[],{indexProfile:profile,snapshot:{hash:snapshot,rowCount:1,complete:true}});
    return {generation,profile,snapshot};
}

export async function textDatabaseState(f:Awaited<ReturnType<typeof textDatabaseFixture>>){
    const tables=['project_text_state','project_text_documents','project_text_receipts','rag_storage_budget','rag_quota_events',
        'rag_chunks','rag_generations','rag_index_state','rag_write_receipts'];
    const result:Record<string,unknown>={};
    for(const table of tables)result[table]=(await f.pool.query('SELECT to_jsonb(t) AS row FROM '+table+' t ORDER BY to_jsonb(t)::text')).rows;
    return result;
}

/** Execute COMMIT in PostgreSQL and lose only its returned ACK; rollback ownership is tested separately. */
export function lostTextAck(pool:Pool){
    const failure=Error('Owned text COMMIT ACK lost');let fired=false;
    return {failure,pool:{connect:async()=>{
        const client=await pool.connect(),query=client.query.bind(client);
        return {query:async(sql:string,...args:unknown[])=>{
            const result=await (query as (...values:unknown[])=>Promise<unknown>)(sql,...args);
            if(sql==='COMMIT'&&!fired){fired=true;throw failure;}return result;
        },release:client.release.bind(client)};
    }}as unknown as Pool};
}

/** Gate the snapshot after its first read while another connection commits a new revision. */
export function pausedTextSearch(pool:Pool){
    let entered!:()=>void,resume!:()=>void;
    const paused=new Promise<void>(resolve=>{entered=resolve;}),released=new Promise<void>(resolve=>{resume=resolve;});
    return {paused,resume,pool:{connect:async()=>{
        const client=await pool.connect(),query=client.query.bind(client);
        return {query:async(sql:string,...args:unknown[])=>{
            const result=await (query as (...values:unknown[])=>Promise<unknown>)(sql,...args);
            if(sql.startsWith('SELECT * FROM project_text_state')){entered();await released;}return result;
        },release:client.release.bind(client)};
    }}as unknown as Pool};
}
