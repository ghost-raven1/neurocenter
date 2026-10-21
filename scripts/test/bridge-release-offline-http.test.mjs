import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import path from 'node:path';
import {createRequire} from 'node:module';
import {startSkillPackagingFixture} from './skill-packaging.fixture.mjs';

const adminUrl=process.env.BRIDGE_RELEASE_TEST_ADMIN_URL,candidateDirectory=process.env.BRIDGE_RELEASE_CANDIDATE_DIR;
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const hashFile=async filename=>{const hash=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(filename)){hash.update(chunk);bytes+=chunk.length;}return{sha256:hash.digest('hex'),bytes};};

/** A release candidate is trusted as deployment configuration only in this disposable fixture. */
test('Offline bridge release imports through real Gateway APIs and serves exact native archives',{
 skip:!adminUrl||!candidateDirectory?'Set BRIDGE_RELEASE_TEST_ADMIN_URL and BRIDGE_RELEASE_CANDIDATE_DIR for an owned release-candidate fixture.':false,timeout:300_000,
},async t=>{
 const directory=path.resolve(candidateDirectory),report=JSON.parse(await fs.readFile(path.join(directory,'candidate.json'),'utf8'));
 const pin=JSON.parse(await fs.readFile(path.join(directory,'asset-source.candidate.lock.json'),'utf8'));
 assert.equal(report.candidate,true);assert.equal(report.published,false);assert.equal(report.forMainPin,false);assert.deepEqual(report.pin,pin);
 assert.equal(report.asset.id,'neurocenter-bridge');assert.deepEqual(report.artifacts.map(item=>item.target).sort(),['darwin-arm64','linux-x64']);
 assert.equal(path.basename(report.archive.filename),report.archive.filename);const archive=path.join(directory,report.archive.filename);
 const descriptorBytes=await fs.readFile(path.join(directory,'source','assets',report.asset.id,report.asset.version,'asset.json')),descriptor=JSON.parse(descriptorBytes);
 assert.equal(createHash('sha256').update(descriptorBytes).digest('hex'),report.asset.sha256);
 assert.deepEqual(await hashFile(archive),{sha256:report.archive.sha256,bytes:report.archive.bytes});
 const lock=new URL('../../services/shared/asset-source.lock.json',import.meta.url),lockBytes=await fs.readFile(lock);
 const upload=async(f,status=200)=>{
  const response=await fetch(f.gatewayUrl+'/api/asset-sources/archive',{method:'PUT',headers:{'content-type':'application/octet-stream','content-length':String(report.archive.bytes),'x-neurocenter-request':'1',origin:f.base,cookie:f.cookie('main')},
   body:Readable.toWeb(createReadStream(archive)),duplex:'half',signal:AbortSignal.timeout(120_000)});
  const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;
 };
 await t.test('An unpublished candidate does not bypass the current deployment trust pin',async()=>{
  const f=await startSkillPackagingFixture({adminUrl});
  try{await upload(f,409);assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM asset_source_snapshots')).rows[0].n,0);assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM asset_source_receipts')).rows[0].n,0);assert.deepEqual(f.state.externalCalls,[]);}
  finally{await f.close();}
 });
 const f=await startSkillPackagingFixture({adminUrl,configureCatalog(app){
  const {AssetSourcesService}=require('./dist/asset-sources/asset-sources.service.js');
  const {validateSourcePin}=require('./dist/asset-sources/source-client.js');
  // Mirrors an approved application's bundled pin, without writing any snapshot or publication receipt.
  app.get(AssetSourcesService).sources.initialPin=validateSourcePin(pin);
 }});t.after(()=>f.close());
 const terminal=async id=>{for(let attempt=0;attempt<1200;attempt++){const job=await f.request('main','/api/asset-imports/'+id);if(['SUCCEEDED','FAILED','NEEDS_INPUT','PARTIAL','CANCELLED'].includes(job.state))return job;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Bridge source import did not finish.');};
 const requestKey=randomUUID();let first;
 await t.test('The full archive is accepted without network access or implicit publication',async()=>{
  const view=await upload(f);assert.equal(view.source.commit,pin.commit);assert.equal(view.source.archiveSha256,report.archive.sha256);
  assert.equal(view.assets.find(asset=>asset.id===report.asset.id)?.supply.ready,true);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM asset_source_receipts')).rows[0].n,0);assert.deepEqual(f.state.externalCalls,[]);
 });
 await t.test('Ordinary selected import publishes one exact bridge version and both verified blobs',async()=>{
  first=await f.request('main','/api/asset-imports',{method:'POST',body:{requestKey,ids:[report.asset.id],commit:pin.commit},status:201});
  const job=await terminal(first.id);assert.equal(job.state,'SUCCEEDED',JSON.stringify(job));
  const rows=(await f.pool.query('SELECT * FROM asset_source_versions')).rows;assert.equal(rows.length,1);const row=rows[0];
  assert.equal(row.asset_kind,'bridge');assert.equal(row.external_id,report.asset.id);assert.equal(row.asset_version,report.asset.version);assert.equal(row.source_commit,pin.commit);assert.equal(row.descriptor_sha256,report.asset.sha256);assert.equal(row.descriptor.delivery.release.buildId,report.asset.buildId);
  assert.deepEqual(row.blobs.map(({target,sha256,bytes})=>({target,sha256,bytes})).sort((a,b)=>a.target.localeCompare(b.target)),report.artifacts.map(({target,sha256,bytes})=>({target,sha256,bytes})).sort((a,b)=>a.target.localeCompare(b.target)));
  assert.equal((await f.pool.query('SELECT cache_only FROM asset_source_jobs WHERE id=$1',[first.id])).rows[0].cache_only,true);assert.deepEqual(f.state.externalCalls,[]);
 });
 await t.test('Gateway provides the selected installer, metadata, checksums and actual bytes for both platforms',async()=>{
  const installer=await fetch(f.gatewayUrl+'/api/bridge/install.sh');assert.equal(installer.status,200);assert.match(installer.headers.get('content-type'),/text\/x-shellscript/);
  const script=await installer.text();assert.ok(script.includes(report.asset.version));assert.ok(script.includes(f.gatewayUrl+'/api/bridge'));assert.ok(!script.includes('__BRIDGE_VERSION__'));
  for(const artifact of report.artifacts){
   const base=f.gatewayUrl+'/api/bridge/runtime/'+artifact.filename;
   const checksum=await fetch(base+'.sha256');assert.equal(checksum.status,200);assert.equal((await checksum.text()).trim(),artifact.sha256);
   const metadata=await fetch(base+'.json');assert.equal(metadata.status,200);const value=await metadata.json();assert.equal(value.version,report.asset.version);assert.equal(value.buildId,report.asset.buildId);assert.equal(value.target,artifact.target);assert.equal(value.sha256,artifact.sha256);assert.equal(value.bytes,artifact.bytes);assert.deepEqual(value,descriptor.delivery.release.artifacts.find(item=>item.file===artifact.filename).metadata);
   const response=await fetch(base,{signal:AbortSignal.timeout(120_000)});assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),String(artifact.bytes));assert.match(response.headers.get('content-type'),/application\/gzip/);
   const hash=createHash('sha256');let bytes=0;for await(const chunk of response.body){hash.update(chunk);bytes+=chunk.length;}assert.equal(bytes,artifact.bytes);assert.equal(hash.digest('hex'),artifact.sha256);
  }
  const unsupported=await fetch(f.gatewayUrl+`/api/bridge/runtime/neurocenter-asset-sync-windows-x64-${report.asset.version}.tgz`);assert.equal(unsupported.status,404);await unsupported.body?.cancel();assert.deepEqual(f.state.externalCalls,[]);
 });
 await t.test('Replay remains idempotent, keeps native pins and never downloads unavailable upstream release files',async()=>{
  await upload(f);const replay=await f.request('main','/api/asset-imports',{method:'POST',body:{requestKey,ids:[report.asset.id],commit:pin.commit},status:201});assert.equal(replay.id,first.id);assert.equal((await terminal(replay.id)).state,'SUCCEEDED');
  const another=await f.request('main','/api/asset-imports',{method:'POST',body:{requestKey:randomUUID(),ids:[report.asset.id],commit:pin.commit},status:201});assert.equal((await terminal(another.id)).state,'SUCCEEDED');
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM asset_source_versions')).rows[0].n,1);assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM asset_source_receipts')).rows[0].n,1);assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM asset_source_blobs')).rows[0].n,2);assert.deepEqual(f.state.externalCalls,[]);
  assert.deepEqual(await fs.readFile(lock),lockBytes,'The real application pin must remain unchanged.');
 });
});
