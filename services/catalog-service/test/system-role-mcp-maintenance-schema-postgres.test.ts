import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {CATALOG_MIGRATIONS} from '../src/database/catalog-migrations';
import {ensureCatalogSchema,checkCatalogSchema} from '../src/database/catalog-schema';
import {migrateCatalog} from '../src/database/migrations';
import {digest} from '../src/devices/device-store';
import {SystemRoleMcpRepository} from '../src/system-role-mcp/system-role-mcp.repository';
import {ownedDatabase} from './system-role-mcp-postgres.fixture';

const connection=process.env.SYSTEM_ROLE_MCP_MAINTENANCE_TEST_ADMIN_URL;
/** SQL-only legacy receipts retain the physical fence; time and stored outcomes never manufacture a cleanup ACK. */
describe.skipIf(!connection).sequential('MCP cleanup migration37 on caller-owned PostgreSQL',()=>{
 it('rolls back a failed37 and preserves legacy closed claims without a fabricated cleanup receipt',async()=>{
  const f=await ownedDatabase(connection,'nc_mcp37_upgrade_');
  try{
   await migrateCatalog(f.pool,CATALOG_MIGRATIONS.filter(row=>row.version<=36));
   const id=randomUUID(),device=randomUUID(),lease=randomUUID(),hash=digest('a'.repeat(64));
   await f.pool.query("INSERT INTO projects(id,name) VALUES('legacy','Legacy');INSERT INTO platform_users(email) VALUES('legacy@test')");
   await f.pool.query("INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash) VALUES($1,'legacy@test','Админ проекта','Legacy','legacy',$2)",[device,hash]);
   await f.pool.query(`INSERT INTO system_role_mcp_sessions(id,owner_email,actor_role,project_id,target_hash,target,package,job_id,worker_lease,claimed_at,state,deadline_at)
    VALUES($1::uuid,'legacy@test','Админ проекта','legacy',$2,$3::jsonb,'{}',$1::text,$4,now()-interval '1 day','closed',now()-interval '1 day')`,[id,'b'.repeat(64),JSON.stringify({runtime:'device',deviceId:device}),lease]);
   const before=(await f.pool.query('SELECT to_jsonb(s) AS value FROM system_role_mcp_sessions s')).rows;
   const history=(await f.pool.query('SELECT * FROM catalog_schema_migrations ORDER BY version')).rows;
   const failed=CATALOG_MIGRATIONS.map(row=>row.version===37?{...row,sql:row.sql+'; SELECT deliberately_missing_cleanup37_function()'}:row);
   await expect(migrateCatalog(f.pool,failed)).rejects.toThrow();
   expect((await f.pool.query('SELECT * FROM catalog_schema_migrations ORDER BY version')).rows).toEqual(history);
   expect((await f.pool.query('SELECT to_jsonb(s) AS value FROM system_role_mcp_sessions s')).rows).toEqual(before);
   await ensureCatalogSchema(f.pool);
   expect((await f.pool.query("SELECT to_jsonb(s)-ARRAY['worker_closed_at','worker_claim_request_id','worker_claim_token_hash'] AS value FROM system_role_mcp_sessions s")).rows).toEqual(before);
   expect((await f.pool.query('SELECT worker_closed_at,worker_claim_request_id,worker_claim_token_hash FROM system_role_mcp_sessions')).rows[0]).toEqual({worker_closed_at:null,worker_claim_request_id:null,worker_claim_token_hash:null});
   await expect(f.pool.query('DELETE FROM system_role_mcp_sessions WHERE id=$1',[id])).rejects.toThrow('not acknowledged');
   await new SystemRoleMcpRepository(f.pool).acknowledgeDeviceClosed(id,lease,hash);
   expect((await f.pool.query('DELETE FROM system_role_mcp_sessions WHERE id=$1',[id])).rowCount).toBe(1);
   expect((await checkCatalogSchema(f.pool,true)).ready).toBe(true);
  }finally{await f.close();}
 },60000);

 it('detects disabled cleanup guards and missing nonce uniqueness in canonical readiness',async()=>{
  const f=await ownedDatabase(connection,'nc_mcp37_drift_');
  try{
   await ensureCatalogSchema(f.pool);
   await f.pool.query('ALTER TABLE system_role_mcp_sessions DISABLE TRIGGER system_role_mcp_worker_cleanup_guard');
   await expect(checkCatalogSchema(f.pool,true)).rejects.toThrow('system_role_mcp_worker_cleanup_guard');
   await f.pool.query('ALTER TABLE system_role_mcp_sessions ENABLE TRIGGER system_role_mcp_worker_cleanup_guard');
   await f.pool.query('DROP INDEX system_role_mcp_device_claim_request');
   await expect(checkCatalogSchema(f.pool,true)).rejects.toThrow('system_role_mcp_device_claim_request');
  }finally{await f.close();}
 },60000);

 it('retains immutable nonce retirement independently of projects until its device identity is removed',async()=>{
  const f=await ownedDatabase(connection,'nc_mcp37_retired_');
  try{
   await ensureCatalogSchema(f.pool);const device=randomUUID(),requestId=randomUUID(),hash=digest('a'.repeat(64));
   await f.pool.query("INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash) VALUES($1,'retired@test','Админ проекта','Retired','retired',$2)",[device,hash]);
   await f.pool.query('INSERT INTO system_role_mcp_retired_claims(device_id,token_hash,request_id) VALUES($1,$2,$3)',[device,hash,requestId]);
   await expect(f.pool.query('UPDATE system_role_mcp_retired_claims SET request_id=$2 WHERE device_id=$1',[device,randomUUID()])).rejects.toThrow('immutable');
   await expect(f.pool.query('DELETE FROM system_role_mcp_retired_claims WHERE device_id=$1',[device])).rejects.toThrow('immutable');
   expect((await f.pool.query('SELECT request_id FROM system_role_mcp_retired_claims WHERE device_id=$1',[device])).rows).toEqual([{request_id:requestId}]);
   await f.pool.query('DELETE FROM bridge_devices WHERE id=$1',[device]);
   expect((await f.pool.query('SELECT 1 FROM system_role_mcp_retired_claims WHERE device_id=$1',[device])).rowCount).toBe(0);
  }finally{await f.close();}
 },60000);
});
