import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { assetDigest, serializeAsset, type ModelAsset, type ResolvedAsset } from '@neurocenter/asset-contract';
import { databaseFixture, actor, tool } from './asset-import-db.fixture';
import { ModelAssetAdapter } from '../src/asset-sources/asset-model-adapter';
import type { IImportItem, INativeAssetPin, ISourceReceipt } from '../src/asset-sources/import-types';
import { saveModelVersion, type IModelRow } from '../src/models/model-history';
const model=(version:string,current=true):ResolvedAsset=>{
 const base=tool('model-fixture').asset;
 const asset:ModelAsset={...base,kind:'model',compatibility:{},version,card:{id:'model-fixture',name:'Fixture model',descriptor:{description:'Source '+version,capability:'embedding',runtime:'remote-openai',model:'fixture-embedding',modelVersion:version,manifestSha256:null,verificationSha256:null,dimension:3,source:'custom'}},delivery:{type:'remote-api'}};
 return {asset,sha256:assetDigest(serializeAsset(asset)),path:'assets/model-fixture/'+version+'/asset.json',current};
};
const receipt=(record:ResolvedAsset,pin:INativeAssetPin):ISourceReceipt=>({repository:'ghost-raven1/neurocenter-assets',external_id:record.asset.id,asset_kind:'model',asset_version:record.asset.version,descriptor_sha256:record.sha256,source_commit:'a'.repeat(40),native_id:pin.id,native_version:pin.version,native_hash:pin.hash,descriptor:record.asset,blobs:[]});
describe('Model source snapshots preserve current native head and monotonic ordinals',()=>{
 it('Historical source v1 appends snapshot-only after headv2; next edit uses maxhistory+1',async()=>{
  const db=await databaseFixture();try{
   const adapter=new ModelAssetAdapter(db.pool),current=model('2.0.0');
   const publish=async(item:IImportItem)=>{const client=await db.pool.connect();try{await client.query('BEGIN');const result=await adapter.publish(item,actor,client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
   const first=await publish(await adapter.preview(current,randomUUID(),[]));expect(first.version).toBe(1);
   const before=(await db.pool.query('SELECT * FROM model_catalog')).rows[0],historical=await adapter.preview(model('1.0.0',false),randomUUID(),[],receipt(current,first));
   expect(historical).toMatchObject({action:'snapshot',preserveHead:true,native:{version:2}});await publish(historical);
   expect((await db.pool.query('SELECT * FROM model_catalog')).rows[0]).toEqual(before);
   const update=await adapter.preview(model('3.0.0'),randomUUID(),[],receipt(current,first));expect(update.native?.version).toBe(3);await publish(update);
   expect((await db.pool.query('SELECT revision FROM model_catalog')).rows[0].revision).toBe(3);
   expect((await db.pool.query('SELECT revision FROM model_catalog_versions ORDER BY revision')).rows.map(row=>row.revision)).toEqual([1,2,3]);
  }finally{await db.dispose();}
 });
 it('Concurrent historical write invalidates planned ordinal, strict version collision does not overwrite snapshot',async()=>{
  const db=await databaseFixture();try{
   const adapter=new ModelAssetAdapter(db.pool),current=model('2.0.0'),client=await db.pool.connect();
   try{
    await client.query('BEGIN');const first=await adapter.publish(await adapter.preview(current,randomUUID(),[]),actor,client);await client.query('COMMIT');
    const planned=await adapter.preview(model('1.0.0',false),randomUUID(),[],receipt(current,first));
    const head=(await db.pool.query<IModelRow>('SELECT * FROM model_catalog')).rows[0];await saveModelVersion(client,{...head,revision:2});
    await client.query('BEGIN');await expect(adapter.publish(planned,actor,client)).rejects.toMatchObject({status:409});await client.query('ROLLBACK');
    await expect(saveModelVersion(client,{...head,revision:2,name:'Different bytes'})).rejects.toMatchObject({status:409});
    expect((await db.pool.query('SELECT revision FROM model_catalog')).rows[0].revision).toBe(1);
   }finally{client.release();}
  }finally{await db.dispose();}
 });
});
