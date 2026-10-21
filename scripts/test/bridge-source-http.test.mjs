import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {startSkillPackagingFixture} from './skill-packaging.fixture.mjs';

const adminUrl=process.env.BRIDGE_SOURCE_TEST_ADMIN_URL;
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {validateAsset,serializeAsset,assetDigest}=require('@neurocenter/asset-contract');
const digest=value=>createHash('sha256').update(value).digest('hex');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Controlled upstream request did not start.')),10_000);})]);}finally{clearTimeout(timer);}}

/** Small opaque supply proves the server verifies bytes without executing upstream programs. */
function sourceFixture(f,{repository='qa-owner/bridge-assets',version='0.10.0',commit='a'.repeat(40),buildId=digest('bridge-build-'+version),history=[],supplyBytes}={}){
 const bytes=supplyBytes??Buffer.from('Synthetic bridge supply: '+version+' '+buildId),file='neurocenter-asset-sync-darwin-arm64-'+version+'.tgz';
 const url='https://github.com/'+repository,artifactUrl=url+'/releases/download/bridge-v'+version+'/'+file;
 const asset=validateAsset({schemaVersion:1,id:'neurocenter-bridge',kind:'bridge',version,license:{spdx:'MIT'},
  compatibility:{bridgeProtocol:2},source:{type:'release',repository:url,tag:'bridge-v'+version},
  card:{name:'QA Bridge',description:'Synthetic immutable bridge release.'},delivery:{type:'bridge-release',release:{schemaVersion:1,
   release:'bridge-v'+version,version,buildId,artifacts:[{file,url:artifactUrl,metadata:{version,buildId,target:'darwin-arm64',nodeVersion:'24.22.0',
    ragSupported:true,probeEngine:{file:'bin/opencode-probe',version:'1.0.0',sha256:digest('probe')},sha256:digest(bytes),bytes:bytes.length}}]}}});
 const path='assets/neurocenter-bridge/'+version+'/asset.json',descriptor=serializeAsset(asset);
 const index={schemaVersion:1,assets:[...history.map(previous=>({...previous.index.assets.find(entry=>entry.current),current:false})),
  {id:asset.id,kind:'bridge',version,path,sha256:assetDigest(descriptor),current:true}]};
 const api='https://api.github.com/repos/'+repository;
 const metadata={name:repository.split('/')[1],private:false,default_branch:'main'};
 f.state.github.set(api,metadata);
 f.state.github.set(api+'/commits/main',{sha:commit});
 f.state.github.set(api+'/git/ref/heads/main',{ref:'refs/heads/main',object:{type:'commit',sha:commit}});
 f.state.github.set('https://raw.githubusercontent.com/'+repository+'/'+commit+'/index.json',new Response(JSON.stringify(index)+'\n'));
 f.state.github.set('https://raw.githubusercontent.com/'+repository+'/'+commit+'/'+path,new Response(descriptor));
 for(const previous of history)f.state.github.set('https://raw.githubusercontent.com/'+repository+'/'+commit+'/'+previous.path,new Response(previous.descriptor));
 f.state.github.set(artifactUrl,new Response(bytes));
 return {url,repository,version,commit,buildId,asset,index,metadata,api,artifactUrl,bytes,path,descriptor};
}

async function terminal(f,id){
 const until=Date.now()+20_000;
 while(Date.now()<until){const job=await f.request('main','/api/asset-imports/'+id);if(['SUCCEEDED','FAILED','NEEDS_INPUT','PARTIAL','CANCELLED'].includes(job.state))return job;await wait(25);}
 throw Error('Bridge import did not reach a durable terminal state.');
}
const settings=(f,body,status=200)=>f.request('main','/api/bridge-source',{method:'PUT',body,status});
const check=(f,revision,status=200,force=false)=>f.request('main','/api/bridge-source/check',{method:'POST',body:{expectedRevision:revision,...(force?{force:true}:{})},status});
const selection=(view,extra={})=>({expectedRevision:view.revision,commit:view.available.repositoryCommit,assetId:view.available.assetId,requestKey:randomUUID(),...extra});

test('Configurable bridge sources keep checks, immutable imports and installed supply separate',{
 skip:!adminUrl?'Set BRIDGE_SOURCE_TEST_ADMIN_URL to an owned disposable PostgreSQL port.':false,timeout:150_000,
},async t=>{
 const f=await startSkillPackagingFixture({adminUrl}),releases=[];t.after(async()=>{for(const release of releases)release();await f.close();});
 let view,checked,imported;
 const first=sourceFixture(f);
 await t.test('Only authenticated users read status and only the main admin changes the source or imports',async()=>{
  await f.request(null,'/api/bridge-source',{status:401});
  view=await f.request('developer','/api/bridge-source');assert.equal(typeof view.revision,'number');
  await f.request('developer','/api/bridge-source',{method:'PUT',body:{url:first.url,expectedRevision:view.revision},status:403});
  await f.request('developer','/api/bridge-source/import',{method:'POST',body:{expectedRevision:view.revision,commit:first.commit,assetId:first.asset.id,requestKey:randomUUID()},status:403});
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM asset_source_jobs')).rows[0].n,0);
 });
 await t.test('Unsafe URLs fail before networking and settings use revision CAS',async()=>{
  const calls=f.state.externalCalls.length;
  for(const url of ['http://github.com/qa-owner/bridge-assets','https://localhost/qa-owner/bridge-assets','https://github.com.evil.test/qa-owner/bridge-assets',
   'https://token@github.com/qa-owner/bridge-assets','https://github.com/qa-owner/bridge-assets?token=secret',
   'https://github.com/qa-owner/bridge-assets/tree/main','https://github.com/qa-owner/bridge-assets/%2e%2e/secret']){
   await settings(f,{url,expectedRevision:view.revision},400);
  }
  assert.equal(f.state.externalCalls.length,calls);
  const previous=view;view=await settings(f,{url:first.url,expectedRevision:view.revision});
  assert.equal(view.url,first.url);assert.equal(view.revision,previous.revision+1);
  await settings(f,{url:'https://github.com/qa-owner/stale-writer',expectedRevision:previous.revision},409);
  assert.equal((await f.request('main','/api/bridge-source')).url,first.url);
 });
 await t.test('Checking downloads only metadata, pins commit and does not populate the general asset list or installer supply',async()=>{
  checked=await check(f,view.revision);
  assert.equal(checked.available.repositoryCommit,first.commit);assert.equal(checked.available.version,first.version);
  assert.equal(checked.available.buildId,first.buildId);assert.deepEqual(checked.available.targets,['darwin-arm64']);
  assert.equal(checked.imported,undefined);assert.ok(checked.checkedAt);
  assert.equal(f.state.externalCalls.includes(first.artifactUrl),false);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM asset_source_receipts')).rows[0].n,0);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM asset_source_blobs')).rows[0].n,0);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM asset_source_snapshots')).rows[0].n,0);
  assert.equal((await f.request(null,'/api/bridge/config')).origin,f.gatewayUrl);
  await f.request(null,'/api/bridge/install.sh',{status:404});
  const calls=f.state.externalCalls.length;
  assert.deepEqual((await check(f,view.revision)).available,checked.available);
  assert.deepEqual((await check(f,view.revision,200,true)).available,checked.available);
  const cacheDiagnostic=f.state.externalCalls.length===calls?'':JSON.stringify({hostNow:new Date().toISOString(),
   database:(await f.pool.query('SELECT now() db_now,attempted_at,checked_at,error FROM bridge_source_settings WHERE singleton')).rows[0]});
  assert.equal(f.state.externalCalls.length,calls,'Automatic cache and explicit cooldown should avoid duplicate upstream reads. '+cacheDiagnostic);
  await check(f,view.revision-1,409);
 });
 await t.test('Import selection must match the checked source and one request publishes one immutable native bridge receipt',async()=>{
  for(const override of [{commit:'f'.repeat(40)},{assetId:'different-bridge'},{expectedRevision:checked.revision-1}]){
   await f.request('main','/api/bridge-source/import',{method:'POST',body:selection(checked,override),status:409});
  }
  const intent=selection(checked),accepted=await f.request('main','/api/bridge-source/import',{method:'POST',body:intent,status:201});
  const result=await terminal(f,accepted.id);assert.equal(result.state,'SUCCEEDED',result.message);
  const repeat=await f.request('main','/api/bridge-source/import',{method:'POST',body:intent,status:201});assert.equal(repeat.id,accepted.id);
  assert.deepEqual(result.source,{repository:first.repository,commit:first.commit});
  const receipt=(await f.pool.query('SELECT * FROM asset_source_receipts WHERE asset_kind=$1',['bridge'])).rows[0];
  assert.equal(receipt.repository,first.repository);assert.equal(receipt.asset_version,first.version);assert.equal(receipt.source_commit,first.commit);
  assert.equal(assetDigest(serializeAsset(receipt.descriptor)),assetDigest(serializeAsset(first.asset)));
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM asset_source_versions WHERE asset_kind=$1',['bridge'])).rows[0].n,1);
  assert.equal(f.state.externalCalls.filter(url=>url===first.artifactUrl).length,1);
  imported=(await f.request('developer','/api/bridge-source')).imported;assert.equal(imported.version,first.version);
  const script=await f.request(null,'/api/bridge/install.sh');assert.ok(script.includes("VERSION='"+first.version+"'"));
  assert.ok(script.includes(f.gatewayUrl+'/api/bridge'));assert.equal(/raw\.githubusercontent\.com|api\.github\.com/.test(script),false);
  const supplied=await fetch(f.gatewayUrl+'/api/bridge/runtime/'+first.asset.delivery.release.artifacts[0].file);
  assert.equal(supplied.status,200);assert.deepEqual(Buffer.from(await supplied.arrayBuffer()),first.bytes);
 });
 await t.test('Concurrent checks share one request and changing source preserves the currently imported bridge',async()=>{
  const concurrent=sourceFixture(f,{repository:'qa-owner/concurrent-bridge',commit:'b'.repeat(40),version:'0.11.0'});
  view=await settings(f,{url:concurrent.url,expectedRevision:checked.revision});assert.equal(view.available,undefined);
  assert.deepEqual(view.imported,imported);
  let release,started;const entered=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  releases.push(release);
  f.state.github.set(concurrent.api,async()=>{started();await gate;return Response.json(concurrent.metadata);});
  const before=f.state.externalCalls.filter(url=>url===concurrent.api).length;
  const one=check(f,view.revision);await bounded(entered);
  const two=check(f,view.revision);await wait(30);release();
  const results=await Promise.all([one,two]);assert.deepEqual(results[0].available,results[1].available);
  assert.equal(f.state.externalCalls.filter(url=>url===concurrent.api).length,before+1);
  checked=results[0];
 });
 await t.test('A response from the former source cannot replace status after settings changed during its fetch',async()=>{
  const stale=sourceFixture(f,{repository:'qa-owner/stale-bridge',commit:'c'.repeat(40),version:'0.12.0'});
  view=await settings(f,{url:stale.url,expectedRevision:checked.revision});
  let release,started;const entered=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  releases.push(release);
  f.state.github.set(stale.api,async()=>{started();await gate;return Response.json(stale.metadata);});
  const checking=check(f,view.revision,409);await bounded(entered);
  const changed=sourceFixture(f,{repository:'qa-owner/replacement-bridge',commit:'d'.repeat(40),version:'0.13.0'});
  view=await settings(f,{url:changed.url,expectedRevision:view.revision});release();await checking;
  const current=await f.request('main','/api/bridge-source');assert.equal(current.url,changed.url);assert.equal(current.available,undefined);
  assert.deepEqual(current.imported,imported);
  checked=await check(f,current.revision);assert.equal(checked.available.repositoryCommit,changed.commit);
 });
 await t.test('Unavailable checks retain the last verified source timestamp and do not claim an import or an installed update',async()=>{
  const previous=checked;
  // This database belongs to the fixture; only the explicit-check cooldown is advanced.
  await f.pool.query("UPDATE bridge_source_settings SET attempted_at=now()-interval '16 seconds' WHERE singleton");
  f.state.github.set('https://api.github.com/repos/qa-owner/replacement-bridge',new Response('Unavailable',{status:503}));
  await check(f,previous.revision,503,true);
  checked=await f.request('main','/api/bridge-source');assert.ok(checked.error);
  assert.deepEqual(checked.available,previous.available);assert.equal(checked.checkedAt,previous.checkedAt);
  assert.deepEqual(checked.imported,imported);
 });
 await t.test('A different source cannot downgrade the served bridge or redefine the same installed version with another build',async()=>{
  const previousJobs=(await f.pool.query('SELECT count(*)::int n FROM asset_source_jobs')).rows[0].n;
  for(const [version,buildId,commit,supplyBytes]of [['0.9.99',digest('older-build'),'e'.repeat(40)],['0.10.0',digest('replacement-build'),'f'.repeat(40)],
   ['0.10.0',first.buildId,'5'.repeat(40),Buffer.from('Different archive reusing a previously trusted buildId.')]]){
   const other=sourceFixture(f,{repository:'qa-owner/conflict-'+commit[0],version,buildId,commit,supplyBytes});
   view=await settings(f,{url:other.url,expectedRevision:checked.revision});checked=await check(f,view.revision);
   await f.request('main','/api/bridge-source/import',{method:'POST',body:selection(checked),status:409});
   assert.deepEqual((await f.request('main','/api/bridge-source')).imported,imported);
  }
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM asset_source_jobs')).rows[0].n,previousJobs);
 });
 await t.test('A source change during binary import cannot activate the former source after publication',async()=>{
  const upgrade=sourceFixture(f,{repository:first.repository,version:'0.14.0',commit:'1'.repeat(40),history:[first]});
  view=await settings(f,{url:upgrade.url,expectedRevision:checked.revision});checked=await check(f,view.revision);
  let release,started;const entered=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  releases.push(release);
  f.state.github.set(upgrade.artifactUrl,async()=>{started();await gate;return new Response(upgrade.bytes);});
  const accepted=await f.request('main','/api/bridge-source/import',{method:'POST',body:selection(checked),status:201});
  try{
   await bounded(entered);
   const replacement=sourceFixture(f,{repository:'qa-owner/change-during-import',version:'0.15.0',commit:'2'.repeat(40)});
   view=await settings(f,{url:replacement.url,expectedRevision:checked.revision});
  }finally{release();}
  const result=await terminal(f,accepted.id);assert.notEqual(result.state,'SUCCEEDED');
  assert.deepEqual((await f.request('main','/api/bridge-source')).imported,imported);
  assert.equal((await f.pool.query('SELECT asset_version FROM asset_source_receipts WHERE repository=$1 AND external_id=$2',[first.repository,first.asset.id])).rows[0].asset_version,first.version);
  checked=await f.request('main','/api/bridge-source');
 });
 await t.test('Two current bridge identities and noncanonical bridge versions cannot become a selectable supply',async()=>{
  const ambiguous=sourceFixture(f,{repository:'qa-owner/ambiguous-bridge',version:'0.16.0',commit:'3'.repeat(40)});
  const second=structuredClone(ambiguous.asset);second.id='other-bridge';
  const descriptor=serializeAsset(validateAsset(second)),path='assets/other-bridge/0.16.0/asset.json';
  ambiguous.index.assets.push({id:second.id,kind:'bridge',version:second.version,path,sha256:assetDigest(descriptor),current:true});
  f.state.github.set('https://raw.githubusercontent.com/'+ambiguous.repository+'/'+ambiguous.commit+'/index.json',new Response(JSON.stringify(ambiguous.index)+'\n'));
  f.state.github.set('https://raw.githubusercontent.com/'+ambiguous.repository+'/'+ambiguous.commit+'/'+path,new Response(descriptor));
  view=await settings(f,{url:ambiguous.url,expectedRevision:checked.revision});await check(f,view.revision,409);
  assert.equal((await f.request('main','/api/bridge-source')).available,undefined);
  const malformed=sourceFixture(f,{repository:'qa-owner/prerelease-bridge',version:'0.17.0',commit:'4'.repeat(40)});
  const invalid=structuredClone(malformed.asset);invalid.version='0.17.0-beta.1';invalid.delivery.release.version=invalid.version;invalid.delivery.release.release='bridge-v'+invalid.version;
  const bytes=JSON.stringify(invalid)+'\n';malformed.index.assets[0].version=invalid.version;malformed.index.assets[0].sha256=assetDigest(bytes);
  f.state.github.set('https://raw.githubusercontent.com/'+malformed.repository+'/'+malformed.commit+'/index.json',new Response(JSON.stringify(malformed.index)+'\n'));
  f.state.github.set('https://raw.githubusercontent.com/'+malformed.repository+'/'+malformed.commit+'/'+malformed.path,new Response(bytes));
  view=await settings(f,{url:malformed.url,expectedRevision:view.revision});await check(f,view.revision,409);
  checked=await f.request('main','/api/bridge-source');assert.equal(checked.available,undefined);assert.deepEqual(checked.imported,imported);
  for(const [version,commit]of [['00.18.0','7'.repeat(40)],['9007199254740992.0.0','8'.repeat(40)]]){
   const noncanonical=sourceFixture(f,{repository:'qa-owner/noncanonical-'+commit[0],version,commit});
   view=await settings(f,{url:noncanonical.url,expectedRevision:checked.revision});await check(f,view.revision,409);
   checked=await f.request('main','/api/bridge-source');assert.equal(checked.available,undefined);assert.deepEqual(checked.imported,imported);
  }
 });
 await t.test('A newer fork with the same bridge identity requires explicit source replacement and preserves the old supply',async()=>{
  const newer=sourceFixture(f,{repository:'qa-owner/approved-upgrade',version:'0.20.0',commit:'6'.repeat(40)});
  view=await settings(f,{url:newer.url,expectedRevision:checked.revision});checked=await check(f,view.revision);
  const accepted=await f.request('main','/api/bridge-source/import',{method:'POST',body:selection(checked),status:201});
  const conflict=await terminal(f,accepted.id);assert.equal(conflict.state,'NEEDS_INPUT');assert.ok(conflict.items.some(item=>item.action==='conflict'&&item.replacement));
  assert.deepEqual((await f.request('main','/api/bridge-source')).imported,imported);
  assert.equal(f.state.externalCalls.includes(newer.artifactUrl),false);
  await f.request('main','/api/asset-imports/'+accepted.id+'/resolve',{method:'POST',body:{expectedDigest:conflict.planDigest},status:201});
  const complete=await terminal(f,accepted.id);assert.equal(complete.state,'SUCCEEDED',complete.message);
  const current=await f.request('main','/api/bridge-source');assert.equal(current.imported.version,newer.version);assert.equal(current.imported.repositoryCommit,newer.commit);
  const settingsRow=(await f.pool.query('SELECT installed_repository,installed_asset_id FROM bridge_source_settings WHERE singleton')).rows[0];
  assert.equal(settingsRow.installed_repository,newer.repository);assert.equal(settingsRow.installed_asset_id,newer.asset.id);
  const old=(await f.pool.query('SELECT descriptor FROM asset_source_versions WHERE repository=$1 AND external_id=$2 AND asset_version=$3',[first.repository,first.asset.id,first.version])).rows[0];
  assert.equal(assetDigest(serializeAsset(old.descriptor)),assetDigest(first.descriptor));
  const catalogSources=f.catalog.get(require('./dist/asset-sources/asset-sources.service.js').AssetSourcesService);
  const historic=await catalogSources.bridgeSupply(first.version);assert.equal(historic.sourceCommit,first.commit);
  assert.equal(historic.artifacts[0].sha256,digest(first.bytes));
  const oldResponse=await fetch(f.gatewayUrl+'/api/bridge/runtime/'+first.asset.delivery.release.artifacts[0].file);
  assert.equal(oldResponse.status,200);assert.deepEqual(Buffer.from(await oldResponse.arrayBuffer()),first.bytes);
  const newScript=await f.request(null,'/api/bridge/install.sh');assert.ok(newScript.includes("VERSION='"+newer.version+"'"));
 });
});
