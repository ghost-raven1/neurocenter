import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it} from 'vitest';
import {CATALOG_MIGRATIONS} from '../src/database/catalog-migrations';
import {ensureCatalogSchema,checkCatalogSchema} from '../src/database/catalog-schema';
import {migrateCatalog,migrationChecksum,validateMigrationHistory} from '../src/database/migrations';
import {CURRENT_CATALOG_SCHEMA_CONTRACT} from '../src/database/current-schema-verification';
const connection=process.env.CATALOG_TEST_PG_URL;
const databases:Array<{pool:Pool;admin:Pool;name:string}>=[];
async function fixture(){
 const url=new URL(connection!);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Only disposable localhost databases');
 url.pathname='/postgres';const admin=new Pool({connectionString:url.href,max:1}),name='nc_catalog_migration_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE DATABASE '+name);url.pathname='/'+name;const pool=new Pool({connectionString:url.href,max:4});databases.push({pool,admin,name});return pool;
}
afterEach(async()=>{for(const {pool,admin,name} of databases.splice(0)){await pool.end();await admin.query('DROP DATABASE '+name);await admin.end();}});
const history=async(pool:Pool)=>(await pool.query('SELECT version,name,checksum,applied_at FROM catalog_schema_migrations ORDER BY version')).rows;
const legacy=async(pool:Pool,last=5)=>{await migrateCatalog(pool,CATALOG_MIGRATIONS.slice(0,last+1));await pool.query('DELETE FROM catalog_schema_migrations WHERE version=0');};
describe('Frozen catalog migration contract',()=>{
 it('freezes all seven SQL checksums, including the adopted baseline and physical contract',()=>{expect(CATALOG_MIGRATIONS.slice(0,7).map(m=>migrationChecksum(m.sql))).toEqual([
 '5674117e472013f221ab63b4bbc103474182bf5dbbd3763cff517975c7b8b3d8','68514dc6172c482cd9b7cb6f5ee9909f13951125b807a1acc01a650113fa0363','48ba300c7edeba86966e5569fe68292d59551577a83e1defd0001f2ff2f981f7','4e3cae536018da83de34666e4728cd872db47b6060aea67d7f8439f3179ad92a','62549de8bf998487ebe54ef75462e3280caa6ef984170ec620abea90a99aebfd','33a34d16a6a22f0756bc76972a60571755834e1874a003f91335a76a88b74ca4','cb2422c0292cb52c70e154b861c8ab3a1841207238da001452ef4803f073ab0a']);});
 it('freezes native-agent and catalog-request migration checksums',()=>{expect(CATALOG_MIGRATIONS.filter(migration=>migration.version>=7&&migration.version<=8).map(migration=>migrationChecksum(migration.sql))).toEqual(['8fa2205e520bad439eb2bbd60f76be93a3cac649b52a7cf2bba0411664288ba6','877fcebdceb12579d3ad68d465e7e5c6de18381673b93c0fd9f47d47b79a917a']);});
 it('freezes bridge-source settings and verification migration',()=>{expect(migrationChecksum(CATALOG_MIGRATIONS.find(migration=>migration.version===9)!.sql)).toBe('baf3e5e369cf9884f139341d99cb42b34fa1fc8e50c3fedac6ce6d1518950978');});
 it('appends service chat and MCP execution without reusing released versions',()=>{expect(CATALOG_MIGRATIONS.map(({version})=>version)).toEqual(Array.from({length:46},(_,index)=>index));expect(CATALOG_MIGRATIONS.find(migration=>migration.version===32)!.name).toBe('isolated-project-chat-room-execution');expect(CATALOG_MIGRATIONS.find(migration=>migration.version===35)!.name).toBe('private-system-role-service-chat');expect(CATALOG_MIGRATIONS.find(migration=>migration.version===37)!.name).toBe('durable-device-mcp-cleanup');expect(CATALOG_MIGRATIONS.at(-1)!.name).toBe('durable-project-chat-method-workflows');});
 it('preserves released project-chat, dialogue, RAG authorization and learning receipt migration checksums',()=>{expect(CATALOG_MIGRATIONS.filter(m=>[23,25,30,31].includes(m.version)).map(m=>migrationChecksum(m.sql))).toEqual(['7e0d7e69132bd7f1e7b88a7d0415107ac0f506419f81b1169bdceec1b783d3d8','1a124b1e21244df312eeb348afd892d6d435b65740eb122a0f8d436cadbc3b72','d2fb516b034a83320349372a936a78f949044ecf487a127430d8c7b0faeeda2b','79e5995e6c2884f7e76e402284d04cac9c6faca89bf3060033d9c5d052f0048b']);});
 it('does not bless a missing baseline after version 6',()=>{const rows=CATALOG_MIGRATIONS.slice(1).map(m=>({...m,checksum:migrationChecksum(m.sql)}));expect(()=>validateMigrationHistory(CATALOG_MIGRATIONS,rows)).toThrow('baseline');});
});
describe.skipIf(!connection)('Complete catalog schema — disposable PostgreSQL',()=>{
 it('upgrades released 26 without rewriting builds and retains bounded agent/runtime evidence',async()=>{
  const pool=await fixture();await migrateCatalog(pool,CATALOG_MIGRATIONS.filter(migration=>migration.version<=26));
  const id=randomUUID(),nonce=randomUUID();
  await pool.query("INSERT INTO tool_build_jobs(id,actor,request_key,request_hash,config,state,message) VALUES($1,'owner@localhost',$2,'unchanged','{}','SUCCEEDED','Existing build')",[id,randomUUID()]);
  const before=(await pool.query('SELECT to_jsonb(j) AS row FROM tool_build_jobs j')).rows,oldHistory=await history(pool);
  expect((await checkCatalogSchema(pool)).pending).toEqual([27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45]);await ensureCatalogSchema(pool);
  expect((await history(pool)).filter(row=>row.version<=26)).toEqual(oldHistory);expect((await pool.query('SELECT to_jsonb(j) AS row FROM tool_build_jobs j')).rows).toEqual(before);
  const runtime=(attempt:number,report:unknown)=>pool.query('INSERT INTO tool_build_runtime_checks(build_id,attempt,execution_nonce,report) VALUES($1,$2,$3,$4)',[id,attempt,nonce,report]);
  await runtime(1,{schemaVersion:1,status:'failed'});await expect(runtime(1,{schemaVersion:1})).rejects.toThrow();await expect(runtime(4,{schemaVersion:1})).rejects.toThrow();await expect(runtime(2,{})).rejects.toThrow();
  const step=(attempt:number)=>pool.query("INSERT INTO tool_build_agent_steps(build_id,execution_nonce,attempt,stage,state,model_id,model_pin,input_hash) VALUES($1,$2,$3,'propose','STARTED','model-existing',$4,$4)",[id,nonce,attempt,'a'.repeat(64)]);
  await step(1);await expect(step(1)).rejects.toThrow();await expect(step(4)).rejects.toThrow();
  expect((await checkCatalogSchema(pool,true)).ready).toBe(true);
 });
 it('preflight is read-only, then fresh chain creates every managed table and replays unchanged',async()=>{
  const pool=await fixture();expect(await checkCatalogSchema(pool)).toEqual({ok:true,ready:false,existingSchema:false,applied:[],pending:CATALOG_MIGRATIONS.map(migration=>migration.version)});
  expect((await pool.query("SELECT to_regclass('catalog_schema_migrations') AS name")).rows[0].name).toBeNull();await expect(checkCatalogSchema(pool,true)).rejects.toThrow('миграции');await ensureCatalogSchema(pool);
  expect(await checkCatalogSchema(pool,true)).toEqual({ok:true,ready:true,existingSchema:true,applied:CATALOG_MIGRATIONS.map(migration=>migration.version),pending:[]});
  expect((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename)).toEqual(CURRENT_CATALOG_SCHEMA_CONTRACT.filter(f=>f.kind==='table').map(f=>f.id).sort());
  const before=await history(pool);await ensureCatalogSchema(pool);expect(await history(pool)).toEqual(before);
 });
 it.each([1,3,5])('adopts legacy prefix 1..%i preserving history and exact project pins',async last=>{
  const pool=await fixture();await legacy(pool,last);const before=await history(pool);await pool.query("INSERT INTO projects(id,name) VALUES('historical','Preserve me')");
  await pool.query("INSERT INTO project_assets(project_id,asset_id,asset_kind,added_by,asset_version,asset_manifest,pin_origin,pin_snapshot) VALUES('historical','old-pin','plugin','fixture',7,$1,'assigned',$2)",['a'.repeat(64),JSON.stringify({proof:'opaque historical bytes'})]);const pins=(await pool.query('SELECT * FROM project_assets')).rows;
  expect((await checkCatalogSchema(pool)).pending).toContain(0);await ensureCatalogSchema(pool);expect((await history(pool)).filter(r=>r.version>0&&r.version<=last)).toEqual(before);expect((await pool.query('SELECT * FROM project_assets')).rows).toEqual(pins);
 });
 it('adopts historical model versions, remote ciphertext, immutable packages and operation receipts without rewriting bytes',async()=>{
  const pool=await fixture();await legacy(pool);await pool.query("INSERT INTO projects(id,name) VALUES('preserve','Preserve')");
  await pool.query("INSERT INTO model_catalog(id,name,descriptor) VALUES('model-old','Historical model','{}')");
  await pool.query("INSERT INTO model_catalog_versions(model_id,revision,name,descriptor,model_pin,created_at,updated_at) VALUES('model-old',1,'Historical model','{}',$1,now(),now())",['b'.repeat(64)]);
  await pool.query("INSERT INTO model_remote_connections(model_id,revision,base_url,request_dimensions,credential_kind,credential,semantic_sha) VALUES('model-old',1,'http://localhost:1',false,'stored',$1,$2)",[JSON.stringify({iv:'opaque-iv',ciphertext:'opaque-ciphertext',tag:'opaque-tag'}),'c'.repeat(64)]);
  await pool.query("INSERT INTO ai_plugins(id,name) VALUES('plugin-old','Historical plugin');INSERT INTO ai_plugin_versions(ai_plugin_id,version,files,config) VALUES('plugin-old',1,'[]','{}')");
  const tables=['model_catalog','model_catalog_versions','model_remote_connections','ai_plugin_versions'],before=await Promise.all(tables.map(async table=>(await pool.query('SELECT to_jsonb(t) AS row FROM '+table+' t')).rows));
  await ensureCatalogSchema(pool);expect(await Promise.all(tables.map(async table=>(await pool.query('SELECT '+(table==='model_remote_connections'?"to_jsonb(t)-'options'-'timeout_ms'":'to_jsonb(t)')+' AS row FROM '+table+' t')).rows))).toEqual(before);
  expect((await pool.query('SELECT options,timeout_ms FROM model_remote_connections')).rows).toEqual([{options:{},timeout_ms:90000}]);
 });
 it('detects existing unversioned application data without stamping a journal',async()=>{
  const pool=await fixture();await pool.query('CREATE TABLE operator_history(value TEXT)');
  expect(await checkCatalogSchema(pool)).toEqual({ok:true,ready:false,existingSchema:true,applied:[],pending:CATALOG_MIGRATIONS.map(migration=>migration.version)});
  expect((await pool.query("SELECT to_regclass('catalog_schema_migrations') AS name")).rows[0].name).toBeNull();
 });
 it('adopts only the released MCP message default without rewriting old job messages',async()=>{
  const pool=await fixture();await legacy(pool);await pool.query("ALTER TABLE bridge_jobs ALTER COLUMN message SET DEFAULT 'Ожидает MCP'");
  await pool.query("INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash) VALUES('device','fixture@localhost','Главный админ','Fixture','fixture','opaque')");
  const add=async(id:string)=>pool.query("INSERT INTO bridge_jobs(id,device_id,email,role,kind,payload,request_key,request_hash) VALUES($1,'device','fixture@localhost','Главный админ','fixture','{}',$1,'opaque')",[id]);
  await add('old');const old=(await pool.query("SELECT to_jsonb(j) AS row FROM bridge_jobs j WHERE id='old'")).rows;
  await ensureCatalogSchema(pool);expect((await pool.query("SELECT to_jsonb(j) AS row FROM bridge_jobs j WHERE id='old'")).rows).toEqual(old);
  await add('new');expect((await pool.query('SELECT id,message FROM bridge_jobs ORDER BY id')).rows).toEqual([{id:'new',message:'Ожидает моста'},{id:'old',message:'Ожидает MCP'}]);
 });
 it('does not silently normalize an unknown historical job default',async()=>{
  const pool=await fixture();await legacy(pool);await pool.query("ALTER TABLE bridge_jobs ALTER COLUMN message SET DEFAULT 'operator-custom-default'");const before=await history(pool);
  await expect(ensureCatalogSchema(pool)).rejects.toThrow();expect(await history(pool)).toEqual(before);
  expect((await pool.query("SELECT pg_get_expr(d.adbin,d.adrelid) AS value FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE a.attrelid='bridge_jobs'::regclass AND a.attname='message'")).rows[0].value).toBe("'operator-custom-default'::text");
 });
 it('upgrades 0+1 and serializes competing runners',async()=>{const pool=await fixture();await migrateCatalog(pool,CATALOG_MIGRATIONS.slice(0,2));expect((await checkCatalogSchema(pool)).pending).toEqual(CATALOG_MIGRATIONS.slice(2).map(migration=>migration.version));await Promise.all([ensureCatalogSchema(pool),ensureCatalogSchema(pool)]);expect((await history(pool)).map(r=>r.version)).toEqual(CATALOG_MIGRATIONS.map(migration=>migration.version));});
 it('upgrades released version 9 without rewriting history, project pins or bridge-source settings',async()=>{
  const pool=await fixture();await migrateCatalog(pool,CATALOG_MIGRATIONS.filter(migration=>migration.version<=9));const before=await history(pool);
  await pool.query("INSERT INTO projects(id,name) VALUES('released','Released project')");
  await pool.query("INSERT INTO project_assets(project_id,asset_id,asset_kind,added_by,asset_version,asset_manifest,pin_origin,pin_snapshot) VALUES('released','released-pin','plugin','fixture',7,$1,'assigned',$2)",['a'.repeat(64),JSON.stringify({proof:'unchanged released bytes'})]);
  await pool.query("UPDATE bridge_source_settings SET revision=7,url='https://github.com/example/verified-assets',updated_by='fixture'");
  const preserved=['projects','project_assets','bridge_source_settings'],rows=await Promise.all(preserved.map(async table=>(await pool.query('SELECT to_jsonb(t) AS row FROM '+table+' t')).rows));
  expect((await checkCatalogSchema(pool)).pending).toEqual([10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45]);await ensureCatalogSchema(pool);
  expect((await history(pool)).filter(row=>row.version<=9)).toEqual(before);expect((await history(pool)).at(-1).version).toBe(45);
  expect(await Promise.all(preserved.map(async table=>(await pool.query('SELECT to_jsonb(t) AS row FROM '+table+' t')).rows))).toEqual(rows);
  expect((await checkCatalogSchema(pool,true)).ready).toBe(true);
 });
 it('rolls back a failed learning upgrade while preserving the released journal and data for retry',async()=>{
  const pool=await fixture();await migrateCatalog(pool,CATALOG_MIGRATIONS.filter(migration=>migration.version<=9));await pool.query("INSERT INTO projects(id,name) VALUES('retry','Preserve on failure')");const before=await history(pool),projects=(await pool.query('SELECT * FROM projects')).rows;
  const invalid=CATALOG_MIGRATIONS.map(migration=>migration.version===10?{...migration,sql:migration.sql+'; SELECT deliberately_missing_function()'}:migration);
  await expect(migrateCatalog(pool,invalid)).rejects.toThrow();expect(await history(pool)).toEqual(before);expect((await pool.query('SELECT * FROM projects')).rows).toEqual(projects);
  expect((await pool.query("SELECT to_regclass('project_learning_state') AS state,to_regclass('project_learning_analyses') AS analyses,to_regprocedure('neurocenter_learning_immutable()') AS immutable")).rows[0]).toEqual({state:null,analyses:null,immutable:null});
  await ensureCatalogSchema(pool);expect((await checkCatalogSchema(pool,true)).ready).toBe(true);
 });
 it.each(['checksum','name','gap','unknown'])('rejects incompatible %s before baseline DDL',async kind=>{
  const pool=await fixture();await legacy(pool);await pool.query(kind==='checksum'?"UPDATE catalog_schema_migrations SET checksum='changed' WHERE version=3":kind==='name'?"UPDATE catalog_schema_migrations SET name='changed' WHERE version=3":kind==='gap'?'DELETE FROM catalog_schema_migrations WHERE version=3':"INSERT INTO catalog_schema_migrations(version,name,checksum) VALUES(99,'future','opaque')");
  await pool.query('DROP TABLE platform_bootstrap');const before=await history(pool);await expect(ensureCatalogSchema(pool)).rejects.toThrow('История');expect(await history(pool)).toEqual(before);expect((await pool.query("SELECT to_regclass('platform_bootstrap') AS name")).rows[0].name).toBeNull();
 });
 it.each(['ALTER TABLE platform_users ALTER COLUMN enabled DROP NOT NULL','ALTER TABLE platform_users ALTER COLUMN display_name TYPE varchar(200)','ALTER TABLE platform_users DROP CONSTRAINT platform_users_pkey CASCADE','DROP INDEX security_events_created',"CREATE OR REPLACE FUNCTION neurocenter_project_retirement_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",'ALTER TABLE projects DISABLE TRIGGER neurocenter_project_retirement_guard'])('detects physical drift: %s',async sql=>{const pool=await fixture();await ensureCatalogSchema(pool);await pool.query(sql);await expect(checkCatalogSchema(pool,true)).rejects.toThrow();});
 it('final adoption rejects wrong structure and rolls back baseline record',async()=>{const pool=await fixture();await legacy(pool);await pool.query('ALTER TABLE platform_users ALTER COLUMN enabled DROP NOT NULL');const before=await history(pool);await expect(ensureCatalogSchema(pool)).rejects.toThrow();expect(await history(pool)).toEqual(before);});
 it.each([0,...Array.from({length:40},(_,index)=>index+6)])('version %i failure rolls back all new objects and ledger; retry works',async version=>{const pool=await fixture();const invalid=CATALOG_MIGRATIONS.map(m=>m.version===version?{...m,sql:m.sql+'; SELECT deliberately_missing_function()'}:m);await expect(migrateCatalog(pool,invalid)).rejects.toThrow();expect((await pool.query("SELECT to_regclass('projects') AS name,to_regclass('catalog_schema_migrations') AS ledger")).rows[0]).toEqual({name:null,ledger:null});await ensureCatalogSchema(pool);expect((await checkCatalogSchema(pool,true)).ready).toBe(true);});
 it('upgrades released 19 to current without rewriting old checksums, credentials, project pins or inference receipts',async()=>{
  const pool=await fixture();await migrateCatalog(pool,CATALOG_MIGRATIONS.filter(migration=>migration.version<=19));
  await pool.query("INSERT INTO projects(id,name) VALUES('prj-trial-upgrade','Preserve 19');INSERT INTO platform_users(email) VALUES('owner@localhost')");
  await pool.query("INSERT INTO model_catalog(id,name,descriptor) VALUES('model-upgrade','Existing model','{}')");
  await pool.query("INSERT INTO model_remote_connections(model_id,revision,base_url,request_dimensions,credential_kind,credential,semantic_sha) VALUES('model-upgrade',1,'https://provider.invalid',false,'stored',$1,$2)",[JSON.stringify({iv:'unchanged',ciphertext:'opaque',tag:'opaque'}),'b'.repeat(64)]);
  await pool.query("INSERT INTO project_models(project_id,model_id,added_by) VALUES('prj-trial-upgrade','model-upgrade','owner@localhost')");
  await pool.query("INSERT INTO model_chat_conversations(id,owner_email,model_id,project_id,model_pin,title) VALUES($1,'owner@localhost','model-upgrade','prj-trial-upgrade',$2,'Existing private chat')",[randomUUID(),'a'.repeat(64)]);
  await pool.query("INSERT INTO model_usage_calls(id,worker_id,model_id,model_name,provider,endpoint,purpose,actor_email,project_id,status,input_tokens,output_tokens,latency_ms,finished_at) VALUES($1,$2,'model-upgrade','Existing model','remote-openai','chat','verification','owner@localhost','prj-trial-upgrade','success',31,13,1,now())",[randomUUID(),randomUUID()]);
  const oldHistory=await history(pool),tables=['projects','platform_users','model_catalog','model_remote_connections','project_models','model_chat_conversations','model_usage_calls'];
  const preserved=()=>Promise.all(tables.map(async table=>(await pool.query('SELECT '+(table==='model_usage_calls'?"to_jsonb(t)-ARRAY['dispatch_count','dispatched_at','rate_wait_ms','provider_latency_ms','failure_code','private_project_chat_room_id']":'to_jsonb(t)')+' AS row FROM '+table+' t ORDER BY to_jsonb(t)::text')).rows));
  const rows=await preserved();
  expect((await checkCatalogSchema(pool)).pending).toEqual([20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45]);
  const broken=CATALOG_MIGRATIONS.map(migration=>migration.version===20?{...migration,sql:migration.sql+'; SELECT deliberately_missing_function()'}:migration);
  await expect(migrateCatalog(pool,broken)).rejects.toThrow();expect(await history(pool)).toEqual(oldHistory);
  expect((await pool.query("SELECT to_regclass('agent_readiness_trials') AS name")).rows[0].name).toBeNull();
  await ensureCatalogSchema(pool);expect((await history(pool)).filter(row=>row.version<=19)).toEqual(oldHistory);
  expect(await preserved()).toEqual(rows);
  expect((await pool.query('SELECT dispatch_count,dispatched_at,rate_wait_ms,provider_latency_ms,failure_code,private_project_chat_room_id FROM model_usage_calls')).rows).toEqual([{dispatch_count:null,dispatched_at:null,rate_wait_ms:null,provider_latency_ms:null,failure_code:null,private_project_chat_room_id:null}]);
  expect((await pool.query('SELECT * FROM agent_readiness_trials')).rows).toEqual([]);expect((await checkCatalogSchema(pool,true)).ready).toBe(true);
 });
 it.each(['ALTER TABLE model_remote_connections ALTER COLUMN options DROP NOT NULL','ALTER TABLE model_remote_connections ALTER COLUMN timeout_ms SET DEFAULT 500','ALTER TABLE model_remote_connections DROP CONSTRAINT model_remote_connections_options_check'])('detects private model settings drift: %s',async sql=>{const pool=await fixture();await ensureCatalogSchema(pool);await pool.query(sql);await expect(checkCatalogSchema(pool,true)).rejects.toThrow();});
 it.each(['ALTER TABLE bridge_source_settings ALTER COLUMN revision DROP NOT NULL','DROP TABLE bridge_source_checks','ALTER TABLE asset_source_jobs DROP COLUMN bridge_source_revision'])('detects bridge-source physical drift: %s',async sql=>{const pool=await fixture();await ensureCatalogSchema(pool);await pool.query(sql);await expect(checkCatalogSchema(pool,true)).rejects.toThrow();});
 it.each(['ALTER TABLE project_learning_state ALTER COLUMN revision DROP NOT NULL','DROP INDEX project_learning_analysis_queue','ALTER TABLE project_learning_experiences DISABLE TRIGGER neurocenter_learning_immutable','ALTER TABLE project_learning_analyses DISABLE TRIGGER neurocenter_learning_analysis_immutable'])('detects learning physical drift: %s',async sql=>{const pool=await fixture();await ensureCatalogSchema(pool);await pool.query(sql);await expect(checkCatalogSchema(pool,true)).rejects.toThrow();});
 it('read-only readiness holds the migration fence across history and physical facts',async()=>{
  const pool=await fixture();await ensureCatalogSchema(pool);const writer=await pool.connect();await writer.query('BEGIN');
  let write:Promise<void>|undefined,writerFinished=false;
  const inspect=async(sql:string,values?:unknown[],client?:import('pg').PoolClient)=>{
   const result=await (client?client.query(sql,values):pool.query(sql,values));
   if(sql.startsWith('SELECT version,name,checksum')){
    write=(async()=>{await writer.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:catalog:migrations',0))");await writer.query(`INSERT INTO catalog_schema_migrations(version,name,checksum) VALUES(${CATALOG_MIGRATIONS.at(-1)!.version+1},'future','opaque')`);await writer.query('COMMIT');writerFinished=true;})();
    for(let n=0;n<100&&!writerFinished;n++){
     if((await pool.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted',[(writer as import('pg').PoolClient&{processID:number}).processID])).rowCount)break;
     await new Promise(resolve=>setTimeout(resolve,5));
    }
   }
   return result;
  };
  const checkedPool={query:(sql:string,values?:unknown[])=>inspect(sql,values),connect:async()=>{const client=await pool.connect();return{query:(sql:string,values?:unknown[])=>inspect(sql,values,client),release:()=>client.release()};}} as unknown as Pool;
  try{
   expect((await checkCatalogSchema(checkedPool,true)).ready).toBe(true);expect(writerFinished).toBe(false);
   await write;await expect(checkCatalogSchema(pool,true)).rejects.toThrow('История');
  }finally{await writer.query('ROLLBACK');writer.release();}
 });
 it('allows unrelated historical objects without deleting them',async()=>{const pool=await fixture();await pool.query('CREATE TABLE unrelated_history(value TEXT)');await ensureCatalogSchema(pool);await pool.query('ALTER TABLE platform_users ADD COLUMN optional_extension TEXT;CREATE INDEX operator_extra_user_index ON platform_users(enabled)');await ensureCatalogSchema(pool);expect((await pool.query("SELECT to_regclass('unrelated_history') AS name")).rows[0].name).toBe('unrelated_history');});
});
