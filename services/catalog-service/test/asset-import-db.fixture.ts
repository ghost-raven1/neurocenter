import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assetDigest, serializeAsset, type ResolvedAsset, type ToolAsset } from '@neurocenter/asset-contract';
import { setupProjectAssetPins } from '../src/catalog/project-asset-pins';
import { PluginRepository } from '../src/publication/plugin-repository';
import { setupSecurityEvents } from '../src/access/security-events';
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
/** Отдельная schema без public fallback: рабочие таблицы не читаются и не изменяются. */
export async function databaseFixture(){
 const connectionString=process.env.CATALOG_TEST_PG_URL||'postgresql://rag:rag@localhost:5432/catalog',admin=new Pool({connectionString,connectionTimeoutMillis:1500,max:1}),schema='asset_test_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE SCHEMA '+schema);const pool=new Pool({connectionString,options:'-c search_path='+schema,connectionTimeoutMillis:1500,max:8}),root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-asset-import-'));
 const dispose=async()=>{await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();await fs.rm(root,{recursive:true,force:true});};
 try{
  await pool.query(`CREATE TABLE projects(id text PRIMARY KEY,name text NOT NULL); CREATE TABLE platform_users(email text PRIMARY KEY,is_main_admin boolean NOT NULL,enabled boolean NOT NULL);
   CREATE TABLE project_assets(project_id text REFERENCES projects(id),asset_id text,asset_kind text,added_by text,added_at timestamptz DEFAULT now(),PRIMARY KEY(project_id,asset_id,asset_kind));
   CREATE TABLE ai_plugins(id text PRIMARY KEY,name text NOT NULL UNIQUE,kind text NOT NULL,description text NOT NULL,version integer NOT NULL,compatibility text,tags text[] NOT NULL,origin text NOT NULL,revision text,config jsonb,files jsonb,dependencies jsonb DEFAULT '[]',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
   CREATE TABLE ai_plugin_versions(ai_plugin_id text REFERENCES ai_plugins(id),version integer NOT NULL,files jsonb,config jsonb,author text,note text,metadata jsonb,created_at timestamptz DEFAULT now(),PRIMARY KEY(ai_plugin_id,version)); INSERT INTO platform_users VALUES('dev@localhost',true,true);`);
  await setupProjectAssetPins(pool);await setupSecurityEvents(pool);const plugins=new PluginRepository(pool);await plugins.setup();const jobs=new AssetImportRepository(pool),blobs=new AssetBlobStore(pool,path.join(root,'blobs')),sources=new AssetSourceSnapshots(pool,undefined);
  await blobs.setup();await jobs.setup();await sources.setup();
  const pin={schemaVersion:1 as const,repository:'ghost-raven1/neurocenter-assets' as const,commit:'a'.repeat(40),index:{path:'index.json',sha256:'b'.repeat(64)}};
  const snapshot=async(records:ResolvedAsset[],commit=pin.commit)=>{const index={schemaVersion:1,assets:records.map(({asset,sha256,path,current})=>({id:asset.id,version:asset.version,kind:asset.kind,sha256,path,current}))},source={...pin,commit};await pool.query('INSERT INTO asset_source_snapshots(commit,pin,index,assets) VALUES($1,$2,$3,$4) ON CONFLICT(commit) DO UPDATE SET pin=$2,index=$3,assets=$4',[commit,JSON.stringify(source),JSON.stringify(index),JSON.stringify(records)]);return source;};
  const runtime={importArchive:async()=>{throw new Error('Fixture не должна скачивать бинарники');}} as unknown as RuntimeArtifacts;
  return {pool,root,jobs,blobs,sources,plugins,pin,snapshot,worker:(skills?:SkillAssetAdapter)=>new AssetImportWorker(pool,jobs,sources,blobs,runtime,undefined,skills),dispose};
 }catch(error){await dispose();throw error;}
}
