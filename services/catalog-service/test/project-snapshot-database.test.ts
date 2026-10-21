import {afterEach,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {SnapshotRepository} from '../src/snapshots/snapshot-repository';
import {SnapshotStorage} from '../src/snapshots/snapshot-storage';
import {SnapshotSigner} from '../src/snapshots/snapshot-signature';
import {SnapshotCommands,snapshotSignedPayload} from '../src/snapshots/snapshot-commands';
import type {CatalogService} from '../src/catalog/catalog.service';
import {snapshotManifestHash} from '../../shared/project-snapshot.cjs';

const dispose:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const action of dispose.splice(0).reverse())await action();});
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const actor={email:'snapshot@localhost',activeRole:'Главный админ'},project='prj-snapshot-test';
const manifest=()=>({format:'neurocenter.lancedb-snapshot',schemaVersion:1,sdkVersion:'0.29.0',tables:[{name:'chunks',version:1,rows:1,schemaSha256:hash('schema')}],
    files:[{path:'chunks.lance/data/a.lance',size:3,sha256:hash('abc'),chunks:[{sha256:hash('abc'),size:3}]}]});
async function fixture(){
    const url=new URL(process.env.TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL||'postgresql://rag:rag@localhost:5432/postgres');url.pathname='/postgres';
    const admin=new Pool({connectionString:url.href,max:1}),database='nc_snapshot_'+randomUUID().replaceAll('-','');
    await admin.query('CREATE DATABASE '+database);url.pathname='/'+database;
    const pool=new Pool({connectionString:url.href,max:5}),directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc-snapshot-'));
    dispose.push(async()=>{await pool.end();await admin.query('DROP DATABASE '+database);await admin.end();await fs.rm(directory,{recursive:true,force:true});});
    await ensureCatalogSchema(pool);
    await pool.query(`INSERT INTO projects(id,name) VALUES('prj-snapshot-test','Snapshot');
      INSERT INTO platform_users(email,is_main_admin,enabled) VALUES('snapshot@localhost',true,true),('reader@localhost',false,true);
      INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES('prj-snapshot-test','reader','reader@localhost','Reader','Наблюдатель');`);
    const key=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}),keyFile=path.join(directory,'signing.pem');await fs.writeFile(keyFile,key,{mode:0o600});
    const repository=new SnapshotRepository(pool),storage=new SnapshotStorage(pool,{directory:path.join(directory,'blobs')}),signer=new SnapshotSigner(keyFile);
    const commands=new SnapshotCommands(repository,signer,{getAiPluginPackage:async()=>{throw new Error('No dependencies in this metadata fixture');}}as unknown as CatalogService);
    const input={requestKey:randomUUID(),deviceId:randomUUID(),expectedBindingId:'a'.repeat(64),expectedHeadId:null,expectedHeadRevision:0};
    await pool.query('INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash) VALUES($1,$2,$3,$4,$5,$6)',[input.deviceId,actor.email,actor.activeRole,'Snapshot fixture','a'.repeat(64),hash(randomUUID())]);
    const create=()=>repository.create(project,actor,input);
    const verified=async()=>{
        const row=await create(),value=manifest();await repository.beginManifest(project,row.id,actor,value);await storage.put(project,hash('abc'),Buffer.from('abc'));
        await repository.finishUpload(project,row.id,actor,snapshotManifestHash(value));const owner=randomUUID();await pool.query("UPDATE project_snapshots SET verifier_owner=$2,verifier_lease_until=now()+interval '2 minutes' WHERE id=$1",[row.id,owner]);
        const current=await repository.transaction(project,actor,3,client=>repository.row(client,project,row.id));
        await repository.verified(row.id,owner,await signer.signature(snapshotSignedPayload(current)));return row.id;
    };
    return {pool,directory,repository,storage,signer,commands,input,create,verified};
}
describe('full snapshot PG metadata and object integrity',()=>{
    it('deduplicates two publication tabs and rejects a reused key with changed binding',async()=>{
        const f=await fixture(),rows=await Promise.all([f.create(),f.create()]);expect(rows[0].id).toBe(rows[1].id);
        await expect(f.repository.create(project,actor,{...f.input,expectedBindingId:'b'.repeat(64)})).rejects.toMatchObject({status:409});
        expect((await f.pool.query('SELECT count(*) FROM project_snapshots')).rows[0].count).toBe('1');
    });
    it('fails closed for incomplete uploads, changed manifests, bad chunks and cross-project reads',async()=>{
        const f=await fixture(),row=await f.create(),value=manifest(),result=await f.repository.beginManifest(project,row.id,actor,value);
        expect(result.missing).toEqual([{sha256:hash('abc'),size:3}]);
        await expect(f.repository.finishUpload(project,row.id,actor,result.manifestSha256)).rejects.toMatchObject({status:409});
        await expect(f.storage.put(project,hash('abc'),Buffer.from('bad'))).rejects.toMatchObject({status:409});
        await expect(f.storage.read('another-project',hash('abc'))).rejects.toMatchObject({status:503});
        value.tables[0].version=2;await expect(f.repository.beginManifest(project,row.id,actor,value)).rejects.toMatchObject({status:409});
        expect((await f.pool.query('SELECT head_revision FROM projects')).rows[0].head_revision).toBe('0');
    });
    it('requires fresh management rights and preserves the head when verification was cancelled',async()=>{
        const f=await fixture(),row=await f.create();
        await expect(f.repository.create(project,{email:'reader@localhost',activeRole:'Наблюдатель'},{...f.input,requestKey:randomUUID()})).rejects.toMatchObject({status:403});
        await f.commands.cancel(project,row.id,actor,{requestKey:randomUUID()});
        await expect(f.commands.move(project,row.id,actor,{requestKey:randomUUID(),expectedHeadId:null,expectedHeadRevision:0},'activate')).rejects.toMatchObject({status:409});
        await f.pool.query("UPDATE platform_users SET enabled=false WHERE email='snapshot@localhost'");await expect(f.repository.list(project,actor)).rejects.toMatchObject({status:403});
    });
    it('checks stored bytes again and never follows a replaced blob link',async()=>{
        const f=await fixture(),row=await f.create();await f.repository.beginManifest(project,row.id,actor,manifest());await f.storage.put(project,hash('abc'),Buffer.from('abc'));
        const folder=path.join(f.storage.directory,hash(project)),blob=path.join(folder,hash('abc'));await fs.unlink(blob);await fs.symlink('/etc/hosts',blob);
        await expect(f.storage.read(project,hash('abc'))).rejects.toBeTruthy();
    });
    it('uses exact CAS and receipts for activation, rollback and atomic release',async()=>{
        const f=await fixture(),id=await f.verified(),key=randomUUID(),input={requestKey:key,expectedHeadId:null,expectedHeadRevision:0};
        const results=await Promise.all([f.commands.move(project,id,actor,input,'activate'),f.commands.move(project,id,actor,input,'activate')]);
        expect(results).toEqual([{headId:id,headRevision:1},{headId:id,headRevision:1}]);
        await expect(f.commands.move(project,id,actor,{...input,requestKey:randomUUID()},'rollback')).rejects.toMatchObject({status:409});
        const release=await f.commands.release(project,actor,{requestKey:randomUUID(),snapshotId:id,skillPins:[],expectedProfileId:null,expectedProfileRevision:0,moveHead:{expectedHeadId:id,expectedHeadRevision:1}});
        expect(release.profileRevision).toBe(1);expect(release.head?.headRevision).toBe(2);
        const capsule=await f.commands.capsule(project,release.profileId,actor);expect(capsule.capsule.snapshotManifestSha256).toBe(snapshotManifestHash(manifest()));
        await expect(f.commands.remove(project,id,actor,{requestKey:randomUUID(),expectedManifest:snapshotManifestHash(manifest())})).rejects.toMatchObject({status:409});
    });
    it('rolls back metadata if durable audit fails and rejects a changed signing identity',async()=>{
        const f=await fixture(),id=await f.verified();
        await f.pool.query("ALTER TABLE security_events ADD CONSTRAINT reject_move CHECK(action<>'snapshot.activate')");
        await expect(f.commands.move(project,id,actor,{requestKey:randomUUID(),expectedHeadId:null,expectedHeadRevision:0},'activate')).rejects.toBeTruthy();
        expect((await f.pool.query('SELECT head_snapshot_id,head_revision FROM projects')).rows[0]).toMatchObject({head_snapshot_id:null,head_revision:'0'});
        expect((await f.pool.query('SELECT count(*) FROM project_snapshot_commands')).rows[0].count).toBe('0');
        await f.pool.query("UPDATE project_snapshots SET signature=jsonb_set(signature,'{value}',to_jsonb('invalid'::text)) WHERE id=$1",[id]);
        await expect(f.commands.move(project,id,actor,{requestKey:randomUUID(),expectedHeadId:null,expectedHeadRevision:0},'activate')).rejects.toMatchObject({status:409});
    });
});

describe('snapshot cancellation and durable collection boundaries',()=>{
    it('cancels an unknown first POST durably, including a delayed publication and command',async()=>{
        const f=await fixture();expect(await f.repository.lookup(project,actor,f.input.requestKey)).toBeNull();
        await f.repository.cancelRequest(project,actor,f.input);await expect(f.create()).rejects.toMatchObject({status:409});
        const id=await f.repository.create(project,actor,{...f.input,requestKey:randomUUID()});
        const key=randomUUID();expect(await f.repository.lookupCommand(project,actor,key)).toBeNull();
        await f.repository.cancelCommand(project,actor,key);
        await expect(f.commands.cancel(project,id.id,actor,{requestKey:key})).rejects.toMatchObject({status:409});
        expect((await f.repository.list(project,actor))[0].status).toBe('UPLOADING');
    });
    it('resolves a committed command ACK and never permits cancellation to rewrite it',async()=>{
        const f=await fixture(),row=await f.create(),key=randomUUID(),result=await f.commands.cancel(project,row.id,actor,{requestKey:key});
        expect(await f.repository.lookupCommand(project,actor,key)).toEqual({result});
        await expect(f.repository.cancelCommand(project,actor,key)).rejects.toMatchObject({status:409});
        await expect(f.repository.cancelRequest(project,actor,{...f.input,expectedBindingId:'b'.repeat(64)})).rejects.toMatchObject({status:409});
    });
    it('never collects the head, profile pins, a grace period, or a deleted project implicitly',async()=>{
        const {SnapshotGarbageCollector}=await import('../src/snapshots/snapshot-gc');
        const f=await fixture(),id=await f.verified(),gc=new SnapshotGarbageCollector({pool:f.pool,storage:()=>f.storage} as never);
        await f.commands.remove(project,id,actor,{requestKey:randomUUID(),expectedManifest:snapshotManifestHash(manifest())});
        expect(await gc.collect()).toEqual({processed:0,deleted:0});
        await f.pool.query("UPDATE project_snapshots SET delete_after=now()-interval '1 second'");
        await f.pool.query('UPDATE projects SET head_snapshot_id=$1',[id]);expect(await gc.collect()).toEqual({processed:0,deleted:0});
        await f.pool.query('DELETE FROM projects');expect(await gc.collect()).toEqual({processed:0,deleted:0});
        expect(await f.storage.read(project,hash('abc'))).toEqual(Buffer.from('abc'));
    });
    it('keeps shared blocks until the last explicit snapshot deletion is due',async()=>{
        const {SnapshotGarbageCollector}=await import('../src/snapshots/snapshot-gc');
        const f=await fixture(),first=await f.verified();f.input.requestKey=randomUUID();const second=await f.verified();
        const gc=new SnapshotGarbageCollector({pool:f.pool,storage:()=>f.storage} as never);
        await f.commands.remove(project,first,actor,{requestKey:randomUUID(),expectedManifest:snapshotManifestHash(manifest())});
        await f.pool.query("UPDATE project_snapshots SET delete_after=now()-interval '1 second' WHERE id=$1",[first]);
        expect(await gc.collect()).toEqual({processed:1,deleted:1});expect(await f.storage.read(project,hash('abc'))).toEqual(Buffer.from('abc'));
        expect((await f.pool.query('SELECT status FROM project_snapshots WHERE id=$1',[second])).rows[0].status).toBe('VERIFIED');
        await f.commands.remove(project,second,actor,{requestKey:randomUUID(),expectedManifest:snapshotManifestHash(manifest())});
        await f.pool.query("UPDATE project_snapshots SET delete_after=now()-interval '1 second' WHERE id=$1",[second]);
        expect(await gc.collect()).toEqual({processed:1,deleted:1});await expect(f.storage.read(project,hash('abc'))).rejects.toMatchObject({status:503});
    });
    it('resumes a durable delete after object removal ACK loss while a new publication references that SHA',async()=>{
        const {SnapshotGarbageCollector}=await import('../src/snapshots/snapshot-gc');
        const f=await fixture(),id=await f.verified(),gc=new SnapshotGarbageCollector({pool:f.pool,storage:()=>f.storage} as never),remove=f.storage.remove.bind(f.storage);
        await f.commands.remove(project,id,actor,{requestKey:randomUUID(),expectedManifest:snapshotManifestHash(manifest())});
        await f.pool.query("UPDATE project_snapshots SET delete_after=now()-interval '1 second'");
        let lost=true;f.storage.remove=async(...args)=>{await remove(...args);if(lost){lost=false;throw new Error('lost object deletion ACK');}};
        await expect(gc.collect()).rejects.toThrow('lost object deletion ACK');
        expect((await f.pool.query('SELECT state FROM project_snapshot_blobs')).rows[0].state).toBe('DELETING');
        f.input.requestKey=randomUUID();const next=await f.create();expect((await f.repository.beginManifest(project,next.id,actor,manifest())).missing).toHaveLength(1);
        await expect(f.storage.put(project,hash('abc'),Buffer.from('abc'))).rejects.toMatchObject({status:409});
        expect(await gc.collect()).toEqual({processed:1,deleted:1});
        await f.storage.put(project,hash('abc'),Buffer.from('abc'));await f.repository.finishUpload(project,next.id,actor,snapshotManifestHash(manifest()));
        expect((await f.repository.list(project,actor)).find(row=>row.snapshotId===next.id)?.status).toBe('VERIFYING');
    });
    it('closes an expired verifier with revoked permissions instead of starving the queue',async()=>{
        const {SnapshotVerifier}=await import('../src/snapshots/snapshot-verifier');
        const f=await fixture(),row=await f.create();await f.repository.beginManifest(project,row.id,actor,manifest());await f.storage.put(project,hash('abc'),Buffer.from('abc'));
        await f.repository.finishUpload(project,row.id,actor,snapshotManifestHash(manifest()));
        await f.pool.query("UPDATE project_snapshots SET verifier_owner=$1,verifier_lease_until=now()-interval '1 second'",[randomUUID()]);
        await f.pool.query('UPDATE platform_users SET enabled=false');
        const verifier=new SnapshotVerifier({repository:f.repository} as never);
        expect(await verifier.claim({workerId:randomUUID(),sdkVersion:'0.29.0',imageDigest:'sha256:'+'f'.repeat(64)})).toBeNull();
        expect((await f.pool.query('SELECT status,verifier_owner FROM project_snapshots')).rows[0]).toEqual({status:'REJECTED',verifier_owner:null});
    });
});

describe('snapshot bridge receipts survive lease and verification changes',()=>{
    async function job(f:Awaited<ReturnType<typeof fixture>>,snapshotId:string,state='running'){
        const id=randomUUID(),lease=randomUUID(),payload={snapshotId,bindingId:f.input.expectedBindingId,snapshotProtocol:'project-snapshots-v1'};
        await f.pool.query(`INSERT INTO bridge_jobs(id,device_id,email,project_id,kind,state,percent,payload,lease,lease_until,role,request_key,request_hash)
          VALUES($1,$2,$3,$4,'publish-project-snapshot',$5,15,$6,$7,now()-interval '1 second',$8,$9,$10)`,[id,f.input.deviceId,actor.email,project,state,JSON.stringify(payload),lease,actor.activeRole,id,hash(id)]);
        await f.pool.query('UPDATE project_snapshots SET job_id=$2 WHERE id=$1',[snapshotId,id]);return {id,lease};
    }
    it('accepts and replays only the exact authoritative upload receipt after a verifier/delete transition',async()=>{
        const {completeDeviceJob}=await import('../src/devices/device-completion');
        const f=await fixture(),id=await f.verified(),j=await job(f,id,'reconciling'),result={projectId:project,bindingId:f.input.expectedBindingId,snapshotId:id,manifestSha256:snapshotManifestHash(manifest()),status:'UPLOADED',bytes:3,fileCount:1,tableCount:1};
        for(const changed of [{...result,status:'VERIFIED'},{...result,bytes:4},{...result,snapshotId:randomUUID()},{...result,path:'/private'},{...result,bindingId:'b'.repeat(64)}])await expect(completeDeviceJob(f.pool,f.input.deviceId,j.id,{lease:j.lease,state:'succeeded',message:'untrusted',result:changed})).rejects.toMatchObject({status:409});
        await f.commands.remove(project,id,actor,{requestKey:randomUUID(),expectedManifest:result.manifestSha256});
        expect(await completeDeviceJob(f.pool,f.input.deviceId,j.id,{lease:j.lease,state:'succeeded',message:'untrusted',result})).toEqual({ok:true,repeated:false});
        expect(await completeDeviceJob(f.pool,f.input.deviceId,j.id,{lease:j.lease,state:'succeeded',message:'untrusted',result})).toEqual({ok:true,repeated:true});
        expect((await f.pool.query('SELECT state,message FROM bridge_jobs WHERE id=$1',[j.id])).rows[0]).toMatchObject({state:'succeeded',message:expect.stringContaining('Проверка LanceDB выполняется отдельно')});
    });
    it('reconciles a lost complete ACK from server bytes and definitively closes an unpublished capture',async()=>{
        const {reconcileSnapshotJobs}=await import('../src/devices/project-snapshot-completion');
        const f=await fixture(),first=await f.verified(),accepted=await job(f,first);f.input.requestKey=randomUUID();const pending=await f.create(),interrupted=await job(f,pending.id);
        await reconcileSnapshotJobs(f.pool);
        expect((await f.pool.query('SELECT state,result FROM bridge_jobs WHERE id=$1',[accepted.id])).rows[0]).toMatchObject({state:'succeeded',result:{status:'UPLOADED',snapshotId:first,bytes:3}});
        expect((await f.pool.query('SELECT state,result FROM bridge_jobs WHERE id=$1',[interrupted.id])).rows[0]).toEqual({state:'failed',result:{}});
        expect((await f.pool.query('SELECT status FROM project_snapshots WHERE id=$1',[pending.id])).rows[0].status).toBe('REJECTED');
        expect((await f.pool.query('SELECT state FROM operations WHERE resource_id=$1',[interrupted.id])).rows[0].state).toBe('FAILED');
    });
    it('a snapshot failure audit error rolls back both the bridge queue and snapshot status',async()=>{
        const f=await fixture(),pending=await f.create(),j=await job(f,pending.id);
        await f.pool.query("ALTER TABLE security_events ADD CONSTRAINT reject_upload_failure CHECK(action<>'snapshot.upload.failed')");
        await expect(f.pool.query("UPDATE bridge_jobs SET state='failed' WHERE id=$1",[j.id])).rejects.toBeTruthy();
        expect((await f.pool.query('SELECT state FROM bridge_jobs WHERE id=$1',[j.id])).rows[0].state).toBe('running');
        expect((await f.pool.query('SELECT status FROM project_snapshots WHERE id=$1',[pending.id])).rows[0].status).toBe('UPLOADING');
    });
});

describe('snapshot write intents account for bytes before filesystem publication',()=>{
    it('recovers a real published blob after the metadata insert failed',async()=>{
        const f=await fixture();await f.pool.query('ALTER TABLE project_snapshot_blobs ADD CONSTRAINT reject_blob CHECK(bytes<>3) NOT VALID');
        await expect(f.storage.put(project,hash('abc'),Buffer.from('abc'))).rejects.toBeTruthy();
        expect((await f.pool.query('SELECT bytes FROM project_snapshot_blob_writes')).rows[0].bytes).toBe('3');
        expect((await f.pool.query('SELECT count(*) FROM project_snapshot_blobs')).rows[0].count).toBe('0');
        await expect(f.storage.read(project,hash('abc'))).rejects.toMatchObject({status:503});
        await f.pool.query('ALTER TABLE project_snapshot_blobs DROP CONSTRAINT reject_blob');expect(await f.storage.recoverWrite()).toBe(true);
        expect(await f.storage.read(project,hash('abc'))).toEqual(Buffer.from('abc'));expect((await f.pool.query('SELECT count(*) FROM project_snapshot_blob_writes')).rows[0].count).toBe('0');
    });
    it('cleans an owned partial stage and completes a lost hardlink-to-metadata transition',async()=>{
        const f=await fixture(),folder=path.join(f.storage.directory,hash(project)),write=randomUUID();await fs.mkdir(folder,{recursive:true,mode:0o700});
        await f.pool.query('INSERT INTO project_snapshot_blob_writes(project_id,sha256,write_id,bytes,storage_id) VALUES($1,$2,$3,3,$4)',[project,hash('abc'),write,f.storage.storageId]);
        const stage=path.join(folder,'.stage-'+write),target=path.join(folder,hash('abc'));await fs.writeFile(stage,'partial',{mode:0o600});
        expect(await f.storage.recoverWrite()).toBe(true);await expect(fs.stat(stage)).rejects.toMatchObject({code:'ENOENT'});
        await f.pool.query('INSERT INTO project_snapshot_blob_writes(project_id,sha256,write_id,bytes,storage_id) VALUES($1,$2,$3,3,$4)',[project,hash('abc'),write,f.storage.storageId]);
        await fs.writeFile(stage,'abc',{mode:0o400});await fs.link(stage,target);
        expect(await f.storage.recoverWrite()).toBe(true);expect((await fs.stat(target)).nlink).toBe(1);expect(await f.storage.read(project,hash('abc'))).toEqual(Buffer.from('abc'));
    });
    it('never follows or removes a substituted stage and never ignores its quota reservation',async()=>{
        const f=await fixture(),folder=path.join(f.storage.directory,hash(project)),write=randomUUID();await fs.mkdir(folder,{recursive:true,mode:0o700});
        await f.pool.query('INSERT INTO project_snapshot_blob_writes(project_id,sha256,write_id,bytes,storage_id) VALUES($1,$2,$3,3,$4)',[project,hash('abc'),write,f.storage.storageId]);
        const stage=path.join(folder,'.stage-'+write);await fs.symlink('/etc/hosts',stage);await expect(f.storage.recoverWrite()).rejects.toMatchObject({status:409});expect((await fs.lstat(stage)).isSymbolicLink()).toBe(true);
        const old=process.env.SNAPSHOT_STORAGE_MAX_BYTES;process.env.SNAPSHOT_STORAGE_MAX_BYTES='9';
        try{await expect(f.storage.put(project,hash('def'),Buffer.from('def'))).rejects.toMatchObject({status:409});}
        finally{if(old===undefined)delete process.env.SNAPSHOT_STORAGE_MAX_BYTES;else process.env.SNAPSHOT_STORAGE_MAX_BYTES=old;}
        expect((await f.pool.query('SELECT count(*) FROM project_snapshot_blob_writes')).rows[0].count).toBe('1');
    });
});
