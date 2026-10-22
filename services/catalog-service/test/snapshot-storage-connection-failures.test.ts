import {afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {Client} from 'minio';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {SnapshotStorage} from '../src/snapshots/snapshot-storage';
import {snapshotS3FixtureConfiguration} from './snapshot-s3.fixture';

const connection=process.env.TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL,configFile=process.env.SNAPSHOT_TEST_S3_CONFIG||process.env.MODEL_CHAT_TEST_STORAGE_CONFIG;
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex'),cleanups:Array<()=>Promise<void>>=[];
let s3:ReturnType<typeof snapshotS3FixtureConfiguration>,objects:Client;
/** Explicit caller-owned PostgreSQL/S3 fixtures; a second connection observes the actual server fence. */
describe.skipIf(!connection||!configFile).sequential('Snapshot uncertain-unlock connection disposition',()=>{
 beforeAll(async()=>{const url=new URL(connection!);if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||!url.port||url.port==='5432')throw new Error('Explicit owned 127.0.0.1 PostgreSQL port is required; main5432 is forbidden.');s3=snapshotS3FixtureConfiguration(JSON.parse(await readFile(configFile!,'utf8')));objects=new Client({endPoint:new URL(s3.endpoint).hostname,port:s3.port,useSSL:false,accessKey:s3.accessKey,secretKey:s3.secretKey,region:s3.region,retryOptions:{disableRetry:true}});});
 afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanups.splice(0).reverse())await close();});
 async function fixture(){
  const database='nc_snapshot_unlock_'+randomUUID().replaceAll('-',''),bucket='nc-snapshot-unlock-'+randomUUID().replaceAll('-','');const url=new URL(connection!);url.pathname='/postgres';const admin=new Pool({connectionString:url.href,max:1});await admin.query('CREATE DATABASE '+database);url.pathname='/'+database;
  const pool=new Pool({connectionString:url.href,max:1}),observer=new Pool({connectionString:url.href,max:1});cleanups.push(async()=>{await observer.end();await pool.end();await admin.query('DROP DATABASE '+database);await admin.end();});await ensureCatalogSchema(pool);await objects.makeBucket(bucket,s3.region);await objects.setBucketVersioning(bucket,{Status:'Enabled'});cleanups.push(async()=>{for await(const row of objects.listObjects(bucket,'',true,{IncludeVersion:true}))if(row.name)await objects.removeObject(bucket,row.name,{versionId:row.versionId});await objects.removeBucket(bucket);});
  const storage=new SnapshotStorage(pool,{s3:{...s3,bucket}}),project='unlock-project-'+randomUUID(),bytes=Buffer.from('committed snapshot '+randomUUID()),sha=digest(bytes),key='projects/'+digest(project)+'/blobs/'+sha;
  const state=async()=>({blobs:(await pool.query('SELECT * FROM project_snapshot_blobs')).rows,writes:(await pool.query('SELECT * FROM project_snapshot_blob_writes')).rows});
  const unlocked=async()=>{for(let index=0;index<20;index++){const acquired=(await observer.query("SELECT pg_try_advisory_lock(hashtextextended('neurocenter:snapshot-storage',0)) AS locked")).rows[0].locked;if(acquired){await observer.query("SELECT pg_advisory_unlock(hashtextextended('neurocenter:snapshot-storage',0))");return true;}await new Promise(resolve=>setTimeout(resolve,10));}return false;};
  const intent=()=>pool.query('INSERT INTO project_snapshot_blob_writes(project_id,sha256,write_id,bytes,storage_id) VALUES($1,$2,$3,$4,$5)',[project,sha,randomUUID(),bytes.length,storage.storageId]);
  return{pool,observer,storage,project,bytes,sha,key,bucket,state,unlocked,intent};
 }
 async function failUnlock(pool:Pool){
  const connect=pool.connect.bind(pool);let oldPid=0,attempts=0;
  vi.spyOn(pool,'connect').mockImplementationOnce(async()=>{
   const client=await connect(),query=client.query.bind(client);oldPid=(await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const dispatch=async(text:string,...args:unknown[])=>{if(text.includes('pg_advisory_unlock(')){attempts++;throw Object.assign(new Error('own simulated unlock response loss'),{code:'ECONNRESET'});}return (query as (...input:unknown[])=>Promise<unknown>)(text,...args);};
   client.query=dispatch as PoolClient['query'];return client;
  });return{pid:()=>oldPid,attempts:()=>attempts};
 }
 async function failRollbackAfterExecutedInsert(pool:Pool){
  const connect=pool.connect.bind(pool),error=Object.assign(new Error('own INSERT acknowledgement lost'),{code:'OWN_ACK_LOST'});let oldPid=0,inserted=false;
  vi.spyOn(pool,'connect').mockImplementationOnce(async()=>{const client=await connect(),query=client.query.bind(client);oldPid=(await query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const dispatch=async(text:string,...args:unknown[])=>{if(text.startsWith('INSERT INTO project_snapshot_blobs')&&!inserted){await (query as (...input:unknown[])=>Promise<unknown>)(text,...args);inserted=true;throw error;}if(text==='ROLLBACK')throw new Error('own rollback not confirmed');return (query as (...input:unknown[])=>Promise<unknown>)(text,...args);};client.query=dispatch as PoolClient['query'];return client;
  });return{error,pid:()=>oldPid};
 }
 it('discards a recovery session when a successful acquisition reply was lost',async()=>{
  const f=await fixture(),connect=f.pool.connect.bind(f.pool),failure=new Error('own recovery acquisition acknowledgement lost');
  vi.spyOn(f.pool,'connect').mockImplementationOnce(async()=>{const client=await connect(),query=client.query.bind(client);const dispatch=async(text:string,...args:unknown[])=>{const result=await (query as (...input:unknown[])=>Promise<unknown>)(text,...args);if(text.includes('pg_try_advisory_lock'))throw failure;return result;};client.query=dispatch as PoolClient['query'];return client;});
  await expect(f.storage.recoverWrite()).rejects.toBe(failure);expect(await f.unlocked()).toBe(true);expect(await f.state()).toEqual({blobs:[],writes:[]});
 });
 it('reuses a healthy session after a confirmed try-lock contention result',async()=>{
  const f=await fixture(),external=await f.observer.connect(),pid=(await f.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  try{await external.query("SELECT pg_advisory_lock(hashtextextended('neurocenter:snapshot-storage',0))");expect(await f.storage.recoverWrite()).toBe(false);expect((await f.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(pid);}
  finally{await external.query("SELECT pg_advisory_unlock(hashtextextended('neurocenter:snapshot-storage',0))");external.release();}
 });
 it('never reuses an idle-in-transaction session after an INSERT acknowledgement and ROLLBACK were both lost',async()=>{
  const f=await fixture(),fault=await failRollbackAfterExecutedInsert(f.pool);await expect(f.storage.put(f.project,f.sha,f.bytes)).rejects.toBe(fault.error);
  expect((await f.observer.query('SELECT * FROM project_snapshot_blobs')).rows).toEqual([]);expect((await f.observer.query('SELECT * FROM project_snapshot_blob_writes')).rows).toHaveLength(1);
  expect((await f.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).not.toBe(fault.pid());
  await f.storage.put(f.project,f.sha,f.bytes);expect((await f.observer.query('SELECT * FROM project_snapshot_blobs')).rows).toHaveLength(1);expect((await f.observer.query('SELECT * FROM project_snapshot_blob_writes')).rows).toEqual([]);expect(await f.storage.read(f.project,f.sha)).toEqual(f.bytes);
 });
 it('keeps a successful committed PUT but drops the session when its unlock acknowledgement is lost',async()=>{
  const f=await fixture(),fault=await failUnlock(f.pool);await expect(f.storage.put(f.project,f.sha,f.bytes)).resolves.toBeUndefined();expect(fault.attempts()).toBe(1);
  expect((await f.state()).blobs).toHaveLength(1);expect((await f.state()).writes).toEqual([]);expect(await f.storage.read(f.project,f.sha)).toEqual(f.bytes);
  expect(await f.unlocked()).toBe(true);expect((await f.pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).not.toBe(fault.pid());
 });
 it('preserves the original registration failure and durable PUT intent while discarding its locked session',async()=>{
  const f=await fixture();await f.pool.query('ALTER TABLE project_snapshot_blobs ADD CONSTRAINT own_reject_write CHECK(false)');const fault=await failUnlock(f.pool);
  await expect(f.storage.put(f.project,f.sha,f.bytes)).rejects.toMatchObject({code:'23514'});expect(fault.attempts()).toBe(1);expect((await f.state()).blobs).toEqual([]);expect((await f.state()).writes).toHaveLength(1);expect(await f.unlocked()).toBe(true);
  await f.pool.query('ALTER TABLE project_snapshot_blobs DROP CONSTRAINT own_reject_write');expect(await f.storage.recoverWrite()).toBe(true);expect(await f.storage.read(f.project,f.sha)).toEqual(f.bytes);const versions=[];for await(const row of objects.listObjects(f.bucket,f.key,true,{IncludeVersion:true}))versions.push(row);expect(versions).toHaveLength(1);
 });
 it('keeps successful recovery after an unlock failure and releases its server advisory fence',async()=>{
  const f=await fixture();await f.intent();const fault=await failUnlock(f.pool);expect(await f.storage.recoverWrite()).toBe(true);expect(fault.attempts()).toBe(1);expect(await f.state()).toEqual({blobs:[],writes:[]});expect(await f.unlocked()).toBe(true);
 });
 it('does not mask the original recovery error or delete an intent when unlock also fails',async()=>{
  const f=await fixture();await f.intent();await f.pool.query("UPDATE project_snapshot_blob_writes SET storage_id='s3:'||repeat('f',32)");const before=await f.state(),fault=await failUnlock(f.pool);
  await expect(f.storage.recoverWrite()).rejects.toMatchObject({status:409});expect(fault.attempts()).toBe(1);expect(await f.state()).toEqual(before);expect(await f.unlocked()).toBe(true);
 });
});
