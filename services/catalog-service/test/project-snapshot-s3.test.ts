import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {Pool} from 'pg';
import {Client} from 'minio';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,statfs} from 'node:fs/promises';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {SnapshotStorage} from '../src/snapshots/snapshot-storage';
import {snapshotS3FixtureConfiguration} from './snapshot-s3.fixture';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const execute=promisify(execFile),nonce=randomUUID().replaceAll('-',''),container='nc-snapshot-storage-test-'+nonce.slice(0,16);
const adminConnection=process.env.TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL,storageFile=process.env.SNAPSHOT_TEST_S3_CONFIG||process.env.MODEL_CHAT_TEST_STORAGE_CONFIG,spawnDocker=process.env.SNAPSHOT_S3_TEST_SPAWN_DOCKER==='1',enabled=!!adminConnection&&!!(storageFile||spawnDocker);
let access='storage'+nonce.slice(0,16),secret=randomUUID()+randomUUID(),region='us-east-1';
let started=false,client:Client,endpoint:string,admin:Pool;const cleanup:Array<()=>Promise<void>>=[];
async function docker(args:string[]){try{return(await execute('docker',args,{timeout:60000,maxBuffer:1024*1024})).stdout.trim();}catch{throw new Error('Изолированный MinIO: Docker '+args[0]+' не завершён.');}}
const key=(project:string,sha:string)=>'projects/'+hash(project)+'/blobs/'+sha;
async function versions(bucket:string,object?:string){const rows:Array<{name?:string;versionId?:string;isDeleteMarker?:boolean}>=[];for await(const item of client.listObjects(bucket,object||'',true,{IncludeVersion:true}))rows.push(item);return rows.filter(row=>!object||row.name===object);}
beforeAll(async()=>{
 if(!enabled)return;
 const url=new URL(adminConnection!);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!url.port||url.port==='5432')throw new Error('Explicit owned localhost PostgreSQL port is required; main5432 is forbidden.');url.pathname='/postgres';admin=new Pool({connectionString:url.href,max:2});
 let port:number;
 if(storageFile){
  const target=snapshotS3FixtureConfiguration(JSON.parse(await readFile(storageFile,'utf8')));
  endpoint=target.endpoint;port=target.port;access=target.accessKey;secret=target.secretKey;region=target.region;
 }else{
  const disk=await statfs(process.cwd(),{bigint:true});if(disk.bavail*disk.bsize<8n*1024n**3n)throw new Error('Explicit Docker S3 spawn requires8GiB free disk.');
  await docker(['run','--detach','--rm','--name',container,'--publish','127.0.0.1::9000','--env','MINIO_ROOT_USER='+access,'--env','MINIO_ROOT_PASSWORD='+secret,'quay.io/minio/minio:RELEASE.2025-07-23T15-54-02Z','server','/data']);started=true;
  const record=JSON.parse(await docker(['inspect',container]))[0];port=Number(record.NetworkSettings.Ports['9000/tcp'][0].HostPort);endpoint='http://127.0.0.1:'+port;
 }
 for(let attempt=0;;attempt++){try{if((await fetch(endpoint+'/minio/health/ready',{signal:AbortSignal.timeout(1000)})).ok)break;}catch{}if(attempt>=30)throw new Error('Own MinIO did not become ready.');await new Promise(resolve=>setTimeout(resolve,100));}
 client=new Client({endPoint:new URL(endpoint).hostname,port,useSSL:new URL(endpoint).protocol==='https:',accessKey:access,secretKey:secret,region,retryOptions:{disableRetry:true}});
},60000);
afterEach(async()=>{vi.unstubAllEnvs();for(const action of cleanup.splice(0).reverse())await action();});
afterAll(async()=>{try{await admin?.end();}finally{if(started)await docker(['rm','--force','--volumes',container]);}});
async function fixture({versioning=true}={}){
 const database='nc_snapshot_s3_'+randomUUID().replaceAll('-',''),bucket='snapshot-'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+database);
 const url=new URL(adminConnection!);url.pathname='/'+database;
 const pool=new Pool({connectionString:url.href,max:4});cleanup.push(async()=>{await pool.end();await admin.query('DROP DATABASE '+database);});await ensureCatalogSchema(pool);
 await client.makeBucket(bucket,region);cleanup.push(async()=>{for await(const row of client.listObjects(bucket,'',true,{IncludeVersion:true})){if(row.name)await client.removeObject(bucket,row.name,{versionId:row.versionId});}await client.removeBucket(bucket);});if(versioning)await client.setBucketVersioning(bucket,{Status:'Enabled'});
 const s3={endpoint,bucket,region,accessKey:access,secretKey:secret},storage=new SnapshotStorage(pool,{s3}),project='own-project-'+randomUUID(),payload=Buffer.from('complete snapshot bytes '+randomUUID()),sha=hash(payload),object=key(project,sha);
 const row=async()=>(await pool.query('SELECT * FROM project_snapshot_blobs WHERE project_id=$1 AND sha256=$2',[project,sha])).rows[0];
 const intent=async()=>(await pool.query('SELECT * FROM project_snapshot_blob_writes WHERE project_id=$1 AND sha256=$2',[project,sha])).rows[0];
 const failRegistration=()=>pool.query("ALTER TABLE project_snapshot_blobs ADD CONSTRAINT own_reject_registration CHECK(project_id<> '"+project+"')");
 return{pool,bucket,s3,storage,project,payload,sha,object,row,intent,failRegistration};
}
describe.skipIf(!enabled)('SnapshotStorage — actual versioned MinIO and PostgreSQL write-intent durability',()=>{
 it('publishes LIVE metadata only after real PUT, pins nonce/version and reads the older version after a foreign latest write',async()=>{
  const f=await fixture();await f.storage.put(f.project,f.sha,f.payload);const row=await f.row();expect(row).toMatchObject({bytes:String(f.payload.length),storage_id:f.storage.storageId,state:'LIVE'});expect(row.version_id).toBeTruthy();expect(await f.intent()).toBeUndefined();
  const stat=await client.statObject(f.bucket,f.object,{versionId:row.version_id});expect(stat.metaData['neurocenter-snapshot-write']).toMatch(/^[a-f0-9-]{36}$/);expect(await f.storage.read(f.project,f.sha)).toEqual(f.payload);
  await client.putObject(f.bucket,f.object,Buffer.from('unrelated newest bytes'),22,{'X-Amz-Meta-Neurocenter-Snapshot-Write':randomUUID()});expect(await f.storage.read(f.project,f.sha)).toEqual(f.payload);await f.storage.put(f.project,f.sha,f.payload);expect(await versions(f.bucket,f.object)).toHaveLength(2);
 });
 it('accounts a real PUT when the subsequent PG insert fails; retry adopts the same nonce/version without another PUT',async()=>{
  const f=await fixture();await f.failRegistration();await expect(f.storage.put(f.project,f.sha,f.payload)).rejects.toBeTruthy();expect(await f.row()).toBeUndefined();const intent=await f.intent();expect(intent.storage_id).toBe(f.storage.storageId);expect(await versions(f.bucket,f.object)).toHaveLength(1);await expect(f.storage.read(f.project,f.sha)).rejects.toMatchObject({status:503});
  const original=(await versions(f.bucket,f.object))[0].versionId;expect((await client.statObject(f.bucket,f.object,{versionId:original})).metaData['neurocenter-snapshot-write']).toBe(intent.write_id);await f.pool.query('ALTER TABLE project_snapshot_blobs DROP CONSTRAINT own_reject_registration');await f.storage.put(f.project,f.sha,f.payload);expect((await f.row()).version_id).toBe(original);expect(await versions(f.bucket,f.object)).toHaveLength(1);expect(await f.intent()).toBeUndefined();expect(await f.storage.read(f.project,f.sha)).toEqual(f.payload);
 });
 it('recoverWrite removes at most one excess matching-nonce version per tick and preserves a foreign-nonce version',async()=>{
  const f=await fixture();await f.failRegistration();await expect(f.storage.put(f.project,f.sha,f.payload)).rejects.toBeTruthy();const intent=await f.intent();
  for(let index=0;index<3;index++)await client.putObject(f.bucket,f.object,f.payload,f.payload.length,{'X-Amz-Meta-Neurocenter-Snapshot-Write':intent.write_id});
  const foreign=(await client.putObject(f.bucket,f.object,Buffer.from('foreign'),7,{'X-Amz-Meta-Neurocenter-Snapshot-Write':randomUUID()})).versionId;await f.pool.query('ALTER TABLE project_snapshot_blobs DROP CONSTRAINT own_reject_registration');expect(await versions(f.bucket,f.object)).toHaveLength(5);
  for(let count=4;count>=2;count--){expect(await f.storage.recoverWrite()).toBe(true);expect(await versions(f.bucket,f.object)).toHaveLength(count);if(count>2){expect(await f.row()).toBeUndefined();expect(await f.intent()).toBeTruthy();}}
  expect(await f.intent()).toBeUndefined();expect((await f.row()).state).toBe('LIVE');expect((await versions(f.bucket,f.object)).map(row=>row.versionId)).toContain(foreign);expect(await f.storage.read(f.project,f.sha)).toEqual(f.payload);expect(await f.storage.recoverWrite()).toBe(false);
 });
 it('disabled versioning leaves an accounted empty intent that recovery removes before a later valid retry',async()=>{
  const f=await fixture({versioning:false});await expect(f.storage.put(f.project,f.sha,f.payload)).rejects.toMatchObject({status:503});expect(await f.intent()).toBeTruthy();expect(await f.row()).toBeUndefined();expect(await versions(f.bucket)).toHaveLength(0);expect(await f.storage.recoverWrite()).toBe(true);expect(await f.intent()).toBeUndefined();await client.setBucketVersioning(f.bucket,{Status:'Enabled'});await f.storage.put(f.project,f.sha,f.payload);expect(await f.storage.read(f.project,f.sha)).toEqual(f.payload);
 });
 it('bad SHA, quota overflow and cross-project/wrong-storage reads fail without publishing or disclosing bytes',async()=>{
  const f=await fixture();await expect(f.storage.put(f.project,f.sha,Buffer.from('wrong'))).rejects.toMatchObject({status:409});expect(await f.intent()).toBeUndefined();expect(await versions(f.bucket)).toHaveLength(0);
  vi.stubEnv('SNAPSHOT_STORAGE_MAX_BYTES','1');await expect(f.storage.put(f.project,f.sha,f.payload)).rejects.toMatchObject({status:409});expect(await f.intent()).toBeUndefined();vi.unstubAllEnvs();await f.storage.put(f.project,f.sha,f.payload);
  await expect(f.storage.read('another-project',f.sha)).rejects.toMatchObject({status:503});const other=new SnapshotStorage(f.pool,{s3:{...f.s3,bucket:'other-'+randomUUID().replaceAll('-','')}});await expect(other.read(f.project,f.sha)).rejects.toMatchObject({status:503});await expect(other.put(f.project,f.sha,f.payload)).rejects.toMatchObject({status:409});
 });
 it('tampering with the pinned bytes or marking a blob DELETING cannot be read as LIVE',async()=>{
  const f=await fixture();await f.storage.put(f.project,f.sha,f.payload);const original=await f.row(),bad=(await client.putObject(f.bucket,f.object,Buffer.alloc(f.payload.length,0),f.payload.length)).versionId;await f.pool.query('UPDATE project_snapshot_blobs SET version_id=$1',[bad]);await expect(f.storage.read(f.project,f.sha)).rejects.toMatchObject({status:409});await f.pool.query("UPDATE project_snapshot_blobs SET version_id=$1,state='DELETING'",[original.version_id]);await expect(f.storage.read(f.project,f.sha)).rejects.toMatchObject({status:503});await expect(f.storage.put(f.project,f.sha,f.payload)).rejects.toMatchObject({status:409});
 });
 it('an unsettled intent from another storage identity is retained and never adopted or deleted',async()=>{
  const f=await fixture();await f.failRegistration();await expect(f.storage.put(f.project,f.sha,f.payload)).rejects.toBeTruthy();const before=await versions(f.bucket,f.object);await f.pool.query("UPDATE project_snapshot_blob_writes SET storage_id='s3:'||repeat('0',32)");await expect(f.storage.recoverWrite()).rejects.toMatchObject({status:409});await expect(f.storage.put(f.project,f.sha,f.payload)).rejects.toMatchObject({status:409});expect(await f.intent()).toBeTruthy();expect(await f.row()).toBeUndefined();expect(await versions(f.bucket,f.object)).toEqual(before);
 });
 it('corrupt matching-nonce bytes prevent recovery and retain the durable accounting record',async()=>{
  const f=await fixture();await f.failRegistration();await expect(f.storage.put(f.project,f.sha,f.payload)).rejects.toBeTruthy();const intent=await f.intent();await client.putObject(f.bucket,f.object,Buffer.alloc(f.payload.length,0),f.payload.length,{'X-Amz-Meta-Neurocenter-Snapshot-Write':intent.write_id});await f.pool.query('ALTER TABLE project_snapshot_blobs DROP CONSTRAINT own_reject_registration');await expect(f.storage.recoverWrite()).rejects.toMatchObject({status:409});expect(await f.intent()).toBeTruthy();expect(await f.row()).toBeUndefined();expect(await versions(f.bucket,f.object)).toHaveLength(2);
 });
});
