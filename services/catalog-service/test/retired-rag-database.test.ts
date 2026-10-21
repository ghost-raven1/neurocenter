import 'reflect-metadata';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {Client,Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {NestFactory} from '@nestjs/core';
import {RetiredRagService} from '../src/retired-rag/retired-rag.service';
import {RetiredRagController} from '../src/retired-rag/retired-rag.controller';
import {setupProjectRetirements} from '../src/retired-rag/retirement-schema';
import {deleteProjectWithAudit} from '../src/catalog/project-deletion';
import {CatalogService} from '../src/catalog/catalog.service';
import {AccessDb} from '../src/access/access-db';
import {DeviceStore} from '../src/devices/device-store';
import {setupSecurityEvents} from '../src/access/security-events';
import {DatabaseLifecycle} from '../../rag-sync-service/src/retired-databases/database-lifecycle';
import {DatabaseLifecycleController} from '../../rag-sync-service/src/retired-databases/lifecycle.controller';
import {projectDatabaseName} from '../../rag-sync-service/src/rag/project-database-name';
import {databaseLock,LIFECYCLE_LOCK} from '../../rag-sync-service/src/retired-databases/lifecycle-schema';
import {ragRequestHash} from '../../shared/rag-index-contract.cjs';
import {operationSchema} from './operation-schema.fixture';

const connection=process.env.RAG_CONTRACT_TEST_PG_URL;
describe.skipIf(!connection)('Retained RAG DB lifecycle: actual HTTP + disposable PostgreSQL databases',()=>{
    const control='nc_lifecycle_test_'+randomUUID().replaceAll('-',''),catalog='nc_retire_test_'+randomUUID().replaceAll('-','');
    let admin:Client,pool:Pool,ragPool:Pool,lifecycle:DatabaseLifecycle,service:RetiredRagService,apps:any[]=[],base:string;
    let allowed=true,loseResponse=false;const owned=new Set<string>();
    const auth={'x-neurocenter-internal':'retirement-test','x-bridge-actor':encodeURIComponent(JSON.stringify({email:'own-admin@example.test',activeRole:'Главный админ'}))};
    async function http(route:string,body?:unknown,headers:Record<string,string>=auth,method?:string){const result=await fetch(base+route,{method:method??(body===undefined?'GET':'POST'),headers:{...headers,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:result.status,data:await result.json() as any};}
    const prefix='/api/maintenance/retired-rag-databases';
    async function seed(withDb=true){const projectId='prj-'+randomUUID(),name='Disposable retirement '+randomUUID();await pool.query('INSERT INTO projects(id,name) VALUES($1,$2)',[projectId,name]);
        if(withDb){const database=projectDatabaseName(projectId);await admin.query(`CREATE DATABASE "${database}"`);owned.add(database);await ragPool.query('INSERT INTO neurocenter_project_databases(project_id,database_name,migrated) VALUES($1,$2,true)',[projectId,database]);
            const url=new URL(connection!);url.pathname='/'+database;const target=new Client({connectionString:url.toString()});await target.connect();try{await target.query('CREATE TABLE rag_chunks(id TEXT);INSERT INTO rag_chunks VALUES(\'one\'),(\'two\');CREATE TABLE rag_generations(id TEXT);INSERT INTO rag_generations VALUES(\'g1\')');}finally{await target.end();}}
        await deleteProjectWithAudit(pool,projectId,'own-admin@example.test');const row=(await pool.query('SELECT * FROM project_retirements WHERE project_id=$1',[projectId])).rows[0];return {...row,database:projectDatabaseName(projectId)};}
    async function preview(row:any){const result=await http(`${prefix}/${row.id}/preview`,{});expect(result.status,JSON.stringify(result.data)).toBe(201);return result.data;}
    async function waitJob(id:string){for(let i=0;i<450;i++){const result=await http('/api/maintenance/retired-rag-purges/'+id);if(['failed','succeeded'].includes(result.data.state))return result.data;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Purge did not terminate');}
    async function purge(row:any,plan:any){const result=await http(`${prefix}/${row.id}/purge`,{requestKey:randomUUID(),previewId:plan.id,digest:plan.digest});expect(result.status,JSON.stringify(result.data)).toBe(201);return waitJob(result.data.id);}
    const present=async(name:string)=>!!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rows.length;
    beforeAll(async()=>{
        const url=new URL(connection!);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Only disposable local databases allowed');
        admin=new Client({connectionString:connection});await admin.connect();for(const name of [control,catalog]){await admin.query(`CREATE DATABASE "${name}"`);owned.add(name);}
        url.pathname='/'+catalog;vi.stubEnv('CATALOG_PG_URL',url.toString());pool=new Pool({connectionString:url.toString(),max:8});
        await pool.query(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT UNIQUE);CREATE TABLE bridge_jobs(id TEXT PRIMARY KEY,project_id TEXT,state TEXT);
            CREATE TABLE bridge_hosted_rag_grants(id TEXT PRIMARY KEY,project_id TEXT,revoked_at TIMESTAMPTZ);
            CREATE TABLE project_reindex_plans(id TEXT PRIMARY KEY,project_id TEXT,state TEXT);CREATE TABLE project_rag_sync_intents(id TEXT PRIMARY KEY,project_id TEXT,state TEXT);
            CREATE TABLE project_snapshots(id TEXT PRIMARY KEY,project_id TEXT,status TEXT);`);
        await operationSchema(pool);await setupSecurityEvents(pool);await setupProjectRetirements(pool);
        url.pathname='/'+control;vi.stubEnv('RAG_PG_URL',url.toString());ragPool=new Pool({connectionString:url.toString(),max:4});vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','retirement-test');
        lifecycle=new DatabaseLifecycle();await lifecycle.setup();
        const access={claims:async()=>({email:'own-admin@example.test',userRoles:allowed?['Главный админ']:[]})};
        service=new RetiredRagService({ensureSchema:async()=>{}} as unknown as CatalogService,access as unknown as AccessDb,{ready:async()=>{}} as unknown as DeviceStore);
        Reflect.defineMetadata('design:paramtypes',[RetiredRagService,AccessDb],RetiredRagController);Reflect.defineMetadata('design:paramtypes',[DatabaseLifecycle],DatabaseLifecycleController);
        class CatalogFixture{}class RagFixture{}
        const catalogApp=await NestFactory.create({module:CatalogFixture,controllers:[RetiredRagController],providers:[{provide:RetiredRagService,useValue:service},{provide:AccessDb,useValue:access}]},{logger:false});
        const {NestFactory:RagNest}=await import('../../rag-sync-service/node_modules/@nestjs/core/index.js');
        const ragApp=await RagNest.create({module:RagFixture,controllers:[DatabaseLifecycleController],providers:[{provide:DatabaseLifecycle,useValue:lifecycle}]},{logger:false});
        ragApp.use((req:any,res:any,next:any)=>{if(req.headers['x-neurocenter-internal']!=='retirement-test'){res.status(403).json({message:'internal'});return;}if(loseResponse&&req.path==='/internal/retired-rag/purge'){loseResponse=false;res.json=()=>{res.destroy();return res;};}next();});
        await catalogApp.listen(0,'127.0.0.1');await ragApp.listen(0,'127.0.0.1');apps=[catalogApp,ragApp];base=await catalogApp.getUrl();vi.stubEnv('CATALOG_SERVICE_URL',base);vi.stubEnv('RAG_SERVICE_URL',await ragApp.getUrl());clearInterval((service as any).timer);
    },30000);
    afterAll(async()=>{await Promise.all(apps.map(app=>app.close()));await pool?.end();await ragPool?.end();for(const name of owned)if(await present(name))await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin?.end();vi.unstubAllEnvs();},30000);
    it('Atomic deletion records a durable retirement, rejects ABA, and preserves separate snapshot records',async()=>{
        const row=await seed();expect(await present(row.database)).toBe(true);expect(row).toMatchObject({origin:'deletion',retention_revision:0,retain_until:null});
        await expect(pool.query('INSERT INTO projects(id,name) VALUES($1,$2)',[row.project_id,'ABA'])).rejects.toMatchObject({code:'23514'});
        await pool.query("INSERT INTO project_snapshots VALUES('kept',$1,'VERIFIED')",[row.project_id]);const plan=await preview(row);expect(plan.facts).toMatchObject({bytes:expect.any(Number),chunks:2,generations:1,preserves:['backups','lance-snapshots','local-files']});expect(plan.digest).toBe(ragRequestHash(plan.facts));
        const job=await purge(row,plan);expect(job.state,JSON.stringify(job)).toBe('succeeded');expect(await present(row.database)).toBe(false);expect((await pool.query("SELECT 1 FROM project_snapshots WHERE id='kept'")).rows).toHaveLength(1);
        const registry=(await ragPool.query('SELECT * FROM neurocenter_project_databases WHERE project_id=$1',[row.project_id])).rows[0];expect(registry.lifecycle_state).toBe('purged');expect(registry.purged_at).not.toBeNull();
    });
    it('Mainadmin and internal-token checks happen before inventory or native writes',async()=>{
        expect((await http(prefix,undefined,{})).status).toBe(403);expect((await http(prefix,undefined,{...auth,'x-bridge-actor':encodeURIComponent(JSON.stringify({email:'own-admin@example.test',activeRole:'Админ проекта'}))})).status).toBe(403);
        allowed=false;expect((await http(prefix)).status).toBe(403);allowed=true;
    });
    it('An accidental internal preview cannot retire a live project or a foreign tombstone identity',async()=>{
        const id='prj-'+randomUUID();await pool.query('INSERT INTO projects VALUES($1,$1)',[id]);await ragPool.query('INSERT INTO neurocenter_project_databases(project_id,database_name) VALUES($1,$2)',[id,projectDatabaseName(id)]);
        await expect(lifecycle.preview(id,randomUUID())).rejects.toMatchObject({status:409});expect((await ragPool.query('SELECT lifecycle_state FROM neurocenter_project_databases WHERE project_id=$1',[id])).rows[0].lifecycle_state).toBe('active');
    });
    it('Zero database is truthful: retirement exists but preview cannot invent a physical database',async()=>{const row=await seed(false);expect((await http(`${prefix}/${row.id}/preview`,{})).status).toBe(404);});
    it('Active read/index session lease blocks preview, and a later retired lease cannot start',async()=>{
        const row=await seed(),release=await lifecycle.lease(row.project_id);expect((await http(`${prefix}/${row.id}/preview`,{})).status).toBe(409);await release();await preview(row);await expect(lifecycle.lease(row.project_id)).rejects.toMatchObject({status:409});
    });
    it('Full backup fence blocks preview/purge until the exact PG session releases it',async()=>{
        const row=await seed(),lock=await ragPool.connect();try{await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[LIFECYCLE_LOCK]);expect((await http(`${prefix}/${row.id}/preview`,{})).status).toBe(409);}finally{await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[LIFECYCLE_LOCK]);lock.release();}expect((await preview(row)).facts.identity.projectId).toBe(row.project_id);
    });
    it.each([['bridge_jobs','state','running'],['bridge_jobs','state','reconciling'],['project_reindex_plans','state','building'],['project_rag_sync_intents','state','uncertain'],['project_snapshots','status','VERIFYING']])('Deletion cannot cascade away %s %s=%s',async(table,column,state)=>{
        const id='prj-'+randomUUID();await pool.query('INSERT INTO projects VALUES($1,$1)',[id]);await pool.query(`INSERT INTO ${table}(id,project_id,${column}) VALUES($1,$2,$3)`,[randomUUID(),id,state]);await expect(deleteProjectWithAudit(pool,id,'own-admin@example.test')).rejects.toMatchObject({status:409});expect((await pool.query('SELECT 1 FROM projects WHERE id=$1',[id])).rows).toHaveLength(1);expect((await pool.query('SELECT 1 FROM project_retirements WHERE project_id=$1',[id])).rows).toHaveLength(0);
    });
    it('Retain-until survives restart, rejects stale policy revision and prevents purge',async()=>{
        const row=await seed(),plan=await preview(row);const retained=await http(`${prefix}/${row.id}/retention`,{expectedRevision:0,retainUntil:new Date(Date.now()+86400000).toISOString(),reason:'Disposable retention check'},auth,'PATCH');expect(retained.status).toBe(200);
        expect((await http(`${prefix}/${row.id}/retention`,{expectedRevision:0,retainUntil:null,reason:''},auth,'PATCH')).status).toBe(409);expect((await http(`${prefix}/${row.id}/preview`,{})).status).toBe(409);
        expect((await http(`${prefix}/${row.id}/purge`,{requestKey:randomUUID(),previewId:plan.id,digest:plan.digest})).status).toBe(409);expect(await present(row.database)).toBe(true);
    });
    it('Same request returns one job; mutation under the same key is rejected; succeeded replay never drops a recreated DB',async()=>{
        const row=await seed(),plan=await preview(row),body={requestKey:randomUUID(),previewId:plan.id,digest:plan.digest};const a=await http(`${prefix}/${row.id}/purge`,body),b=await http(`${prefix}/${row.id}/purge`,body);expect(a.data.id).toBe(b.data.id);expect((await waitJob(a.data.id)).state).toBe('succeeded');expect((await http(`${prefix}/${row.id}/purge`,{...body,digest:'a'.repeat(64)})).status).toBe(409);
        await admin.query(`CREATE DATABASE "${row.database}"`);expect((await lifecycle.execute({jobId:a.data.id,digest:plan.digest,facts:plan.facts})).state).toBe('succeeded');expect(await present(row.database)).toBe(true);
    });
    it('Physical database ABA after preview rejects old OID and preserves the newly created database',async()=>{
        const row=await seed(),plan=await preview(row);await admin.query(`DROP DATABASE "${row.database}"`);await admin.query(`CREATE DATABASE "${row.database}"`);const job=await purge(row,plan);expect(job.state).toBe('failed');expect(await present(row.database)).toBe(true);
    });
    it('Foreign connection refuses DROP without FORCE, restores connectivity, and explicit same-ID retry succeeds',async()=>{
        const row=await seed(),plan=await preview(row),url=new URL(connection!);url.pathname='/'+row.database;const foreign=new Client({connectionString:url.toString()});await foreign.connect();let job:any;
        try{job=await purge(row,plan);expect(job.state).toBe('failed');expect(await present(row.database)).toBe(true);expect((await admin.query('SELECT datallowconn FROM pg_database WHERE datname=$1',[row.database])).rows[0].datallowconn).toBe(true);expect((await foreign.query('SELECT count(*) FROM rag_chunks')).rows[0].count).toBe('2');}finally{await foreign.end();}
        expect((await http('/api/maintenance/retired-rag-purges/'+job.id+'/retry',{digest:plan.digest})).status).toBe(201);expect((await waitJob(job.id)).state).toBe('succeeded');expect(await present(row.database)).toBe(false);
    },15000);
    it('Crash boundary after DROP reconciles exact durable receipt without another destructive action',async()=>{
        const row=await seed(),plan=await preview(row),id=randomUUID();await ragPool.query(`UPDATE neurocenter_project_databases SET lifecycle_state='purging' WHERE project_id=$1`,[row.project_id]);
        await ragPool.query("INSERT INTO neurocenter_database_purge_receipts(id,project_id,digest,facts,phase) VALUES($1,$2,$3,$4::jsonb,'dropping')",[id,row.project_id,plan.digest,JSON.stringify(plan.facts)]);await admin.query(`DROP DATABASE "${row.database}"`);
        const restarted=new DatabaseLifecycle();try{expect(await restarted.execute({jobId:id,digest:plan.digest,facts:plan.facts})).toMatchObject({jobId:id,state:'succeeded'});}finally{await restarted.onModuleDestroy();}
    });
    it('Malformed name, foreign cluster, and digest mismatch cannot reach DROP',async()=>{
        const row=await seed(),plan=await preview(row);for(const mutate of [(f:any)=>{f.identity.databaseName='catalog";DROP DATABASE catalog;--';},(f:any)=>{f.identity.cluster='1';}]){const facts=structuredClone(plan.facts);mutate(facts);await expect(lifecycle.execute({jobId:randomUUID(),facts,digest:ragRequestHash(facts)})).rejects.toMatchObject({status:409});}await expect(lifecycle.execute({jobId:randomUUID(),facts:plan.facts,digest:'a'.repeat(64)})).rejects.toMatchObject({status:400});expect(await present(row.database)).toBe(true);
    });
    it('Late bridge job or grant cannot be attached after the tombstone',async()=>{const row=await seed();await expect(pool.query("INSERT INTO bridge_jobs VALUES($1,$2,'queued')",[randomUUID(),row.project_id])).rejects.toMatchObject({code:'23514'});await expect(pool.query('INSERT INTO bridge_hosted_rag_grants(id,project_id) VALUES($1,$2)',[randomUUID(),row.project_id])).rejects.toMatchObject({code:'23514'});});
    it('Role revoked after enqueue is checked again before DDL and preserves the database',async()=>{
        const row=await seed(),plan=await preview(row),original=service.authorize.bind(service);let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
        const check=vi.spyOn(service,'authorize').mockImplementationOnce(async(...args)=>{await gate;return original(...args);});
        const response=await http(`${prefix}/${row.id}/purge`,{requestKey:randomUUID(),previewId:plan.id,digest:plan.digest});allowed=false;release();
        await vi.waitFor(async()=>expect((await pool.query('SELECT state FROM retired_rag_purges WHERE id=$1',[response.data.id])).rows[0].state).toBe('failed'));allowed=true;check.mockRestore();expect(await present(row.database)).toBe(true);
    });
    it('Audit failure rolls back the claim before native DROP; no false successful job remains',async()=>{
        const row=await seed(),plan=await preview(row);await pool.query(`CREATE FUNCTION reject_own_purge_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'own audit unavailable'; END $$;
            CREATE TRIGGER reject_own_purge_audit BEFORE INSERT ON security_events FOR EACH ROW WHEN(NEW.action='rag.purge.request') EXECUTE FUNCTION reject_own_purge_audit()`);
        try{expect((await http(`${prefix}/${row.id}/purge`,{requestKey:randomUUID(),previewId:plan.id,digest:plan.digest})).status).toBe(500);expect((await pool.query('SELECT 1 FROM retired_rag_purges WHERE retirement_id=$1',[row.id])).rows).toHaveLength(0);expect(await present(row.database)).toBe(true);}finally{await pool.query('DROP TRIGGER reject_own_purge_audit ON security_events;DROP FUNCTION reject_own_purge_audit()');}
    });
    it('HTTP response lost after real DROP keeps the running barrier, then same-ID receipt recovery completes once',async()=>{
        const row=await seed(),plan=await preview(row);loseResponse=true;
        const response=await http(`${prefix}/${row.id}/purge`,{requestKey:randomUUID(),previewId:plan.id,digest:plan.digest});await vi.waitFor(async()=>expect(await present(row.database)).toBe(false));
        await vi.waitFor(()=>expect((service as any).running.size).toBe(0));expect((await http('/api/maintenance/retired-rag-purges/'+response.data.id)).data.state).toBe('running');
        expect((await http(`${prefix}/${row.id}/purge`,{requestKey:randomUUID(),previewId:plan.id,digest:plan.digest})).status).toBe(409);
        await (service as any).run(response.data.id);expect((await waitJob(response.data.id)).state).toBe('succeeded');expect((await pool.query("SELECT 1 FROM security_events WHERE action='rag.purge.complete' AND resource_id=$1",[row.project_id])).rows).toHaveLength(1);
    });
    it('Restart during ALLOW_CONNECTIONS false reopens only the exact marker/OID, refreezes and completes the approved job',async()=>{
        const row=await seed(),plan=await preview(row),id=randomUUID();await pool.query(`INSERT INTO retired_rag_purges(id,retirement_id,request_key,preview_id,digest,actor,state,message) VALUES($1,$2,$3,$4,$5,'own-admin@example.test','running','Own crash injection')`,[id,row.id,randomUUID(),plan.id,plan.digest]);
        await ragPool.query("UPDATE neurocenter_project_databases SET lifecycle_state='purging' WHERE project_id=$1",[row.project_id]);await ragPool.query("INSERT INTO neurocenter_database_purge_receipts(id,project_id,digest,facts,phase) VALUES($1,$2,$3,$4::jsonb,'freezing')",[id,row.project_id,plan.digest,JSON.stringify(plan.facts)]);await admin.query(`ALTER DATABASE "${row.database}" ALLOW_CONNECTIONS false`);
        const restarted=new DatabaseLifecycle();try{expect((await restarted.execute({jobId:id,digest:plan.digest,facts:plan.facts})).state).toBe('succeeded');}finally{await restarted.onModuleDestroy();}expect(await present(row.database)).toBe(false);
    });
    it('Final facts are measured after the connection fence; a completed late write invalidates the old preview',async()=>{
        const row=await seed(),plan=await preview(row),frozen=(lifecycle as any).frozen.bind(lifecycle);const change=vi.spyOn(lifecycle as any,'frozen').mockImplementationOnce(async(...args:any[])=>{
            const url=new URL(connection!);url.pathname='/'+row.database;const writer=new Client({connectionString:url.toString()});await writer.connect();await writer.query("INSERT INTO rag_chunks VALUES('late committed write')");await writer.end();return frozen(...args);});
        try{expect((await purge(row,plan)).state).toBe('failed');expect(await present(row.database)).toBe(true);}finally{change.mockRestore();}
        const next=await preview(row);expect(next.facts.chunks).toBe(3);expect(next.digest).not.toBe(plan.digest);
    });
    it('Restart with revoked actor repairs its exact connection fence for backups but cannot DROP',async()=>{
        const row=await seed(),plan=await preview(row),id=randomUUID();await pool.query(`INSERT INTO retired_rag_purges(id,retirement_id,request_key,preview_id,digest,actor,state,message) VALUES($1,$2,$3,$4,$5,'own-admin@example.test','running','Own interrupted freeze')`,[id,row.id,randomUUID(),plan.id,plan.digest]);
        await ragPool.query("UPDATE neurocenter_project_databases SET lifecycle_state='purging' WHERE project_id=$1",[row.project_id]);await ragPool.query("INSERT INTO neurocenter_database_purge_receipts(id,project_id,digest,facts,phase) VALUES($1,$2,$3,$4::jsonb,'freezing')",[id,row.project_id,plan.digest,JSON.stringify(plan.facts)]);await admin.query(`ALTER DATABASE "${row.database}" ALLOW_CONNECTIONS false`);allowed=false;
        try{await expect(lifecycle.execute({jobId:id,digest:plan.digest,facts:plan.facts})).rejects.toMatchObject({status:409});expect(await present(row.database)).toBe(true);expect((await admin.query('SELECT datallowconn FROM pg_database WHERE datname=$1',[row.database])).rows[0].datallowconn).toBe(true);}finally{allowed=true;}
    });
});
