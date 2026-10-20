import { describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assetDigest, serializeAsset } from '@neurocenter/asset-contract';
import { databaseFixture, actor, tool } from './asset-import-db.fixture';
import { LocalAssetIngest } from '../src/asset-sources/local-asset-ingest';
import { importPlanDigest } from '../src/asset-sources/import-types';

describe('Unified local envelope ingestion — actual PostgreSQL and filesystem',()=>{
 it('Local publication and source versionmap commit atomically without a fabricated Git commit',async()=>{
    const db=await databaseFixture();try{
        const ingest=new LocalAssetIngest(db.pool,db.blobs),asset=tool('local-ingest').asset;
        const source=Buffer.from('checked original source snapshot');asset.source={type:'archive',sha256:assetDigest(source),bytes:source.length};
        const sourceRoot=await fs.realpath(db.root),archivePath=path.join(sourceRoot,'source-snapshot.json');await fs.writeFile(archivePath,source);
        await expect(ingest.prepare(asset as never,[],randomUUID())).rejects.toMatchObject({status:409,message:expect.stringContaining('source snapshot')});
        const prepared=await ingest.prepare(asset as never,[],randomUUID(),undefined,{archivePath,stagingRoot:sourceRoot});
        expect(prepared.blobs).toContainEqual({sha256:asset.source.sha256,bytes:source.length,filename:asset.source.sha256+'.source'});
        const card=await db.plugins.create({...prepared.publication,publicationKey:prepared.requestKey},actor,async(client,card)=>{await ingest.record(client,prepared,card,actor);});
        expect((await db.jobs.versions('local-archive'))[0]).toMatchObject({external_id:asset.id,source_commit:null,origin:'local-archive',native_id:card.id,native_version:1});
        const head=(await db.jobs.receipts('local-archive'))[0];expect(head).toMatchObject({active:true,revision:1,native_hash:expect.any(String)});
        await db.plugins.create({...prepared.publication,publicationKey:prepared.requestKey},actor,async(client,card)=>{await ingest.record(client,prepared,card,actor);});
        expect((await db.pool.query('SELECT * FROM ai_plugin_versions')).rowCount).toBe(1);expect(await db.jobs.versions('local-archive')).toHaveLength(1);
    }finally{await db.dispose();}
 });
 it('Archive snapshot is bounded, verified before a receipt and retained for exact export',async()=>{
    const db=await databaseFixture();try{
        const ingest=new LocalAssetIngest(db.pool,db.blobs),asset=tool('source-snapshot').asset,source=Buffer.from('source snapshot exact bytes');
        asset.source={type:'archive',sha256:assetDigest(source),bytes:source.length};
        const stagingRoot=await fs.realpath(db.root),archivePath=path.join(stagingRoot,'source.json'),requestKey=randomUUID();await fs.writeFile(archivePath,source);
        const prepared=await ingest.prepare(asset as never,[],requestKey,undefined,{archivePath,stagingRoot});expect(prepared.blobs).toHaveLength(1);
        const output=await db.blobs.open(asset.source.sha256),chunks=[];for await(const chunk of output.stream)chunks.push(chunk);expect(Buffer.concat(chunks)).toEqual(source);
        await fs.writeFile(archivePath,Buffer.alloc(source.length,9));await expect(ingest.prepare(asset as never,[],randomUUID(),undefined,{archivePath,stagingRoot})).rejects.toMatchObject({status:409});
        await fs.unlink(archivePath);await fs.writeFile(archivePath,source);const link=path.join(stagingRoot,'linked.json');await fs.symlink(archivePath,link);await expect(ingest.prepare(asset as never,[],randomUUID(),undefined,{archivePath:link,stagingRoot})).rejects.toBeDefined();
        await fs.mkdir(path.join(stagingRoot,'foreign'));await expect(ingest.prepare(asset as never,[],randomUUID(),undefined,{archivePath,stagingRoot:path.join(stagingRoot,'foreign')})).rejects.toMatchObject({status:409});
        expect(await db.jobs.versions('local-archive')).toHaveLength(0);
    }finally{await db.dispose();}
 });
 it('Native/envelope mismatch or callback failure leaves neither publication nor provenance',async()=>{
    const db=await databaseFixture();try{
        const ingest=new LocalAssetIngest(db.pool,db.blobs),prepared=await ingest.prepare(tool('local-rollback').asset as never,[],randomUUID());
        await expect(db.plugins.create({...prepared.publication,description:'Different bytes'},actor,async(client,card)=>{await ingest.record(client,prepared,card,actor);})).rejects.toMatchObject({status:409});
        expect((await db.pool.query('SELECT * FROM ai_plugins')).rowCount).toBe(0);expect(await db.jobs.versions('local-archive')).toHaveLength(0);
        await expect(db.plugins.create(prepared.publication,actor,async(client,card)=>{await ingest.record(client,prepared,card,actor);throw new Error('Durable build receipt failed');})).rejects.toThrow('Durable build receipt failed');
        expect((await db.pool.query('SELECT * FROM ai_plugins')).rowCount).toBe(0);expect(await db.jobs.versions('local-archive')).toHaveLength(0);
    }finally{await db.dispose();}
 });
 it('Local blob copy verifies exact bytes and rejects changed input or symlink before registration',async()=>{
    const db=await databaseFixture();try{
        const archivePath=path.join(db.root,'ready.tgz'),bytes=Buffer.from('checked local bytes'),sha256=createHash('sha256').update(bytes).digest('hex');await fs.writeFile(archivePath,bytes);
        const file={archivePath,sha256,bytes:bytes.length,filename:'ready.tgz',target:'linux-x64'};
        expect(await db.blobs.ingestLocal([file],randomUUID())).toEqual([{sha256,bytes:bytes.length,filename:'ready.tgz',target:'linux-x64'}]);
        const opened=await db.blobs.open(sha256),chunks=[];for await(const chunk of opened.stream)chunks.push(chunk);expect(Buffer.concat(chunks)).toEqual(bytes);
        const bad={...file,sha256:'a'.repeat(64)};await expect(db.blobs.ingestLocal([bad],randomUUID())).rejects.toMatchObject({status:409});
        const link=path.join(db.root,'link.tgz');await fs.symlink(archivePath,link);await expect(db.blobs.ingestLocal([{...bad,archivePath:link}],randomUUID())).rejects.toBeDefined();
        expect((await db.pool.query('SELECT * FROM asset_source_blobs')).rowCount).toBe(1);expect((await fs.readdir(db.blobs.directory)).filter(name=>name.startsWith('.local-'))).toEqual([]);
    }finally{await db.dispose();}
 });
 it('Public source adoption is explicit; old local receipt cannot silently reclaim ownership',async()=>{
    const db=await databaseFixture(),workers=[];try{
        const ingest=new LocalAssetIngest(db.pool,db.blobs),local=tool('local-origin'),prepared=await ingest.prepare(local.asset as never,[],randomUUID());
        const card=await db.plugins.create(prepared.publication,actor,async(client,card)=>{await ingest.record(client,prepared,card,actor);});
        const upstream=tool('public-origin');upstream.asset.card.name=local.asset.card.name;upstream.sha256=assetDigest(serializeAsset(upstream.asset));
        const pin=await db.snapshot([upstream]),job=await db.jobs.create(actor,randomUUID(),pin,[upstream.asset.id]),worker=db.worker();workers.push(worker);await worker.flush();
        let saved=await db.jobs.get(job.id);expect(saved.state,saved.message).toBe('NEEDS_INPUT');expect(saved.items[0]).toMatchObject({replaceable:true,expected:{id:card.id,version:1}});
        await db.jobs.resolve(job.id,actor,importPlanDigest(saved));await worker.flush();saved=await db.jobs.get(job.id);expect(saved.state,saved.message).toBe('SUCCEEDED');
        expect((await db.jobs.receipts('local-archive'))[0].active).toBe(false);expect((await db.jobs.receipts(pin.repository))[0].active).toBe(true);
        await expect(db.plugins.create({...prepared.publication,publicationKey:randomUUID()},actor)).rejects.toMatchObject({status:409});
        const client=await db.pool.connect();try{await client.query('BEGIN');await expect(ingest.record(client,prepared,card,actor)).rejects.toMatchObject({status:409});await client.query('ROLLBACK');}finally{client.release();}
        expect((await db.jobs.receipts(pin.repository))[0].active).toBe(true);expect((await db.pool.query('SELECT * FROM ai_plugin_versions')).rowCount).toBe(1);
    }finally{await Promise.all(workers.map(worker=>worker.stop()));await db.dispose();}
 });
 it('Binary source larger than the old16MiB JSON cap is verified and retained by streaming, capped at256MiB',async()=>{
    const db=await databaseFixture();try{
        const ingest=new LocalAssetIngest(db.pool,db.blobs),asset=tool('binary-source-retention').asset,stagingRoot=path.join(await fs.realpath(db.root),'source');await fs.mkdir(stagingRoot);
        const chunk=Buffer.alloc(256*1024,0x6e),digest=createHash('sha256');for(let index=0;index<68;index++)digest.update(chunk);
        const archivePath=path.join(stagingRoot,digest.digest('hex')+'.source');
        const hash=createHash('sha256'),file=await fs.open(archivePath,'wx');
        try{for(let index=0;index<68;index++){await file.writeFile(chunk);hash.update(chunk);}}finally{await file.close();}
        const bytes=17*1024*1024;asset.source={type:'archive',sha256:hash.digest('hex'),bytes};
        const prepared=await ingest.prepare(asset as never,[],randomUUID(),undefined,{archivePath,stagingRoot});expect(prepared.blobs).toContainEqual({sha256:asset.source.sha256,bytes,filename:asset.source.sha256+'.source'});
        const retained=await db.blobs.open(asset.source.sha256);let observed=0;const actual=createHash('sha256');for await(const part of retained.stream){observed+=part.length;actual.update(part);}expect(observed).toBe(bytes);expect(actual.digest('hex')).toBe(asset.source.sha256);
        await fs.truncate(archivePath,256*1024*1024+1);asset.source={type:'archive',sha256:'f'.repeat(64),bytes:256*1024*1024+1};
        await expect(ingest.prepare(asset as never,[],randomUUID(),undefined,{archivePath,stagingRoot})).rejects.toMatchObject({status:409,message:expect.stringContaining('size')});
    }finally{await db.dispose();}
 });

});
