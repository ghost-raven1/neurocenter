import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {RagDb,type IUpsertRow} from '../src/rag/rag-db';
import {rowFingerprint,indexSnapshotHash} from '../../shared/rag-index-contract.cjs';
import {generation} from './rag-write.fixture';
vi.mock('../../shared/capacity.cjs',()=>({reserveCapacity:async()=>()=>{}}));
const connection=process.env.RAG_CONTRACT_TEST_PG_URL;
const profile={provider:'openai',model:'neurocenter/owner-fixture/sha256/'+'a'.repeat(64),dimension:3};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};

/** Actual server session loss must fence a late embedding result, without failing another project's query. */
describe.skipIf(!connection).sequential('RAG generation owner socket loss',()=>{
    let admin:Pool,observer:Pool,db:RagDb,pool:Pool,created=false;
    const name='nc_rag_owner_'+randomUUID().replaceAll('-','');
    beforeAll(async()=>{
        const url=new URL(connection!);
        if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||!url.port||url.port==='5432')throw Error('Use explicitly owned loopback PostgreSQL other than5432.');
        url.pathname='/postgres';admin=new Pool({connectionString:url.href,max:1});
        await admin.query('CREATE DATABASE '+name);created=true;url.pathname='/'+name;
        observer=new Pool({connectionString:url.href,max:1});db=new RagDb({url:url.href});
        pool=(db as unknown as {pool:Pool}).pool;
        // Socket crash behavior has its separate unguarded child-process control; this test isolates ownership.
        pool.on('connect',client=>client.on('error',()=>undefined));
        await db.setup();
    },30000);
    afterAll(async()=>{await db?.close();await observer?.end();if(created)await admin.query('DROP DATABASE '+name);await admin?.end();});
    async function candidate(){
        const key='owner-'+randomUUID(),id=randomUUID(),content='source text';
        const row:IUpsertRow={id:'one',filePath:'one.ts',content,description:null,startLine:1,endLine:1,language:'typescript',kind:'code',role:null,quirkType:null,tags:null,contentHash:createHash('sha256').update(content).digest('hex'),embedding:[1,0,0]};
        const snapshot={hash:indexSnapshotHash(profile,{one:rowFingerprint(row)}),rowCount:1,complete:true};
        await db.applyDelta(key,generation(key),[row],[],{indexProfile:profile,snapshot:{...snapshot,complete:false}});
        await db.applyDelta(key,generation(key),[],[],{indexProfile:profile,snapshot});
        const source=await db.generations.source(key,generation(key));
        await db.generations.create(key,id,generation(key),profile,source.hash);return{key,id};
    }
    it.each(['late-answer','late-error'])('%s cannot publish or fail a replacement owner generation',async mode=>{
        const f=await candidate(),started=deferred(),release=deferred(),lost=deferred(),nextStarted=deferred(),nextRelease=deferred();let pid=0;
        const connect=pool.connect.bind(pool);
        const spy=vi.spyOn(pool,'connect').mockImplementationOnce(async()=>{
            const client=await connect();pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            client.once('error',()=>lost.resolve());return client as PoolClient;
        });
        const original=new Error('late embedding failure');
        const first=db.generations.build(f.key,f.id,async()=>{started.resolve();await release.promise;if(mode==='late-error')throw original;return [[0,1,0]];});
        const observed=first.then(value=>({value,error:undefined}),error=>({value:undefined,error}));
        let replacement:ReturnType<RagDb['generations']['build']>|undefined;
        try{
            await started.promise;
            expect((await observer.query('SELECT pg_terminate_backend($1) AS stopped',[pid])).rows[0].stopped).toBe(true);
            await lost.promise;
            expect((await observer.query('SELECT 1 AS unrelated')).rows[0].unrelated).toBe(1);
            replacement=db.generations.build(f.key,f.id,async()=>{nextStarted.resolve();await nextRelease.promise;return [[1,1,0]];});
            await nextStarted.promise;
            release.resolve();const old=await observed;
            expect(old.error,'a dead owner must reject its late result').toBeDefined();
            if(mode==='late-error')expect(old.error).toBe(original);
            expect((await db.generations.get(f.key,f.id)).state,'old owner must not change replacement state').toBe('building');
            nextRelease.resolve();const next=await replacement;
            expect(next.state).toBe('ready');
            expect(await db.generations.get(f.key,f.id)).toEqual(next);
            expect((await db.rowsPage(f.key,f.id,10,0))[0].embedding).toEqual([1,1,0]);
        }finally{release.resolve();nextRelease.resolve();await observed;await replacement;spy.mockRestore();}
    },15000);
});
