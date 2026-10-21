import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assetDigest, serializeAsset, type ResolvedAsset, type ToolAsset } from '@neurocenter/asset-contract';
import { PluginRepository } from '../src/publication/plugin-repository';
import {ensureCatalogSchema} from '../src/database/catalog-schema';
import {migrateCatalog} from '../src/database/migrations';
import {CATALOG_MIGRATIONS} from '../src/database/catalog-migrations';
import { AssetImportRepository } from '../src/asset-sources/import-repository';
import { AssetBlobStore } from '../src/asset-sources/asset-blob-store';
import { AssetSourceSnapshots } from '../src/asset-sources/source-snapshots';
import { AssetImportWorker } from '../src/asset-sources/import-worker';
import type { SkillAssetAdapter } from '../src/asset-sources/skill-adapter';
import type { RuntimeArtifacts } from '../src/runtime-artifacts/runtime-artifacts';
export const actor='dev@localhost';
export function tool(id:string,version='1.0.0',dependencies:ToolAsset['dependencies']=[],current=true):ResolvedAsset {
 const asset:ToolAsset={schemaVersion:1,id,version,kind:'plugin',source:{type:'git',repository:'https://github.com/example/fixture',commit:'a'.repeat(40)},license:{spdx:'MIT'},compatibility:{packageFormat:5},card:{kind:'plugin',name:id,description:'Описание '+version,revision:version,origin:'upload',tags:[],files:[{path:'index.mjs',content:'export const fixture = async () => ({})'}],config:{entrypoint:'index.mjs'}},delivery:{type:'runtime-artifacts',artifacts:[]},...(dependencies.length?{dependencies}:{})};
 return {asset,sha256:assetDigest(serializeAsset(asset)),path:'assets/'+id+'/'+version+'/asset.json',current};
}
/** Every case owns a complete database, including migration journals and triggers. */
export async function databaseFixture(options:{beforeFinalize?:(pool:Pool)=>Promise<void>}={}){
 const url=new URL(process.env.TEST_ADMIN_PG_URL||process.env.CATALOG_TEST_PG_URL||'postgresql://rag:rag@localhost:5432/postgres');url.pathname='/postgres';
 const admin=new Pool({connectionString:url.href,connectionTimeoutMillis:1500,max:1}),database='nc_asset_test_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE DATABASE '+database);url.pathname='/'+database;
 const pool=new Pool({connectionString:url.href,connectionTimeoutMillis:1500,max:8}),root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-asset-import-'));
 const dispose=async()=>{await pool.end();await admin.query('DROP DATABASE '+database);await admin.end();await fs.rm(root,{recursive:true,force:true});};
 try{
  if(options.beforeFinalize){await migrateCatalog(pool,CATALOG_MIGRATIONS.slice(0,-1));await options.beforeFinalize(pool);}
  await ensureCatalogSchema(pool);
  await pool.query("INSERT INTO platform_users(email,is_main_admin,enabled) VALUES('dev@localhost',true,true)");
  const plugins=new PluginRepository(pool),jobs=new AssetImportRepository(pool),blobs=new AssetBlobStore(pool,path.join(root,'blobs')),sources=new AssetSourceSnapshots(pool,undefined);
  const pin={schemaVersion:1 as const,repository:'ghost-raven1/neurocenter-assets' as const,commit:'a'.repeat(40),index:{path:'index.json',sha256:'b'.repeat(64)}};
  const snapshot=async(records:ResolvedAsset[],commit=pin.commit)=>{const index={schemaVersion:1,assets:records.map(({asset,sha256,path,current})=>({id:asset.id,version:asset.version,kind:asset.kind,sha256,path,current}))},source={...pin,commit};await pool.query('INSERT INTO asset_source_snapshots(commit,pin,index,assets) VALUES($1,$2,$3,$4) ON CONFLICT(commit) DO UPDATE SET pin=$2,index=$3,assets=$4',[commit,JSON.stringify(source),JSON.stringify(index),JSON.stringify(records)]);return source;};
  const runtime={importArchive:async()=>{throw new Error('Fixture не должна скачивать бинарники');}} as unknown as RuntimeArtifacts;
  return {pool,root,jobs,blobs,sources,plugins,pin,snapshot,worker:(skills?:SkillAssetAdapter)=>new AssetImportWorker(pool,jobs,sources,blobs,runtime,undefined,skills),dispose};
 }catch(error){await dispose();throw error;}
}
