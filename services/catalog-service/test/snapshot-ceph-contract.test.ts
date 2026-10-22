import {afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {Client} from 'minio';
import {Pool} from 'pg';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {SnapshotStorage} from '../src/snapshots/snapshot-storage';

const storageFile=process.env.SNAPSHOT_TEST_S3_CONFIG||process.env.MODEL_CHAT_TEST_STORAGE_CONFIG;
const adminUrl=process.env.SNAPSHOT_TEST_ADMIN_PG_URL||process.env.TEST_ADMIN_PG_URL;
const cleanup:Array<()=>Promise<void>>=[];
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
let config:{endpoint:string;region:string;accessKey:string;secretKey:string},client:Client;
/** Real SDK and own PostgreSQL only; these cases never fall back to main ports or reuse application buckets. */
describe.skipIf(!storageFile||!adminUrl).sequential('Snapshot Ceph/S3 privacy and exact-version contract',()=>{
 beforeAll(async()=>{
  const raw=JSON.parse(await readFile(storageFile!,'utf8')) as Record<string,string>,url=new URL(raw.CHAT_S3_ENDPOINT);
  const pg=new URL(adminUrl!);
  if(!['localhost','127.0.0.1','[::1]'].includes(pg.hostname)||pg.port!=='59616')throw new Error('Explicit owned QA PostgreSQL59616 is required.');
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='59617')throw new Error('Explicit owned QA S3 endpoint59617 is required.');
  config={endpoint:url.origin,region:raw.CHAT_S3_REGION||'us-east-1',accessKey:raw.CHAT_S3_ACCESS_KEY,secretKey:raw.CHAT_S3_SECRET_KEY};
  client=new Client({endPoint:url.hostname,port:Number(url.port),useSSL:url.protocol==='https:',accessKey:config.accessKey,secretKey:config.secretKey,region:config.region,pathStyle:true,retryOptions:{disableRetry:true}});
 });
 afterEach(async()=>{vi.unstubAllEnvs();for(const action of cleanup.splice(0).reverse())await action();});
 async function fixture(){
  const database='nc_snapshot_contract_'+randomUUID().replaceAll('-',''),bucket='nc-snapshot-'+randomUUID().replaceAll('-','');
  const url=new URL(adminUrl!);url.pathname='/postgres';const admin=new Pool({connectionString:url.href,max:1});await admin.query('CREATE DATABASE '+database);
  url.pathname='/'+database;const pool=new Pool({connectionString:url.href,max:3});cleanup.push(async()=>{await pool.end();await admin.query('DROP DATABASE '+database);await admin.end();});
  await ensureCatalogSchema(pool);await client.makeBucket(bucket,config.region);
  cleanup.push(async()=>{for await(const item of client.listObjects(bucket,'',true,{IncludeVersion:true})){if(item.name)await client.removeObject(bucket,item.name,{versionId:item.versionId});}await client.removeBucket(bucket);});
  await client.setBucketVersioning(bucket,{Status:'Enabled'});
  const storage=new SnapshotStorage(pool,{s3:{...config,bucket}}),project='snapshot-contract-'+randomUUID(),bytes=Buffer.from('private snapshot '+randomUUID()),digest=sha(bytes),key='projects/'+sha(project)+'/blobs/'+digest;
  const rows=async()=>({blobs:(await pool.query('SELECT * FROM project_snapshot_blobs')).rows,writes:(await pool.query('SELECT * FROM project_snapshot_blob_writes')).rows});
  const policy=JSON.stringify({Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:'*',Action:['s3:GetObject'],Resource:['arn:aws:s3:::'+bucket+'/*']}]});
  return{database,bucket,pool,storage,project,bytes,digest,key,rows,policy};
 }
 it('refuses a real anonymously-readable bucket before writing any object or durable write intent',async()=>{
  const f=await fixture();await client.setBucketPolicy(f.bucket,f.policy);
  await expect(f.storage.put(f.project,f.digest,f.bytes)).rejects.toMatchObject({status:503});
  expect(await f.rows()).toEqual({blobs:[],writes:[]});const versions=[];for await(const item of client.listObjects(f.bucket,'',true,{IncludeVersion:true}))versions.push(item);expect(versions).toEqual([]);
 });
 it('does not silently read latest when exact-version metadata is missing',async()=>{
  const f=await fixture();await f.storage.put(f.project,f.digest,f.bytes);await f.pool.query('UPDATE project_snapshot_blobs SET version_id=NULL');
  await expect(f.storage.read(f.project,f.digest)).rejects.toMatchObject({status:503});
 });
 it('private-policy revocation suspends durable write recovery until the operator repairs access',async()=>{
  const f=await fixture();await f.pool.query('ALTER TABLE project_snapshot_blobs ADD CONSTRAINT reject_registration CHECK(false)');await expect(f.storage.put(f.project,f.digest,f.bytes)).rejects.toBeTruthy();const pending=await f.rows();expect(pending.blobs).toEqual([]);expect(pending.writes).toHaveLength(1);await f.pool.query('ALTER TABLE project_snapshot_blobs DROP CONSTRAINT reject_registration');await client.setBucketPolicy(f.bucket,f.policy);
  await expect(f.storage.recoverWrite()).rejects.toMatchObject({status:503});expect(await f.rows()).toEqual(pending);await client.setBucketPolicy(f.bucket,'');expect(await f.storage.recoverWrite()).toBe(true);expect(await f.storage.read(f.project,f.digest)).toEqual(f.bytes);expect((await f.rows()).writes).toEqual([]);
 });
 it('exact-version removal preserves an unrelated newer version and stays idempotent',async()=>{
  const f=await fixture();await f.storage.put(f.project,f.digest,f.bytes);const row=(await f.rows()).blobs[0];const foreign=Buffer.from('unrelated-newer-version'),next=await client.putObject(f.bucket,f.key,foreign,foreign.length);expect(next.versionId).toBeTruthy();await f.pool.query("UPDATE project_snapshot_blobs SET state='DELETING'");
  await f.storage.remove(f.project,f.digest,{...row,state:'DELETING'});await expect(client.statObject(f.bucket,f.key,{versionId:row.version_id})).rejects.toBeTruthy();const read=await client.getObject(f.bucket,f.key,{versionId:next.versionId!}),parts=[];for await(const part of read)parts.push(Buffer.from(part));expect(Buffer.concat(parts)).toEqual(foreign);await f.storage.remove(f.project,f.digest,{...row,state:'DELETING'});expect((await f.rows()).blobs[0].state).toBe('DELETING');
 });
 it('rechecks bucket privacy before serving a previously private exact object version',async()=>{
  const f=await fixture();await f.storage.put(f.project,f.digest,f.bytes);const before=await f.rows();expect(before.blobs).toHaveLength(1);
  expect(await f.storage.read(f.project,f.digest)).toEqual(f.bytes);await client.setBucketPolicy(f.bucket,f.policy);
  const anonymous=await fetch(config.endpoint+'/'+f.bucket+'/'+f.key);expect(anonymous.status).toBe(200);expect(Buffer.from(await anonymous.arrayBuffer())).toEqual(f.bytes);
  await expect(f.storage.read(f.project,f.digest)).rejects.toMatchObject({status:503});expect(await f.rows()).toEqual(before);
 });
});
