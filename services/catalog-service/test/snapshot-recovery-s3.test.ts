import {afterEach,beforeAll,describe,expect,it} from 'vitest';
import {readFile,writeFile,mkdir,mkdtemp,rm,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {Client} from 'minio';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {SnapshotStorage} from '../src/snapshots/snapshot-storage';
// @ts-expect-error The operator recovery module is plain ESM and intentionally has no generated declaration.
import {exportSnapshotRecovery,restoreSnapshotRecovery,snapshotRecoveryStore} from '../../../scripts/production/snapshot-recovery-storage.mjs';

const storageFile=process.env.SNAPSHOT_TEST_S3_CONFIG||process.env.MODEL_CHAT_TEST_STORAGE_CONFIG,adminUrl=process.env.SNAPSHOT_TEST_ADMIN_PG_URL||process.env.TEST_ADMIN_PG_URL;
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex'),cleanup:Array<()=>Promise<void>>=[];
let config:{endpoint:string;region:string;accessKey:string;secretKey:string},client:Client;
/** Actual S3 SDK, exact older versions, own SQL CAS and operator files; no Compose/target-server acceptance is claimed. */
describe.skipIf(!storageFile||!adminUrl).sequential('Snapshot recovery exact private S3 → bundle → target contract',()=>{
 beforeAll(async()=>{const raw=JSON.parse(await readFile(storageFile!,'utf8')),url=new URL(raw.CHAT_S3_ENDPOINT),pg=new URL(adminUrl!);
  if(url.hostname!=='127.0.0.1'||url.port!=='59617'||pg.hostname!=='127.0.0.1'||pg.port!=='59616')throw new Error('Only own S359617/PostgreSQL59616 fixtures are allowed.');
  config={endpoint:url.origin,region:raw.CHAT_S3_REGION||'us-east-1',accessKey:raw.CHAT_S3_ACCESS_KEY,secretKey:raw.CHAT_S3_SECRET_KEY};client=snapshotRecoveryStore(config);
 });
 afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
 async function fixture(){
  const database='nc_snapshot_recovery_'+randomUUID().replaceAll('-',''),bucket='nc-recovery-source-'+randomUUID().replaceAll('-',''),targetBucket='nc-recovery-target-'+randomUUID().replaceAll('-','');
  const url=new URL(adminUrl!);url.pathname='/postgres';const admin=new Pool({connectionString:url.href,max:1});await admin.query('CREATE DATABASE '+database);url.pathname='/'+database;const pool=new Pool({connectionString:url.href,max:3});cleanup.push(async()=>{await pool.end();await admin.query('DROP DATABASE '+database);await admin.end();});await ensureCatalogSchema(pool);
  const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'nc-snapshot-recovery-contract-')));cleanup.push(()=>rm(directory,{recursive:true,force:true}));const destination=path.join(directory,'bundle');await mkdir(destination,{mode:0o700});
  await client.makeBucket(bucket,config.region);await client.setBucketVersioning(bucket,{Status:'Enabled'});
  cleanup.push(async()=>{for(const name of [targetBucket,bucket])if(await client.bucketExists(name)){for await(const row of client.listObjects(name,'',true,{IncludeVersion:true}))if(row.name)await client.removeObject(name,row.name,{versionId:row.versionId});await client.removeBucket(name);}});
  await writeFile(path.join(directory,'access'),config.accessKey,{mode:0o600});await writeFile(path.join(directory,'secret'),config.secretKey,{mode:0o600});
  await writeFile(path.join(directory,'snapshot-recovery.json'),JSON.stringify({source:{endpoint:config.endpoint,bucket,region:config.region,accessKeyFile:'access',secretKeyFile:'secret'}}),{mode:0o600});
  const storage=new SnapshotStorage(pool,{s3:{...config,bucket}}),project='snapshot-recovery-'+randomUUID(),bytes=Buffer.from('exact pinned recovery bytes '+randomUUID()),sha256=hash(bytes),key='projects/'+hash(project)+'/blobs/'+sha256;
  await storage.put(project,sha256,bytes);const before=(await pool.query('SELECT * FROM project_snapshot_blobs')).rows;
  const sql=async(_database:string,text:string)=>{const result=await pool.query(text),last=Array.isArray(result)?result.at(-1)!:result;return last.rows.map((row:Record<string,unknown>)=>{const value=Object.values(row)[0];return typeof value==='boolean'?value?'t':'f':typeof value==='object'?JSON.stringify(value):String(value);}).join('\n');};
  const target={...config,bucket:targetBucket,storageId:'s3:'+hash(JSON.stringify([config.endpoint,targetBucket])).slice(0,32)};
  const policy=(name:string)=>JSON.stringify({Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:'*',Action:['s3:GetObject'],Resource:['arn:aws:s3:::'+name+'/*']}]});
  const versions=async(name=bucket)=>{const items=[];for await(const row of client.listObjects(name,'',true,{IncludeVersion:true}))items.push({name:row.name,versionId:row.versionId});return items;};
  return{pool,bucket,targetBucket,directory,destination,storage,project,bytes,sha256,key,before,sql,target,policy,versions};
 }
 it('exports the pinned older version and verifies a distinct target version before exact SQL remapping',async()=>{
  const f=await fixture();await client.putObject(f.bucket,f.key,Buffer.from('foreign newest bytes'),20);const original=await f.versions();expect(original).toHaveLength(2);
  const exported=await exportSnapshotRecovery({directory:f.directory,destination:f.destination,sql:f.sql});expect(exported.blobs).toHaveLength(1);expect(exported.blobs[0].versionId).toBe(f.before[0].version_id);expect(await readFile(path.join(f.destination,exported.blobs[0].file))).toEqual(f.bytes);
  const restored=await restoreSnapshotRecovery({source:f.destination,preview:{configuration:{target:f.target},blobs:exported.blobs},sql:f.sql});expect(restored.objects).toBe(1);
  const current=(await f.pool.query('SELECT * FROM project_snapshot_blobs')).rows[0];expect(current.storage_id).toBe(f.target.storageId);expect(current.version_id).not.toBe(f.before[0].version_id);
  const stream=await client.getObject(f.targetBucket,f.key,{versionId:current.version_id}),parts=[];for await(const part of stream)parts.push(Buffer.from(part));expect(Buffer.concat(parts)).toEqual(f.bytes);expect(await f.versions()).toEqual(original);
 });
 it('public source is refused before exporting object bytes and leaves source metadata/version inventory unchanged',async()=>{
  const f=await fixture(),before=await f.versions();await client.setBucketPolicy(f.bucket,f.policy(f.bucket));
  await expect(exportSnapshotRecovery({directory:f.directory,destination:f.destination,sql:f.sql})).rejects.toThrow('S3_BUCKET_PRIVACY_UNCONFIRMED');
  expect(await readdir(f.destination)).toEqual([]);expect((await f.pool.query('SELECT * FROM project_snapshot_blobs')).rows).toEqual(f.before);expect(await f.versions()).toEqual(before);
 });
 it('a target made public during setup never receives snapshot bytes or mutates SQL',async()=>{
  const f=await fixture(),exported=await exportSnapshotRecovery({directory:f.directory,destination:f.destination,sql:f.sql});let writes=0;
  const storeFactory=(target:typeof f.target)=>{const store=snapshotRecoveryStore(target),make=store.makeBucket.bind(store),put=store.putObject.bind(store);store.makeBucket=async(...args:unknown[])=>{await make(...args);await store.setBucketPolicy(target.bucket,f.policy(target.bucket));};store.putObject=async(...args:unknown[])=>{writes++;return put(...args);};return store;};
  await expect(restoreSnapshotRecovery({source:f.destination,preview:{configuration:{target:f.target},blobs:exported.blobs},sql:f.sql,storeFactory})).rejects.toThrow('S3_BUCKET_PRIVACY_UNCONFIRMED');
  expect(writes).toBe(0);expect(await f.versions(f.targetBucket)).toEqual([]);expect((await f.pool.query('SELECT * FROM project_snapshot_blobs')).rows).toEqual(f.before);
 });
 it('a target policy changed at final admission cannot publish a successful SQL mapping',async()=>{
  const f=await fixture(),exported=await exportSnapshotRecovery({directory:f.directory,destination:f.destination,sql:f.sql});let calls=0;
  await expect(restoreSnapshotRecovery({source:f.destination,preview:{configuration:{target:f.target},blobs:exported.blobs},sql:f.sql,beforeMutation:async()=>{if(++calls===4)await client.setBucketPolicy(f.targetBucket,f.policy(f.targetBucket));}})).rejects.toThrow('S3_BUCKET_PRIVACY_UNCONFIRMED');
  expect((await f.pool.query('SELECT * FROM project_snapshot_blobs')).rows).toEqual(f.before);expect(await f.versions()).toHaveLength(1);expect(await f.versions(f.targetBucket)).toHaveLength(1);
 });
 it('a changed SQL pin after upload rolls back remapping and retains source plus unclaimed target for operator recovery',async()=>{
  const f=await fixture(),exported=await exportSnapshotRecovery({directory:f.directory,destination:f.destination,sql:f.sql});let calls=0;
  await expect(restoreSnapshotRecovery({source:f.destination,preview:{configuration:{target:f.target},blobs:exported.blobs},sql:f.sql,beforeMutation:async()=>{if(++calls===4)await f.pool.query("UPDATE project_snapshot_blobs SET storage_id='fs:'||repeat('a',32),version_id=NULL");}})).rejects.toBeTruthy();
  expect((await f.pool.query('SELECT storage_id,version_id FROM project_snapshot_blobs')).rows).toEqual([{storage_id:'fs:'+'a'.repeat(32),version_id:null}]);expect(await f.versions()).toHaveLength(1);expect(await f.versions(f.targetBucket)).toHaveLength(1);
 });
});
