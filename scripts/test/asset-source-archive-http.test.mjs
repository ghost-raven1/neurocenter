import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {startSkillPackagingFixture} from './skill-packaging.fixture.mjs';
import {artifactFixture} from './runtime-artifact-fixture.cjs';

const adminUrl=process.env.ASSET_ARCHIVE_TEST_ADMIN_URL;
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {validateAsset,serializeAsset,assetDigest}=require('@neurocenter/asset-contract');

function supplyFixture(){
 const runtime=artifactFixture([{path:'runtime/plugin.mjs',content:'export const archivePlugin = async () => ({})'}]);
 const base={schemaVersion:1,version:'1.0.0',source:{type:'git',repository:'https://github.com/example/archive-fixture',commit:'a'.repeat(40)},license:{spdx:'MIT'},compatibility:{packageFormat:5}};
 const plugin=validateAsset({...base,id:'archive-runtime',kind:'plugin',card:{kind:'plugin',name:'Archive runtime',description:'Native runtime from an offline source archive.',revision:'1.0.0',origin:'upload',tags:[],files:[],config:{entrypoint:runtime.descriptor.entrypoint}},
  delivery:{type:'runtime-artifacts',artifacts:[{url:'https://github.com/example/archive-fixture/releases/download/v1/plugin.tgz',descriptor:runtime.descriptor}]}});
 const skill=validateAsset({...base,id:'archive-guide',kind:'skill',card:{path:'common',slug:'archive-guide',name:'Archive guide',body:'# Offline source guide\n',meta:{description:'A complete inline guide.'}},delivery:{type:'inline'}});
 const dependent=validateAsset({...base,id:'archive-dependent',kind:'plugin',card:{kind:'plugin',name:'Archive dependent',description:'Requires the exact offline runtime.',revision:'1.0.0',origin:'upload',tags:[],files:[{path:'index.mjs',content:'export const dependent = async () => ({})'}],config:{entrypoint:'index.mjs'}},delivery:{type:'runtime-artifacts',artifacts:[]},
  dependencies:[{id:plugin.id,version:plugin.version,sha256:assetDigest(serializeAsset(plugin))}]});
 const records=[plugin,skill,dependent].map(asset=>({asset,sha256:assetDigest(serializeAsset(asset)),path:`assets/${asset.id}/${asset.version}/asset.json`,current:true}));
 const index={schemaVersion:1,assets:records.map(({asset,sha256,path,current})=>({id:asset.id,kind:asset.kind,version:asset.version,sha256,path,current}))},indexBytes=JSON.stringify(index)+'\n';
 const pin={schemaVersion:1,repository:'ghost-raven1/neurocenter-assets',commit:'b'.repeat(40),index:{path:'index.json',sha256:assetDigest(indexBytes)}};
 const files=[{path:'repository/index.json',content:indexBytes},...records.map(record=>({path:'repository/'+record.path,content:serializeAsset(record.asset)}))];
 const cache=[{path:'.asset-source-metadata/'+pin.index.sha256+'.json',content:indexBytes},...records.map(record=>({path:'.asset-source-metadata/'+record.sha256+'.json',content:serializeAsset(record.asset)})),
  {path:'.asset-source-blobs/'+runtime.descriptor.sha256+'.blob',content:runtime.archive}];
 return {runtime,records,index,pin,files,cache};
}

test('Repository and offline supply archives flow through Gateway, preserve pins and never fetch missing release files',{
 skip:!adminUrl?'Set ASSET_ARCHIVE_TEST_ADMIN_URL to an owned disposable PostgreSQL port.':false,timeout:120_000,
},async t=>{
 const f=await startSkillPackagingFixture({adminUrl}),s=supplyFixture();t.after(()=>f.close());
 await f.pool.query('INSERT INTO asset_source_snapshots(commit,pin,index,assets) VALUES($1,$2,$3,$4)',[s.pin.commit,JSON.stringify(s.pin),JSON.stringify(s.index),JSON.stringify(s.records)]);
 const upload=async(bytes,key='main',status=200,media='application/octet-stream')=>{
  const response=await fetch(f.gatewayUrl+'/api/asset-sources/archive',{method:'PUT',headers:{'content-type':media,'x-neurocenter-request':'1',origin:f.base,...(key?{cookie:f.cookie(key)}:{})},body:bytes});
  const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;
 };
 const terminal=async id=>{for(let i=0;i<600;i++){const job=await f.request('main','/api/asset-imports/'+id);if(['SUCCEEDED','FAILED','NEEDS_INPUT','PARTIAL','CANCELLED'].includes(job.state))return job;await new Promise(r=>setTimeout(r,25));}throw Error('Archive import did not finish.');};
 const start=async(ids,requestKey=randomUUID())=>f.request('main','/api/asset-imports',{method:'POST',body:{requestKey,ids,commit:s.pin.commit},status:201});
 const archive=artifactFixture(s.files).archive;
 await t.test('Authentication, role and media are checked before importing archive data',async()=>{
  await upload(archive,null,401);await upload(archive,'developer',403);await upload(archive,'main',415,'application/json');
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM asset_source_jobs')).rows[0].n,0);
 });
 let list,missing;
 await t.test('A wrapped repository archive loads inline cards and reports missing exact runtime dependencies',async()=>{
  list=await upload(archive);assert.equal(list.source.archiveSha256,assetDigest(archive));assert.equal(list.source.commit,s.pin.commit);
  assert.equal(list.assets.find(asset=>asset.id==='archive-guide').supply.ready,true);
  for(const id of ['archive-runtime','archive-dependent']){const supply=list.assets.find(asset=>asset.id===id).supply;assert.equal(supply.ready,false);assert.equal(supply.missingFiles,1);assert.equal(supply.missingBytes,s.runtime.archive.length);}
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM ai_plugins')).rows[0].n,0);assert.deepEqual(f.state.externalCalls,[]);
 });
 await t.test('Inline skill imports through the ordinary queue; a forged missing-file selection stays cache-only',async()=>{
  assert.equal((await terminal((await start(['archive-guide'])).id)).state,'SUCCEEDED');
  missing=await start(['archive-dependent']);const job=await terminal(missing.id);assert.equal(job.state,'NEEDS_INPUT',JSON.stringify(job));
  assert.equal((await f.pool.query('SELECT cache_only FROM asset_source_jobs WHERE id=$1',[missing.id])).rows[0].cache_only,true);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM ai_plugins')).rows[0].n,0);assert.deepEqual(f.state.externalCalls,[]);
 });
 await t.test('Unknown index, bad SHA and traversal are rejected without replacing the accepted source',async()=>{
  const invalid=[...s.files];invalid[0]={...invalid[0],content:invalid[0].content+' '};await upload(artifactFixture(invalid).archive,'main',409);
  const broken=s.files.map(file=>file.path.endsWith('/archive-guide/1.0.0/asset.json')?{...file,content:'{}'}:file);await upload(artifactFixture(broken).archive,'main',409);
  await upload(artifactFixture([...s.files,{path:'repository/../escape',content:'no'}]).archive,'main',400);
  assert.equal((await f.request('main','/api/asset-sources')).source.archiveSha256,assetDigest(archive));assert.deepEqual(f.state.externalCalls,[]);
 });
 await t.test('A complete SHA-cache archive supplies native runtime bytes and retries the same durable job',async()=>{
  list=await upload(artifactFixture(s.cache).archive);assert.ok(list.assets.every(asset=>asset.supply.ready));
  await f.request('main','/api/asset-imports/'+missing.id+'/retry',{method:'POST',status:201});assert.equal((await terminal(missing.id)).state,'SUCCEEDED');
  const receipts=(await f.pool.query("SELECT external_id,source_commit FROM asset_source_receipts WHERE asset_kind='plugin' ORDER BY external_id")).rows;
  assert.deepEqual(receipts.map(row=>row.external_id),['archive-dependent','archive-runtime']);assert.ok(receipts.every(row=>row.source_commit===s.pin.commit));
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM bridge_runtime_artifacts')).rows[0].n,1);assert.deepEqual(f.state.externalCalls,[]);
 });
 await t.test('Repeated upload and request preserve immutable native versions and archive origin',async()=>{
  const before=Number((await f.pool.query('SELECT count(*)::int AS n FROM asset_source_versions')).rows[0].n),bytes=artifactFixture(s.cache).archive;
  await upload(bytes);const requestKey=randomUUID(),first=await start(['archive-dependent'],requestKey),second=await start(['archive-dependent'],requestKey);assert.equal(first.id,second.id);assert.equal((await terminal(first.id)).state,'SUCCEEDED');
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM asset_source_versions')).rows[0].n,before);assert.equal((await f.request('main','/api/asset-sources')).source.archiveSha256,assetDigest(bytes));assert.deepEqual(f.state.externalCalls,[]);
 });
});
