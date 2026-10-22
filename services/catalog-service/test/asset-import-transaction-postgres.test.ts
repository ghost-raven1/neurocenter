import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {AssetImportRepository} from '../src/asset-sources/import-repository';
import {importPlanDigest,type IImportItem} from '../src/asset-sources/import-types';
import type {ToolAsset} from '@neurocenter/asset-contract';
import {assetImportTransactionFixture,connection,importFaultPool,type ImportOwner} from './asset-import-transaction-postgres.fixture';

const actor='owner@transaction.test',pin={schemaVersion:1 as const,repository:'owner/owned-assets',commit:'a'.repeat(40),index:{path:'index.json',sha256:'b'.repeat(64)}};
describe.skipIf(connection===undefined).sequential('Asset import repository actual transaction ownership',()=>{
    let f:Awaited<ReturnType<typeof assetImportTransactionFixture>>;
    beforeEach(async()=>{f=undefined!;f=await assetImportTransactionFixture();});
    afterEach(async()=>{await f?.close();});
    async function action(owner:ImportOwner,jobs=new AssetImportRepository(f.pool)){
        const key=randomUUID();
        if(owner==='create')return{key,run:()=>jobs.create(actor,key,pin,['owned-tool'])};
        const saved=await new AssetImportRepository(f.pool).create(actor,key,pin,['owned-tool']);
        const asset:ToolAsset={schemaVersion:1,id:'owned-tool',kind:'plugin',version:'1.0.0',license:{spdx:'MIT'},compatibility:{packageFormat:5},source:{type:'git',repository:'https://github.com/example/owned',commit:'a'.repeat(40)},card:{kind:'plugin',name:'Owned tool',description:'Owned fixture',revision:'1',origin:'upload',tags:[],files:[{path:'index.mjs',content:'export default {}'}],config:{entrypoint:'index.mjs'}},delivery:{type:'runtime-artifacts',artifacts:[]}};
        const item:IImportItem={resolved:{asset,sha256:'c'.repeat(64),path:'assets/owned-tool/1.0.0/asset.json',current:true},requestKey:randomUUID(),name:'Owned tool',action:'conflict',state:'PENDING',replaceable:true,expected:{kind:'plugin',id:'ai-plug-'+randomUUID(),version:2,hash:'d'.repeat(64)}};
        const updated=(await f.pool.query("UPDATE asset_source_jobs SET state='NEEDS_INPUT',items=$2::jsonb WHERE id=$1 RETURNING *",[saved.id,JSON.stringify([item])])).rows[0];
        return{key,run:()=>jobs.resolve(saved.id,actor,importPlanDigest(updated))};
    }
    async function observed(key:string){return(await f.observer.query('SELECT * FROM asset_source_jobs WHERE actor=$1 AND request_key=$2',[actor,key])).rows;}
    async function journal(){return(await f.observer.query('SELECT * FROM security_events WHERE actor=$1 ORDER BY created_at,event_id',[actor])).rows;}
    async function unrelatedCommit(){const client=await f.pool.connect();try{const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;await client.query('SELECT 1 AS unrelated_borrower_read');await client.query('COMMIT');return pid;}finally{client.release();}}

    it.each(['create','resolve'] as const)('%s never exposes a ghost QUEUED write after a failed rollback and later borrower COMMIT',async owner=>{
        const fault=importFaultPool(f.pool,owner,'write-ack','not-dispatched'),a=await action(owner,new AssetImportRepository(fault.pool)),before=await observed(a.key);
        await expect(a.run()).rejects.toBe(fault.failure);
        expect(await observed(a.key)).toEqual(before);
        const nextPid=await unrelatedCommit();
        expect(await observed(a.key)).toEqual(before);
        expect(fault.events.some(event=>event.sql==='ROLLBACK'&&!event.executed)).toBe(true);
        expect(fault.releaseError()).toBeTruthy();expect(nextPid).not.toBe(fault.pid());
    });

    it.each(['create','resolve'] as const)('%s discards even when PostgreSQL rolled back but its ACK was lost',async owner=>{
        const fault=importFaultPool(f.pool,owner,'write-ack','ack-lost'),a=await action(owner,new AssetImportRepository(fault.pool)),before=await observed(a.key),audit=await journal();
        await expect(a.run()).rejects.toBe(fault.failure);
        expect(await observed(a.key)).toEqual(before);expect(await journal()).toEqual(audit);
        const nextPid=await unrelatedCommit();
        expect(await observed(a.key)).toEqual(before);expect(await journal()).toEqual(audit);
        expect(fault.events.some(event=>event.sql==='ROLLBACK'&&event.executed)).toBe(true);
        expect(fault.releaseError()).toBe(true);expect(nextPid).not.toBe(fault.pid());
    });

    it.each(['create','resolve'] as const)('%s destroys an unconfirmed BEGIN session without dispatching any job write',async owner=>{
        const fault=importFaultPool(f.pool,owner,'begin-ack','not-dispatched'),a=await action(owner,new AssetImportRepository(fault.pool)),before=await observed(a.key),audit=await journal();
        await expect(a.run()).rejects.toBe(fault.failure);
        const nextPid=await unrelatedCommit();
        expect(await observed(a.key)).toEqual(before);expect(await journal()).toEqual(audit);
        expect(fault.events.filter(event=>event.executed).map(event=>event.sql)).toEqual(['BEGIN']);
        expect(fault.releaseError()).toBe(true);expect(nextPid).not.toBe(fault.pid());
    });

    it.each(['create','resolve'] as const)('%s preserves the real audit constraint error and reuses a normally rolled back session',async owner=>{
        const fault=importFaultPool(f.pool,owner,'none','normal'),a=await action(owner,new AssetImportRepository(fault.pool)),before=await observed(a.key),audit=await journal();
        await f.pool.query("ALTER TABLE security_events ADD CONSTRAINT own_audit_failure CHECK (action <> 'asset.import."+(owner==='create'?'request':'replace')+"')");
        const error=await a.run().catch(error=>error);
        expect(error).toMatchObject({code:'23514',constraint:'own_audit_failure'});expect(error).toBe(fault.queryFailure());
        expect(await observed(a.key)).toEqual(before);expect(await journal()).toEqual(audit);
        expect(await unrelatedCommit()).toBe(fault.pid());expect(fault.releaseError()).toBe(false);
        expect(await observed(a.key)).toEqual(before);expect(await journal()).toEqual(audit);
    });

    it.each(['create','resolve'] as const)('%s retains exactly committed state and audit when COMMIT succeeded but its ACK was lost',async owner=>{
        const fault=importFaultPool(f.pool,owner,'commit-ack','normal'),a=await action(owner,new AssetImportRepository(fault.pool)),audit=await journal();
        await expect(a.run()).rejects.toBe(fault.failure);
        const saved=await observed(a.key),committedAudit=await journal();
        expect(saved).toHaveLength(1);expect(saved[0].state).toBe('QUEUED');expect(committedAudit).toHaveLength(audit.length+1);
        expect(await unrelatedCommit()).toBe(fault.pid());expect(fault.releaseError()).toBe(false);
        if(owner==='create')expect((await a.run()).id).toBe(saved[0].id);
        else await expect(a.run()).rejects.toMatchObject({status:409});
        expect(await observed(a.key)).toEqual(saved);expect(await journal()).toEqual(committedAudit);
    });

    it.each(['create','resolve'] as const)('%s succeeds normally and preserves request idempotency or the resolved plan barrier',async owner=>{
        const fault=importFaultPool(f.pool,owner,'none','normal'),a=await action(owner,new AssetImportRepository(fault.pool)),audit=await journal(),saved=await a.run();
        expect(saved.state).toBe('QUEUED');expect(await observed(a.key)).toEqual([saved]);
        const committedAudit=await journal();expect(committedAudit).toHaveLength(audit.length+1);
        expect(await unrelatedCommit()).toBe(fault.pid());expect(fault.releaseError()).toBe(false);
        if(owner==='create')expect((await a.run()).id).toBe(saved.id);
        else await expect(a.run()).rejects.toMatchObject({status:409});
        expect(await observed(a.key)).toEqual([saved]);expect(await journal()).toEqual(committedAudit);
    });
});
