import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Pool,type PoolClient} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {callerOwnedPostgresAdmin} from './caller-owned-postgres.fixture';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {PluginRepository} from '../src/publication/plugin-repository';
import {nativeCardHash} from '../src/publication/native-hash';
import {publicationHash} from '../src/publication/publication-validation';
import {managedRebuildPublication,pinBuildPublication} from '../src/package-build/publication-target';
import type {IAiPlugin} from '../src/catalog/dto';

const connection=process.env.CATALOG_REBUILD_TEST_ADMIN_PG_URL;
const actor='catalog-rebuild-qa@example.test';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};

/** An SQL-result barrier changes timing only; both sessions execute against real PostgreSQL. */
function pausedSnapshot(pool:Pool){
 const selected=deferred(),resume=deferred(),statements:string[]=[];
 const instrumented={connect:async()=>{
  const client=await pool.connect(),query=client.query.bind(client);
  return {query:async(sql:string,parameters?:unknown[])=>{
   const result=await query(sql,parameters);statements.push(sql);
   if(sql.startsWith('SELECT * FROM ai_plugins')){selected.resolve();await resume.promise;}
   return result;
  },release:(error?:Error|boolean)=>client.release(error)} as unknown as PoolClient;
 }} as unknown as Pool;
 return {pool:instrumented,selected:selected.promise,resume:resume.resolve,statements};
}

describe.skipIf(!connection).sequential('Automatic rebuild publication pins on caller-owned PostgreSQL',()=>{
 let admin:Pool,pool:Pool,plugins:PluginRepository,database:string,created=false;
 const receipt={database:'',systemIdentifier:'',poolMaximum:2,sessionsBeforeDrop:-1,dropped:false,checks:[] as string[]};
 beforeAll(async()=>{
  const url=callerOwnedPostgresAdmin({TEST_ADMIN_PG_URL:connection});
  const expectedSystem=process.env.CATALOG_REBUILD_TEST_SYSTEM_IDENTIFIER;
  if(!expectedSystem||!/^\d+$/.test(expectedSystem))throw Error('Explicit owned PostgreSQL system identifier is required.');
  admin=new Pool({connectionString:url.href,max:1,statement_timeout:10000,connectionTimeoutMillis:5000});
  receipt.systemIdentifier=(await admin.query<{id:string}>('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
  expect(receipt.systemIdentifier).toBe(expectedSystem);
  database='nc_rebuild_pin_'+randomUUID().replaceAll('-','');receipt.database=database;
  await admin.query('CREATE DATABASE '+database);created=true;url.pathname='/'+database;
  pool=new Pool({connectionString:url.href,max:2,statement_timeout:10000,connectionTimeoutMillis:5000});
  await ensureCatalogSchema(pool);plugins=new PluginRepository(pool);
 },30000);
 afterAll(async()=>{
  try{
   await pool?.end();
   if(admin&&created){
    receipt.sessionsBeforeDrop=Number((await admin.query('SELECT count(*) FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].count);
    await admin.query('DROP DATABASE '+database);
    receipt.dropped=!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount;
   }
  }finally{
   await admin?.end();
   if(process.env.CATALOG_REBUILD_TEST_RECEIPT_FILE)await writeFile(process.env.CATALOG_REBUILD_TEST_RECEIPT_FILE,JSON.stringify(receipt,null,2)+'\n');
  }
 },15000);

 async function seed(kind:'mcp'|'plugin'='mcp'){
  const suffix=randomUUID(),sourceId='source-'+suffix;
  const card=await plugins.create({name:'Rebuild QA '+suffix,kind,description:'Managed original',origin:'upload',revision:'source-v1',
   config:kind==='mcp'?{transport:'remote',url:'https://never-requested.example.test/mcp'}:{entrypoint:'index.js'},
   files:kind==='plugin'?[{path:'index.js',content:'export default async () => ({})',size:30,digest:createHash('sha256').update('export default async () => ({})').digest('hex')}]:[]},actor);
  const descriptor={schemaVersion:1,id:sourceId,kind,version:'1.0.0',name:card.name};
  await pool.query(`INSERT INTO asset_source_receipts(repository,external_id,asset_kind,asset_version,descriptor_sha256,source_commit,native_id,native_version,native_hash,descriptor,blobs,imported_by,revision,active)
   VALUES('local-archive',$1,$2,'1.0.0',$3,NULL,$4,$5,$6,$7::jsonb,'[]'::jsonb,$8,1,true)`,
  [sourceId,kind,publicationHash(descriptor),card.id,card.version,nativeCardHash(card),JSON.stringify(descriptor),actor]);
  return {card,sourceId};
 }
 async function snapshot(card:IAiPlugin){
  const [head,versions,owners]=await Promise.all([
   pool.query('SELECT * FROM ai_plugins WHERE id=$1',[card.id]),
   pool.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=$1 ORDER BY version',[card.id]),
   pool.query('SELECT * FROM asset_source_receipts WHERE native_id=$1 ORDER BY repository,external_id',[card.id]),
  ]);
  return {head:head.rows,versions:versions.rows,owners:owners.rows};
 }

 it.each(['mcp','plugin'] as const)('Accepts an exact managed %s head and preserves receipt, descriptor hash and version history',async kind=>{
  const {card,sourceId}=await seed(kind),before=await snapshot(card);
  const target=await managedRebuildPublication(pool,kind,card.id,sourceId);
  const pin=await pinBuildPublication(pool,{kind,name:target.name,publication:target.publication});
  expect(pin).toMatchObject({catalogId:card.id,expectedVersion:1,nativeHash:nativeCardHash(card),origins:[{externalId:sourceId,nativeVersion:1,nativeHash:nativeCardHash(card)}]});
  expect(await snapshot(card)).toEqual(before);
  receipt.checks.push('Exact managed '+kind+' pin is readonly; receipt, hashes and immutable history preserved');
 });

 it('Keeps one repeatable-read target during concurrent manual edit, then rejects that stale target without overwriting the edit',async()=>{
  const {card,sourceId}=await seed(),before=await snapshot(card),barrier=pausedSnapshot(pool);
  const targetPromise=managedRebuildPublication(barrier.pool,'mcp',card.id,sourceId);
  const observed=targetPromise.catch(()=>undefined);
  let edited:IAiPlugin|null=null;
  try{
   await Promise.race([barrier.selected,targetPromise.then(()=>{throw Error('Snapshot completed before the controlled SQL barrier.');})]);
   edited=await plugins.update(card.id,{expectedVersion:1,description:'Manual change while old snapshot is open'},actor);
  }finally{barrier.resume();}
  await observed;const target=await targetPromise;
  expect(edited?.version).toBe(2);
  expect(target.publication.expectedVersion).toBe(1);
  const afterEdit=await snapshot(card);
  expect(afterEdit.owners).toEqual(before.owners);
  expect(afterEdit.versions).toHaveLength(2);
  await expect(pinBuildPublication(pool,{kind:'mcp',name:target.name,publication:target.publication})).rejects.toMatchObject({status:409});
  await expect(managedRebuildPublication(pool,'mcp',card.id,sourceId)).rejects.toMatchObject({status:409});
  expect(await snapshot(card)).toEqual(afterEdit);
  receipt.checks.push('Actual concurrent manual v2 survives stale RR target and fresh managed-target rejection; source receipt unchanged');
 });

 it('Does not mix an old head with a concurrently committed new source receipt in one target snapshot',async()=>{
  const {card,sourceId}=await seed(),initial=await managedRebuildPublication(pool,'mcp',card.id,sourceId),barrier=pausedSnapshot(pool);
  const targetPromise=managedRebuildPublication(barrier.pool,'mcp',card.id,sourceId),observed=targetPromise.catch(()=>undefined);
  try{
   await Promise.race([barrier.selected,targetPromise.then(()=>{throw Error('Snapshot completed before the controlled SQL barrier.');})]);
   const writer=await pool.connect();
   try{
    await writer.query('BEGIN');
    const updated=await plugins.update(card.id,{expectedVersion:1,description:'Managed source v2 committed during target read'},actor,undefined,writer,true);
    expect(updated?.version).toBe(2);
    await writer.query('UPDATE asset_source_receipts SET native_version=$2,native_hash=$3,revision=revision+1,asset_version=$4 WHERE external_id=$1',[sourceId,updated!.version,nativeCardHash(updated!),'2.0.0']);
    await writer.query('COMMIT');
   }catch(error){await writer.query('ROLLBACK');throw error;}finally{writer.release();}
  }finally{barrier.resume();}
  await observed;expect(await targetPromise).toEqual(initial);
  const updated=await managedRebuildPublication(pool,'mcp',card.id,sourceId),beforeAdmission=await snapshot(card);
  expect(updated.publication.expectedVersion).toBe(2);
  expect(updated.publication.expectedSourceHash).not.toBe(initial.publication.expectedSourceHash);
  await expect(pinBuildPublication(pool,{kind:'mcp',name:initial.name,publication:initial.publication})).rejects.toMatchObject({status:409});
  expect((await pinBuildPublication(pool,{kind:'mcp',name:updated.name,publication:updated.publication}))?.expectedVersion).toBe(2);
  expect(await snapshot(card)).toEqual(beforeAdmission);
  receipt.checks.push('Actual RR coherence across atomic concurrent head/receipt v2 commit; stale pin rejected and fresh pin accepted without writes');
 });

 it('Origin-only change after target selection rejects admission even though native version and hash stay identical',async()=>{
  const {card,sourceId}=await seed(),target=await managedRebuildPublication(pool,'mcp',card.id,sourceId);
  await pool.query('UPDATE asset_source_receipts SET revision=revision+1,descriptor_sha256=$2 WHERE external_id=$1',[sourceId,'d'.repeat(64)]);
  const changed=await snapshot(card);
  await expect(pinBuildPublication(pool,{kind:'mcp',name:target.name,publication:target.publication})).rejects.toMatchObject({status:409});
  expect(await snapshot(card)).toEqual(changed);
  const refreshed=await managedRebuildPublication(pool,'mcp',card.id,sourceId);
  expect(refreshed.publication.expectedVersion).toBe(target.publication.expectedVersion);
  expect(refreshed.publication.expectedSourceHash).not.toBe(target.publication.expectedSourceHash);
  receipt.checks.push('Origin-only CAS drift blocks stale admission without native/receipt mutation');
 });

 it.each(['archived','forked-source','missing-receipt','inactive-receipt','receipt-hash-mismatch','receipt-version-mismatch'] as const)('Fails closed for %s and leaves all stored rows unchanged',async failure=>{
  const {card,sourceId}=await seed();let requestedSource=sourceId;
  if(failure==='archived')await pool.query('UPDATE ai_plugins SET archived_at=now() WHERE id=$1',[card.id]);
  if(failure==='forked-source')requestedSource='different-source-'+randomUUID();
  if(failure==='missing-receipt')await pool.query('DELETE FROM asset_source_receipts WHERE external_id=$1',[sourceId]);
  if(failure==='inactive-receipt')await pool.query('UPDATE asset_source_receipts SET active=false WHERE external_id=$1',[sourceId]);
  if(failure==='receipt-hash-mismatch')await pool.query('UPDATE asset_source_receipts SET native_hash=$2 WHERE external_id=$1',[sourceId,'e'.repeat(64)]);
  if(failure==='receipt-version-mismatch')await pool.query('UPDATE asset_source_receipts SET native_version=native_version+1 WHERE external_id=$1',[sourceId]);
  const before=await snapshot(card);
  await expect(managedRebuildPublication(pool,'mcp',card.id,requestedSource)).rejects.toMatchObject({status:409});
  expect(await snapshot(card)).toEqual(before);
  receipt.checks.push('Fail closed without writes: '+failure);
 });

 it('Does not treat a missing card or another native kind as an approved replacement',async()=>{
  const {card,sourceId}=await seed(),before=await snapshot(card);
  await expect(managedRebuildPublication(pool,'mcp','ai-plug-'+randomUUID(),sourceId)).rejects.toMatchObject({status:404});
  await expect(managedRebuildPublication(pool,'plugin',card.id,sourceId)).rejects.toMatchObject({status:404});
  expect(await snapshot(card)).toEqual(before);
  receipt.checks.push('Missing card and wrong-kind replacement fail closed');
 });
});
