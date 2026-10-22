import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {assetDigest,type BridgeAsset} from '@neurocenter/asset-contract';
import {AssetSourceSnapshots} from '../src/asset-sources/source-snapshots';
import {SourceMetadataCache} from '../src/asset-sources/source-cache';
import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
import {sourceAvailabilityFixture,snapshotFaultPool,connection,actor} from './asset-source-availability-postgres.fixture';

describe.skipIf(connection===undefined).sequential('Cold source availability through actual Catalog SQL and controllers',()=>{
    let f:Awaited<ReturnType<typeof sourceAvailabilityFixture>>;
    beforeEach(async()=>{f=undefined!;f=await sourceAvailabilityFixture();});
    afterEach(async()=>{try{await f?.close();}finally{vi.useRealTimers();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();}});
    async function observed(){return(await f.observer.query('SELECT pin,index,assets FROM asset_source_snapshots ORDER BY commit')).rows;}
    async function nextCommit(pool:Pool){const client=await pool.connect();try{const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await client.query('SELECT 1 AS unrelated_borrower_read');await client.query('COMMIT');return pid;}finally{client.release();}}

    it('failed snapshot rollback cannot leak a rejected INSERT through a later unrelated borrower COMMIT',async()=>{
        await f.prepare();const owner=f.ownerPool(),fault=snapshotFaultPool(owner,'insert','not-dispatched');
        const sources=new AssetSourceSnapshots(fault.pool,f.pin,f.request),before=await observed();
        await expect(sources.refresh()).rejects.toBe(fault.failure);expect(await observed()).toEqual(before);
        const nextPid=await nextCommit(owner);
        expect(await observed()).toEqual(before);
        expect(fault.events.some(event=>event.sql==='ROLLBACK'&&!event.executed)).toBe(true);
        expect(fault.releaseError()).toBe(true);expect(nextPid).not.toBe(fault.pid());expect(f.request).not.toHaveBeenCalled();
    });

    it('prepared local metadata gives the first authorized GET a verified list after actual service startup without GitHub',async()=>{
        await f.prepare();await f.startup();const response=await f.controller.source(f.req);
        expect(response.source).toMatchObject({verified:true,commit:f.pin.commit,mode:'online'});
        expect(response.assets).toMatchObject([{id:f.record.asset.id,sha256:f.record.sha256}]);
        expect(await observed()).toHaveLength(1);expect(f.request).not.toHaveBeenCalled();
    });

    it('lost rollback ACK discards the session while an acknowledged rollback reuses it',async()=>{
        await f.prepare();
        for(const rollback of ['ack-lost','normal'] as const){
            const owner=f.ownerPool(),fault=snapshotFaultPool(owner,'insert',rollback),before=await observed();
            await expect(new AssetSourceSnapshots(fault.pool,f.pin,f.request).refresh()).rejects.toBe(fault.failure);
            expect(await observed()).toEqual(before);const nextPid=await nextCommit(owner);expect(await observed()).toEqual(before);
            expect(fault.releaseError()).toBe(rollback==='ack-lost');
            if(rollback==='ack-lost')expect(nextPid).not.toBe(fault.pid());else expect(nextPid).toBe(fault.pid());
        }
        expect(f.request).not.toHaveBeenCalled();
    });

    it('lost COMMIT ACK preserves exactly one committed snapshot and the next GET truthfully shows it',async()=>{
        await f.prepare();const owner=f.ownerPool(),fault=snapshotFaultPool(owner,'commit','normal');
        await expect(new AssetSourceSnapshots(fault.pool,f.pin,f.request).refresh()).rejects.toBe(fault.failure);
        const committed=await observed();expect(committed).toHaveLength(1);expect(committed[0].pin).toEqual(f.pin);
        expect(await nextCommit(owner)).toBe(fault.pid());expect(await observed()).toEqual(committed);expect(fault.releaseError()).toBe(false);
        const response=await f.controller.source(f.req);expect(response.source.verified).toBe(true);expect(response.assets[0].id).toBe(f.record.asset.id);
        expect(response.source.error).toBe(fault.failure.message);expect(f.request).not.toHaveBeenCalled();
    });

    it('failed status persistence cannot replace the primary snapshot failure',async()=>{
        await f.prepare();const fault=snapshotFaultPool(f.ownerPool(),'insert','normal'),statusFailure=new Error('Own failure-status database unavailable');
        const query=fault.pool.query.bind(fault.pool) as(...input:unknown[])=>Promise<unknown>;
        const pool={...fault.pool,query:async(sql:string,...args:unknown[])=>{
            if(sql.startsWith('INSERT INTO asset_source_refresh'))throw statusFailure;
            return query(sql,...args);
        }} as unknown as Pool;
        await expect(new AssetSourceSnapshots(pool,f.pin,f.request).refresh()).rejects.toBe(fault.failure);
        expect(await observed()).toEqual([]);expect(fault.releaseError()).toBe(false);expect(f.request).not.toHaveBeenCalled();
    });

    it('startup without a prepared index stays empty without GitHub or feature-service calls',async()=>{
        await f.startup();const response=await f.controller.source(f.req);
        expect(response.source.verified).toBe(false);expect(response.assets).toEqual([]);expect(await observed()).toEqual([]);
        expect(f.flags.calls).toBe(0);expect(f.events.calls).toEqual([]);expect(f.request).not.toHaveBeenCalled();expect(await fs.readdir(f.root)).toEqual([]);
    });

    it.each(['off','unavailable'] as const)('optional feature %s does not stop startup or publish the prepared metadata',async state=>{
        await f.prepare();f.flags[state]=true;await f.startup();const response=await f.controller.source(f.req);
        expect(response.source.verified).toBe(false);expect(response.source.error).toBeTruthy();expect(response.assets).toEqual([]);
        expect(await observed()).toEqual([]);expect(f.events.calls).toEqual([]);expect(f.request).not.toHaveBeenCalled();expect(f.flags.calls).toBe(1);
        f.flags[state]=false;const retried=await f.controller.refresh(f.req);expect(retried.source.verified).toBe(true);expect(retried.assets[0].id).toBe(f.record.asset.id);
        expect(f.request).not.toHaveBeenCalled();
    });

    it('incomplete prepared metadata never falls back to GitHub at startup and keeps a useful diagnostic',async()=>{
        await f.prepare();await fs.unlink(path.join(f.root,'.asset-source-metadata',f.record.sha256+'.json'));
        await f.startup();const response=await f.controller.source(f.req);
        expect(response.source.verified).toBe(false);expect(response.source.error).toContain('кэше');expect(response.assets).toEqual([]);
        expect(await observed()).toEqual([]);expect(f.events.calls).toEqual([]);expect(f.request).not.toHaveBeenCalled();
    });

    it('bootstrap does not publish when the feature turns off during asynchronous descriptor cache loading',async()=>{
        await f.prepare();const read=SourceMetadataCache.prototype.read;let switched=false;
        vi.spyOn(SourceMetadataCache.prototype,'read').mockImplementation(async function(this:SourceMetadataCache,sha,maximum){
            const bytes=await read.call(this,sha,maximum);
            if(sha===f.record.sha256){expect(f.flags.calls).toBe(1);f.flags.off=true;switched=true;}
            return bytes;
        });
        await f.startup();expect(switched).toBe(true);const response=await f.controller.source(f.req);
        expect(response.source.verified).toBe(false);expect(response.source.error).toContain('отключена');
        expect(await observed()).toEqual([]);expect(f.request).not.toHaveBeenCalled();
    });

    it('successful startup seed clears an earlier OFF bootstrap diagnostic in the same durable publication',async()=>{
        await f.prepare();f.flags.off=true;
        await f.sources.bootstrap(()=>requireFeaturesEnabled(['asset_sources']));
        expect((await f.sources.status()).last?.message).toContain('отключена');expect(await observed()).toEqual([]);
        f.flags.off=false;await f.startup();const response=await f.controller.source(f.req);
        expect(response.source.verified).toBe(true);expect(response.source.error).toBeUndefined();
        expect((await f.sources.status()).last?.message).toBe('');expect(await observed()).toHaveLength(1);expect(f.request).not.toHaveBeenCalled();
    });

    it('a saved snapshot survives restart and a failed explicit refresh with an honest error and unchanged bytes',async()=>{
        await f.prepare();await f.sources.refresh();const before=await f.sources.latest();
        await fs.rm(path.join(f.root,'.asset-source-metadata'),{recursive:true});await f.startup();
        expect(await f.sources.latest()).toEqual(before);expect(f.flags.calls).toBe(0);expect(f.events.calls).toEqual([]);expect(f.request).not.toHaveBeenCalled();
        await expect(f.controller.refresh(f.req)).rejects.toMatchObject({status:503});
        const response=await f.controller.source(f.req);expect(response.source.verified).toBe(true);expect(response.source.error).toBeTruthy();
        expect(response.source.commit).toBe(before!.pin.commit);expect(response.assets[0].sha256).toBe(f.record.sha256);expect(await f.sources.latest()).toEqual(before);
        expect(f.request).toHaveBeenCalledTimes(1);
    });

    it('a concurrent explicit snapshot wins before bootstrap acquires its publication lock',async()=>{
        await f.prepare();let admitted=false;
        const newer={...f.pin,commit:'b'.repeat(40)};
        await f.sources.bootstrap(async()=>{
            admitted=true;
            await f.observer.query('INSERT INTO asset_source_snapshots(commit,pin,index,assets) VALUES($1,$2,$3,$4)',[newer.commit,JSON.stringify(newer),JSON.stringify(f.index),JSON.stringify([f.record])]);
        });
        expect(admitted).toBe(true);expect((await observed()).map(row=>row.pin)).toEqual([newer]);expect(f.request).not.toHaveBeenCalled();
    });

    it('cold list imports an inline tool through the actual service worker and preserves request idempotency',async()=>{
        await f.prepare();await f.startup();const first=await f.controller.source(f.req),body={requestKey:randomUUID(),commit:first.source.commit,ids:[f.record.asset.id]};
        await fs.rm(path.join(f.root,'.asset-source-metadata'),{recursive:true});
        const accepted=await f.controller.start(f.req,body);await f.flush();const saved=await f.jobs.get(accepted.id,actor);
        expect(saved.state).toBe('SUCCEEDED');expect(saved.source).toEqual(f.pin);
        const native=await f.observer.query('SELECT id,name FROM ai_plugins');expect(native.rows).toHaveLength(1);expect(native.rows[0].name).toBe('Owned tool');
        const repeated=await f.controller.start(f.req,body);await f.flush();expect(repeated.id).toBe(accepted.id);
        expect((await f.observer.query('SELECT * FROM asset_source_versions')).rows).toHaveLength(1);
        const response=await f.controller.source(f.req);expect(response.assets[0].imported).toMatchObject({id:native.rows[0].id,unavailable:false});expect(f.request).not.toHaveBeenCalled();
    });

    it('already imported bridge bytes remain available with no source snapshot and a blocked external list',async()=>{
        const bytes=Buffer.from('Owned immutable bridge archive'),sha=assetDigest(bytes),version='0.9.18',target='darwin-arm64',buildId='b'.repeat(64),file=`neurocenter-asset-sync-${target}-${version}.tgz`;
        await fs.mkdir(f.blobs.directory,{recursive:true});await fs.writeFile(path.join(f.blobs.directory,sha+'.blob'),bytes,{mode:0o400});
        const descriptor:BridgeAsset={schemaVersion:1,id:'owned-bridge',kind:'bridge',version,source:{type:'release',repository:'https://github.com/owner/bridge',tag:'bridge-v'+version},license:{spdx:'MIT'},compatibility:{bridgeProtocol:2},card:{name:'Owned bridge',description:'Owned immutable bridge'},
            delivery:{type:'bridge-release',release:{schemaVersion:1,release:'bridge-v'+version,version,buildId,artifacts:[{file,url:`https://github.com/owner/bridge/releases/download/bridge-v${version}/${file}`,metadata:{version,target,buildId,sha256:sha,bytes:bytes.length,nodeVersion:'24.22.0',ragSupported:false,probeEngine:{file:'bin/opencode-probe',version:'1.0.0',sha256:'c'.repeat(64)}}}]}}};
        const blobs=[{sha256:sha,bytes:bytes.length,filename:file,target}];
        await f.pool.query(`INSERT INTO asset_source_receipts(repository,external_id,asset_kind,asset_version,descriptor_sha256,source_commit,native_id,native_version,native_hash,descriptor,blobs,imported_by)
            VALUES($1,$2,'bridge',$3,$4,$5,$2,1,$4,$6,$7,$8)`,[f.pin.repository,descriptor.id,version,'d'.repeat(64),f.pin.commit,JSON.stringify(descriptor),JSON.stringify(blobs),actor]);
        const source=await f.controller.source(f.req);expect(source.source.verified).toBe(false);expect(source.assets).toEqual([]);
        const supply=await f.service.bridgeSupply();expect(supply).toMatchObject({version,buildId,artifacts:[{sha256:sha,bytes:bytes.length,target}]});
        expect(await fs.readFile(path.join(f.blobs.directory,sha+'.blob'))).toEqual(bytes);expect(f.request).not.toHaveBeenCalled();
    });

    it('flags recover after startup: an existing lifecycle tick seeds once without another source refresh or restart',async()=>{
        vi.useFakeTimers({toFake:['setInterval','clearInterval']});await f.prepare();f.flags.unavailable=true;
        const bootstrap=vi.spyOn(f.sources,'bootstrap');await f.startup();expect(await observed()).toEqual([]);
        f.flags.unavailable=false;vi.advanceTimersByTime(5000);
        await Promise.all(bootstrap.mock.results.map(result=>result.type==='return'?result.value:undefined));
        expect(await observed()).toHaveLength(1);const first=await f.sources.latest();expect(bootstrap).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(15000);await Promise.resolve();expect(bootstrap).toHaveBeenCalledTimes(2);expect(await f.sources.latest()).toEqual(first);
        expect((await f.controller.source(f.req)).source).toMatchObject({verified:true,error:undefined});expect(f.request).not.toHaveBeenCalled();
    });

    it('OFF lifecycle retries remain singleflight while one admitted feature request is pending and never publish',async()=>{
        vi.useFakeTimers({toFake:['setInterval','clearInterval']});await f.prepare();f.flags.off=true;
        const bootstrap=vi.spyOn(f.sources,'bootstrap');await f.startup();
        let release!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
        f.flags.pending=new Promise<void>(resolve=>{release=resolve;});f.flags.started=entered;vi.advanceTimersByTime(5000);await started;
        vi.advanceTimersByTime(15000);expect(bootstrap).toHaveBeenCalledTimes(2);expect(f.flags.calls).toBe(2);expect(await observed()).toEqual([]);
        f.flags.pending=undefined;f.flags.started=undefined;release();await Promise.all(bootstrap.mock.results.map(result=>result.type==='return'?result.value:undefined));
        expect(await observed()).toEqual([]);expect(f.request).not.toHaveBeenCalled();
    });

    it.each(['absent','damaged'] as const)('terminal %s cache is not repeatedly scanned by lifecycle ticks',async state=>{
        vi.useFakeTimers({toFake:['setInterval','clearInterval']});
        if(state==='damaged'){await f.prepare();await fs.unlink(path.join(f.root,'.asset-source-metadata',f.record.sha256+'.json'));}
        const bootstrap=vi.spyOn(f.sources,'bootstrap'),read=vi.spyOn(SourceMetadataCache.prototype,'read');await f.startup();const reads=read.mock.calls.length;
        vi.advanceTimersByTime(20000);await Promise.resolve();expect(bootstrap).toHaveBeenCalledTimes(1);expect(read).toHaveBeenCalledTimes(reads);
        expect(await observed()).toEqual([]);expect(f.request).not.toHaveBeenCalled();
    });

    it('shutdown waits for an in-flight bootstrap and fences late enabled replies before publication or further polling',async()=>{
        vi.useFakeTimers({toFake:['setInterval','clearInterval']});await f.prepare();f.flags.unavailable=true;
        const bootstrap=vi.spyOn(f.sources,'bootstrap');await f.startup();f.flags.unavailable=false;
        let release!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
        f.flags.pending=new Promise<void>(resolve=>{release=resolve;});f.flags.started=entered;vi.advanceTimersByTime(5000);await started;
        let stopped=false;const stopping=f.stop().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);
        f.flags.pending=undefined;f.flags.started=undefined;release();await stopping;expect(stopped).toBe(true);expect(await observed()).toEqual([]);
        const calls=f.flags.calls;vi.advanceTimersByTime(15000);await Promise.resolve();expect(bootstrap).toHaveBeenCalledTimes(2);expect(f.flags.calls).toBe(calls);expect(f.request).not.toHaveBeenCalled();
    });

    it('shutdown during initial startup never creates a worker or timer after the initial admission settles',async()=>{
        vi.useFakeTimers({toFake:['setInterval','clearInterval']});await f.prepare();
        let release!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
        f.flags.pending=new Promise<void>(resolve=>{release=resolve;});f.flags.started=entered;
        const starting=f.startup();await started;const connect=vi.spyOn(f.pool,'connect');
        const stopping=f.stop();f.flags.pending=undefined;f.flags.started=undefined;release();await Promise.all([starting,stopping]);
        expect(vi.getTimerCount()).toBe(0);expect(connect).not.toHaveBeenCalled();expect(await observed()).toEqual([]);expect(f.request).not.toHaveBeenCalled();
    });

    it('own successful seed sends exactly one authenticated catalog event after the snapshot is independently durable',async()=>{
        vi.useFakeTimers({toFake:['setInterval','clearInterval']});await f.prepare();await f.startup();
        expect(f.events.calls).toEqual([{url:'https://gateway.owned.invalid/internal/events',method:'POST',sections:['catalog'],durableSnapshots:1,signal:true}]);
        expect(f.events.cancelled).toBe(1);vi.advanceTimersByTime(15000);await Promise.resolve();expect(f.events.calls).toHaveLength(1);
        expect((await f.controller.source(f.req)).source.verified).toBe(true);expect(f.request).not.toHaveBeenCalled();
    });

    it('Gateway notification failure never rolls back the committed seed or starts perpetual notification retries',async()=>{
        vi.useFakeTimers({toFake:['setInterval','clearInterval']});await f.prepare();f.events.unavailable=true;await f.startup();
        expect(f.events.calls).toHaveLength(1);expect(f.events.calls[0].durableSnapshots).toBe(1);expect(await observed()).toHaveLength(1);
        const first=await f.sources.latest();vi.advanceTimersByTime(20000);await Promise.resolve();expect(f.events.calls).toHaveLength(1);expect(await f.sources.latest()).toEqual(first);
    });

    it('a rejected bootstrap INSERT emits no catalog event and never leaves a verified snapshot',async()=>{
        await f.prepare();await f.pool.query("ALTER TABLE asset_source_snapshots ADD CONSTRAINT own_seed_failure CHECK(commit <> '"+f.pin.commit+"')");
        await f.startup();expect(await observed()).toEqual([]);expect(f.events.calls).toEqual([]);
        expect((await f.controller.source(f.req)).source).toMatchObject({verified:false,error:expect.stringContaining('own_seed_failure')});
        expect(f.request).not.toHaveBeenCalled();
    });
});
