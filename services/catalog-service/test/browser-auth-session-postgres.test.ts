import {describe,expect,it} from 'vitest';
import type {PoolClient} from 'pg';
import {CATALOG_MIGRATIONS} from '../src/database/catalog-migrations';
import {migrateCatalog} from '../src/database/migrations';
import {ensureCatalogSchema,checkCatalogSchema} from '../src/database/catalog-schema';
import {BrowserAuthSessionRepository} from '../src/browser-auth-sessions/browser-auth-session.repository';
import {browserSessionDatabase} from './browser-auth-session-postgres.fixture';

const connection=process.env.SYSTEM_BROWSER_AUTH_SESSION_TEST_ADMIN_URL,hash='a'.repeat(64),identity={id:'qa',principalName:'qa@example.test',email:'qa@example.test',displayName:'QA'};
const input=()=>({tokenHash:hash,identity,selectedRole:'Разработчик',ttlSeconds:60});
/** Real PostgreSQL invariants; requires the separate canonical owned profile and never uses Catalog's application DSN. */
describe.skipIf(!connection).sequential('Browser session migration38 on explicitly owned PostgreSQL',()=>{
 it('rolls back a failed38, preserves the37 baseline and applies the additive generation',async()=>{
  const f=await browserSessionDatabase(connection);
  try{
   await migrateCatalog(f.pool,CATALOG_MIGRATIONS.filter(row=>row.version<=37));
   await f.pool.query("INSERT INTO projects(id,name) VALUES('session-existing','Existing project')");
   const history=(await f.pool.query('SELECT version,name,checksum FROM catalog_schema_migrations ORDER BY version')).rows;
   await expect(migrateCatalog(f.pool,CATALOG_MIGRATIONS.map(row=>row.version===38?{...row,sql:row.sql+'; SELECT deliberately_missing_browser_session38_function()'}:row))).rejects.toThrow();
   expect((await f.pool.query('SELECT version,name,checksum FROM catalog_schema_migrations ORDER BY version')).rows).toEqual(history);
   expect((await f.pool.query("SELECT to_regclass('browser_auth_sessions') AS name")).rows[0].name).toBeNull();
   await ensureCatalogSchema(f.pool);expect((await checkCatalogSchema(f.pool,true)).ready).toBe(true);
   expect((await f.pool.query("SELECT name FROM projects WHERE id='session-existing'")).rows).toEqual([{name:'Existing project'}]);
   expect((await f.pool.query('SELECT max(version) AS version FROM catalog_schema_migrations')).rows[0].version).toBe(CATALOG_MIGRATIONS.at(-1)?.version);
  }finally{await f.close();}
 },60000);
 it('shares identity and explicit preference across owners without extending expiry and revokes everywhere',async()=>{
  const f=await browserSessionDatabase(connection);
  try{
   await ensureCatalogSchema(f.pool);const first=new BrowserAuthSessionRepository(f.pool),second=new BrowserAuthSessionRepository(f.pool);
   await first.create(input());const original=await first.find(hash);expect(original).toMatchObject({found:true,session:{identity,selectedRole:'Разработчик'}});
   expect(await second.find(hash)).toEqual(original);expect(await second.selectRole(hash,'Наблюдатель')).toEqual({found:true});
   expect(await first.find(hash)).toEqual({...original,...(original.found?{session:{...original.session,selectedRole:'Наблюдатель'}}:{})});
   expect((await f.pool.query('SELECT token_hash,identity FROM browser_auth_sessions')).rows).toEqual([{token_hash:hash,identity}]);
   expect((await f.pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='browser_auth_sessions' ORDER BY column_name")).rows.map(row=>row.column_name)).toEqual(['created_at','expires_at','identity','revoked_at','selected_role','token_hash']);
   await second.revoke(hash);expect(await first.find(hash)).toEqual({found:false});expect(await first.selectRole(hash,'Разработчик')).toEqual({found:false});
   await first.revoke(hash);await expect(first.create(input())).rejects.toHaveProperty('status',503);
   expect(await second.find(hash)).toEqual({found:false});expect(await second.find('b'.repeat(64))).toEqual({found:false});
  }finally{await f.close();}
 },60000);
 it('rejects renewal and resurrection in SQL and never accepts an expired preference update',async()=>{
  const f=await browserSessionDatabase(connection);
  try{
   await ensureCatalogSchema(f.pool);const repository=new BrowserAuthSessionRepository(f.pool);
   await f.pool.query(`INSERT INTO browser_auth_sessions(token_hash,identity,selected_role,created_at,expires_at)
    VALUES($1,$2::jsonb,'Разработчик',statement_timestamp()-interval '120 seconds',statement_timestamp()-interval '60 seconds')`,[hash,JSON.stringify(identity)]);
   expect(await repository.find(hash)).toEqual({found:false});expect(await repository.selectRole(hash,'Наблюдатель')).toEqual({found:false});
   await expect(f.pool.query("UPDATE browser_auth_sessions SET expires_at=expires_at+interval '1 second' WHERE token_hash=$1",[hash])).rejects.toThrow('cannot be renewed');
   await expect(f.pool.query("UPDATE browser_auth_sessions SET selected_role='Наблюдатель' WHERE token_hash=$1",[hash])).rejects.toThrow('cannot be renewed');
   await repository.revoke(hash);await expect(f.pool.query('UPDATE browser_auth_sessions SET revoked_at=NULL WHERE token_hash=$1',[hash])).rejects.toThrow('cannot be renewed');
  }finally{await f.close();}
 },60000);
 it('rejects widened identities and invalid lifetimes at the physical database boundary',async()=>{
  const f=await browserSessionDatabase(connection);
  try{
   await ensureCatalogSchema(f.pool);
   for(const value of [{...identity,userRoles:['Главный админ']},{...identity,access_token:'synthetic'},{...identity,id:''},{...identity,email:'invalid'},{}]){
    await expect(f.pool.query(`INSERT INTO browser_auth_sessions(token_hash,identity,selected_role,expires_at) VALUES($1,$2::jsonb,'Разработчик',now()+interval '60 seconds')`,[hash,JSON.stringify(value)])).rejects.toThrow('Invalid browser session');
   }
   for(const ttl of [59,86401])await expect(f.pool.query(`INSERT INTO browser_auth_sessions(token_hash,identity,selected_role,expires_at) VALUES($1,$2::jsonb,'Разработчик',now()+$3*interval '1 second')`,[hash,JSON.stringify(identity),ttl])).rejects.toThrow('Invalid browser session');
   expect((await f.pool.query('SELECT count(*)::integer AS count FROM browser_auth_sessions')).rows[0].count).toBe(0);
  }finally{await f.close();}
 },60000);
 it('rejects an unchanged role update that waits on the row until the original lifetime expires',async()=>{
  const f=await browserSessionDatabase(connection);let locker:PoolClient|undefined,worker:PoolClient|undefined,holding=false;
  let pending:Promise<{value:{found:boolean}}|{error:unknown}>|undefined;
  try{
   await ensureCatalogSchema(f.pool);
   await f.pool.query(`WITH clock AS(SELECT clock_timestamp() AS now) INSERT INTO browser_auth_sessions(token_hash,identity,selected_role,created_at,expires_at)
    SELECT $1,$2::jsonb,'Разработчик',now-interval '55 seconds',now+interval '5 seconds' FROM clock`,[hash,JSON.stringify(identity)]);
   locker=await f.pool.connect();worker=await f.pool.connect();
   const lockerPid=(await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,workerPid=(await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   await locker.query('BEGIN');holding=true;await locker.query('SELECT token_hash FROM browser_auth_sessions WHERE token_hash=$1 FOR UPDATE',[hash]);
   let settled=false;
   pending=new BrowserAuthSessionRepository(worker).selectRole(hash,'Разработчик').then(value=>{settled=true;return {value};},error=>{settled=true;return {error};});
   let observed=false;
   for(let attempt=0;attempt<500;attempt++){
    await locker.query('SELECT pg_stat_clear_snapshot()');const row=(await locker.query(`SELECT clock_timestamp()<s.expires_at AS before_expiry,a.query_start<s.expires_at AS began_before_expiry,
     a.wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(a.pid)) AS blocked_by_owner
     FROM browser_auth_sessions s JOIN pg_stat_activity a ON a.pid=$3 AND a.datname=current_database() WHERE s.token_hash=$1`,[hash,lockerPid,workerPid])).rows[0];
    if(row?.blocked_by_owner){expect(row.before_expiry).toBe(true);expect(row.began_before_expiry).toBe(true);observed=true;break;}
    if(settled||row&&!row.before_expiry)break;await new Promise(yes=>setTimeout(yes,20));
   }
   expect(observed).toBe(true);let expired=false;
   for(let attempt=0;attempt<500;attempt++){
    expired=(await locker.query('SELECT clock_timestamp()>=expires_at AS expired FROM browser_auth_sessions WHERE token_hash=$1',[hash])).rows[0].expired;
    if(expired)break;await new Promise(yes=>setTimeout(yes,20));
   }
   expect(expired).toBe(true);await locker.query('COMMIT');holding=false;
   const outcome=await pending;if('error'in outcome)throw outcome.error;expect(outcome.value).toEqual({found:false});
  }finally{
   try{if(holding)await locker?.query('ROLLBACK');if(pending)await pending;}finally{worker?.release();locker?.release();await f.close();}
  }
 },60000);
 it('detects missing expiry lookup and disabled or changed physical guards in readiness',async()=>{
  const f=await browserSessionDatabase(connection);
  try{
   await ensureCatalogSchema(f.pool);await f.pool.query('ALTER TABLE browser_auth_sessions DISABLE TRIGGER browser_auth_session_guard');
   await expect(checkCatalogSchema(f.pool,true)).rejects.toThrow('browser_auth_session_guard');await f.pool.query('ALTER TABLE browser_auth_sessions ENABLE TRIGGER browser_auth_session_guard');
   await f.pool.query('DROP INDEX browser_auth_sessions_expiry');await expect(checkCatalogSchema(f.pool,true)).rejects.toThrow('browser_auth_sessions_expiry');
   await f.pool.query('CREATE INDEX browser_auth_sessions_expiry ON browser_auth_sessions(expires_at)');
   await f.pool.query("CREATE OR REPLACE FUNCTION browser_auth_session_guard() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END;'");
   await expect(checkCatalogSchema(f.pool,true)).rejects.toThrow('browser_auth_session_guard');
  }finally{await f.close();}
 },60000);
});
