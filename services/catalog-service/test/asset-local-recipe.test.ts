import {describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {assetDigest} from '@neurocenter/asset-contract';
import {databaseFixture,actor,tool} from './asset-import-db.fixture';
import {LocalAssetIngest} from '../src/asset-sources/local-asset-ingest';
import {toolSupplyPlan} from '../src/package-build/supply-export';

const recipeBytes=Buffer.from('{"schemaVersion":1,"key":"public-fixture"}\n');
async function retain(db:Awaited<ReturnType<typeof databaseFixture>>,bytes=recipeBytes){
    const sha256=assetDigest(bytes),archivePath=path.join(db.root,randomUUID()+'.recipe');
    await fs.writeFile(archivePath,bytes);
    await db.blobs.ingestLocal([{archivePath,sha256,bytes:bytes.length,filename:'recipe.json'}],randomUUID());
    return {sha256,bytes:bytes.length,archivePath:path.join(db.blobs.directory,sha256+'.blob')};
}

describe('Local optional recipe retention — actual PostgreSQL and filesystem',()=>{
    it('Keeps the exact recipe in the immutable receipt and after repeated local import',async()=>{
        const db=await databaseFixture();try{
            const file=await retain(db),asset=tool('local-recipe-roundtrip').asset;
            asset.recipe={path:'recipes/public.json',sha256:file.sha256};
            const ingest=new LocalAssetIngest(db.pool,db.blobs),publicationKey=randomUUID();
            for(let index=0;index<2;index++){
                const prepared=await ingest.prepare(asset,[],randomUUID());
                expect(prepared.blobs).toEqual([{sha256:file.sha256,bytes:file.bytes,filename:asset.recipe.path}]);
                await db.plugins.create({...prepared.publication,publicationKey},actor,async(client,card)=>{await ingest.record(client,prepared,card,actor);});
                const [receipt]=await db.jobs.receipts('local-archive');
                expect(receipt.blobs).toEqual(prepared.blobs);
                expect(toolSupplyPlan(receipt).files).toEqual([{sha256:file.sha256,bytes:file.bytes,name:asset.recipe.path,roles:['public recipe']}]);
                const retained=await db.blobs.open(file.sha256),parts=[];
                for await(const part of retained.stream)parts.push(part);
                expect(Buffer.concat(parts)).toEqual(recipeBytes);
            }
            expect((await db.pool.query('SELECT * FROM ai_plugin_versions')).rowCount).toBe(1);
        }finally{await db.dispose();}
    });
    it('Can retain identical bytes at separate source and recipe paths without dropping either role',async()=>{
        const db=await databaseFixture();try{
            const file=await retain(db),asset=tool('recipe-source-same-sha').asset;
            asset.source={type:'archive',sha256:file.sha256,bytes:file.bytes};asset.recipe={path:'recipes/exact.source',sha256:file.sha256};
            const ingest=new LocalAssetIngest(db.pool,db.blobs),prepared=await ingest.prepare(asset,[],randomUUID());
            expect(prepared.blobs).toEqual([{sha256:file.sha256,bytes:file.bytes,filename:file.sha256+'.source'},
                {sha256:file.sha256,bytes:file.bytes,filename:asset.recipe.path}]);
            await db.plugins.create(prepared.publication,actor,async(client,card)=>{await ingest.record(client,prepared,card,actor);});
            const [receipt]=await db.jobs.receipts('local-archive');
            expect(toolSupplyPlan(receipt).files.map(item=>item.name)).toEqual(['source/'+file.sha256+'.source',asset.recipe.path]);
        }finally{await db.dispose();}
    });
    it.each(['source','SOURCE'])('Identical source SHA only aliases the exact role path: %s',async directory=>{
        const db=await databaseFixture();try{
            const file=await retain(db),asset=tool('recipe-source-exact-path').asset;
            asset.source={type:'archive',sha256:file.sha256,bytes:file.bytes};asset.recipe={path:directory+'/'+file.sha256+'.source',sha256:file.sha256};
            const ingest=new LocalAssetIngest(db.pool,db.blobs),ingestLocal=vi.spyOn(db.blobs,'ingestLocal');
            if(directory==='SOURCE'){
                await expect(ingest.prepare(asset,[],randomUUID())).rejects.toMatchObject({status:409,message:expect.stringContaining('collides')});
                expect(ingestLocal).not.toHaveBeenCalled();
            }else{
                const prepared=await ingest.prepare(asset,[],randomUUID());
                await db.plugins.create(prepared.publication,actor,async(client,card)=>{await ingest.record(client,prepared,card,actor);});
                const [receipt]=await db.jobs.receipts('local-archive');
                expect(toolSupplyPlan(receipt).files).toEqual([{sha256:file.sha256,bytes:file.bytes,name:asset.recipe.path,roles:['original source snapshot (opaque bytes)','public recipe']}]);
            }
        }finally{await db.dispose();}
    });
    it.each(['missing-registration','missing-file','corrupt','symlink','hardlink','oversize','wrong-sha'] as const)('Rejects %s before ingestion or publication',async change=>{
        const db=await databaseFixture();try{
            const file=await retain(db,change==='oversize'?Buffer.alloc(1024*1024+1,0x6e):recipeBytes),asset=tool('recipe-negative').asset;
            asset.recipe={path:'recipes/public.json',sha256:file.sha256};
            if(change==='missing-registration')await db.pool.query('DELETE FROM asset_source_blobs WHERE sha256=$1',[file.sha256]);
            if(change==='missing-file')await fs.unlink(file.archivePath);
            if(change==='corrupt'){await fs.chmod(file.archivePath,0o600);await fs.writeFile(file.archivePath,Buffer.alloc(file.bytes,0));}
            if(change==='symlink'){await fs.unlink(file.archivePath);const target=path.join(db.root,'external-recipe');await fs.writeFile(target,recipeBytes);await fs.symlink(target,file.archivePath);}
            if(change==='hardlink')await fs.link(file.archivePath,path.join(db.root,'linked-recipe'));
            if(change==='wrong-sha')asset.recipe.sha256='f'.repeat(64);
            const ingestLocal=vi.spyOn(db.blobs,'ingestLocal'),ingest=new LocalAssetIngest(db.pool,db.blobs);
            await expect(ingest.prepare(asset,[],randomUUID())).rejects.toMatchObject({status:409,message:expect.stringMatching(/recipe/i)});
            expect(ingestLocal).not.toHaveBeenCalled();
            expect((await db.pool.query('SELECT * FROM ai_plugins')).rowCount).toBe(0);
            expect(await db.jobs.receipts('local-archive')).toEqual([]);
        }finally{await db.dispose();}
    });
    it.each(['../recipe.json','/recipe.json','recipes\\public.json','recipes/CON.json','recipes/recipe.'])('Rejects nonportable recipe path %s before ingestion',async recipePath=>{
        const db=await databaseFixture();try{
            const file=await retain(db),asset=tool('recipe-unsafe-path').asset;asset.recipe={path:recipePath,sha256:file.sha256};
            const ingestLocal=vi.spyOn(db.blobs,'ingestLocal');
            await expect(new LocalAssetIngest(db.pool,db.blobs).prepare(asset,[],randomUUID())).rejects.toThrow();
            expect(ingestLocal).not.toHaveBeenCalled();
            expect((await db.pool.query('SELECT * FROM ai_plugins')).rowCount).toBe(0);
        }finally{await db.dispose();}
    });
    it.each(['asset.json','ASSET.JSON','README.md','readme.md/child.json','source','source-conflict'] as const)('Rejects recipe role collision %s before ingestion',async recipePath=>{
        const db=await databaseFixture();try{
            const file=await retain(db),asset=tool('recipe-role-collision').asset;
            asset.source={type:'archive',sha256:'a'.repeat(64),bytes:10};
            asset.recipe={path:recipePath==='source-conflict'?'source/'+asset.source.sha256+'.source':recipePath,sha256:file.sha256};
            const ingestLocal=vi.spyOn(db.blobs,'ingestLocal');
            await expect(new LocalAssetIngest(db.pool,db.blobs).prepare(asset,[],randomUUID())).rejects.toMatchObject({status:409,message:expect.stringContaining('collides')});
            expect(ingestLocal).not.toHaveBeenCalled();
            expect((await db.pool.query('SELECT * FROM ai_plugins')).rowCount).toBe(0);
        }finally{await db.dispose();}
    });
});
