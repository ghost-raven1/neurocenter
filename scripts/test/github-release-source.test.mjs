import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const {parseRepositoryUrl,validateRepositorySource,resolveRepositorySource}=createRequire(import.meta.url)('../../services/shared/repository-source.cjs');
const commit='a'.repeat(40),sha='b'.repeat(64);
const asset=name=>({id:name==='first.tar.gz'?11:12,name,size:100,state:'uploaded',digest:'sha256:'+sha,browser_download_url:'https://github.com/owner/repo/releases/download/v1/'+name});
function api({assets=[asset('first.tar.gz'),asset('second.zip')],id=10,sha:commitSha=commit,status}={}){
 const calls=[];
 const fetch=async value=>{const url=new URL(value);calls.push(url.pathname);
  if(status)return Response.json({}, {status});
  if(url.pathname==='/repos/owner/repo')return Response.json({name:'repo',private:false,default_branch:'main',description:'Ready release'});
  if(url.pathname==='/repos/owner/repo/releases/tags/v1')return Response.json({id,tag_name:'v1',draft:false,assets});
  if(url.pathname==='/repos/owner/repo/commits/v1')return Response.json({sha:commitSha});
  throw new Error('Unexpected URL '+value);
 };return {fetch,calls};
}
const inspection=async chosen=>({sha256:sha,entrypoint:'bin/server',candidates:['bin/server'],runtimeSource:{type:'runtime',adapter:'native',assets:{'darwin-arm64':{app:{url:chosen.url,sha256:sha,format:'tar.gz',entrypoint:'bin/server'}}}}});
test('Release tag/latest/download URLs normalize into the existing repository source',()=>{
 assert.deepEqual(parseRepositoryUrl('https://github.com/Owner/Repo/releases/tag/v1').release,{tag:'v1'});
 assert.deepEqual(parseRepositoryUrl('https://github.com/owner/repo/releases/latest').release,{tag:'latest'});
 assert.deepEqual(validateRepositorySource({type:'repository',url:'https://github.com/owner/repo/releases/download/v1/first.tar.gz'},{pinned:false}),{type:'repository',url:'https://github.com/owner/repo',release:{tag:'v1',asset:'first.tar.gz'}});
 assert.throws(()=>validateRepositorySource({type:'repository',url:'https://github.com/owner/repo/releases/tag/v1',release:{tag:'v2'}},{pinned:false}),/не совпадают/);
});
test('Multiple release files remain unselected and cannot trigger a download implicitly',async()=>{
 const fixture=api();let calls=0;
 const metadata=await resolveRepositorySource({url:'https://github.com/owner/repo/releases/tag/v1'},{fetch:fixture.fetch,inspectAsset:async()=>{calls++;throw new Error('Must select first');}});
 assert.equal(calls,0);assert.equal(metadata.entrypoint,'');assert.equal(metadata.requiresReleaseChoice,true);assert.equal(metadata.releaseChoices.length,2);
});
test('Direct download pins release identity, asset identity, commit and inspected SHA into one source',async()=>{
 const fixture=api();const metadata=await resolveRepositorySource({url:'https://github.com/owner/repo/releases/download/v1/first.tar.gz'},{fetch:fixture.fetch,inspectAsset:inspection});
 assert.deepEqual(metadata.release,{tag:'v1',id:10,asset:'first.tar.gz',assetId:11,sha256:sha});
 const pinned=validateRepositorySource({type:'repository',url:metadata.url,commit:metadata.commit,entrypoint:metadata.entrypoint,release:metadata.release,runtimeSource:metadata.runtimeSource});
 assert.equal(pinned.entrypoint,'bin/server');assert.equal(pinned.runtimeSource.assets['darwin-arm64'].app.sha256,sha);
 const altered=structuredClone(pinned);altered.runtimeSource.assets['darwin-arm64'].app.url='https://example.com/other.tar.gz';assert.throws(()=>validateRepositorySource(altered),/не совпадает/);
});
test('Replacement of release, asset, commit or SHA cannot silently alter exact metadata retry',async()=>{
 const input={url:'https://github.com/owner/repo',ref:commit,release:{tag:'v1',id:10,asset:'first.tar.gz',assetId:11,sha256:sha}};
 for(const change of [{id:99},{sha:'c'.repeat(40)},{assets:[{...asset('first.tar.gz'),id:99}]},{assets:[{...asset('first.tar.gz'),digest:'sha256:'+'c'.repeat(64)}]}]){
  const fixture=api(change);await assert.rejects(resolveRepositorySource(input,{fetch:fixture.fetch,inspectAsset:inspection}),/изменился|заменён/);
 }
 for(const status of [404,429]){const fixture=api({status});await assert.rejects(resolveRepositorySource(input,{fetch:fixture.fetch,inspectAsset:inspection}),status===429?/ограничил/:/не найдены/);}
});
test('Interrupted GitHub response releases reader and remains retryable',async()=>{
 const response=new Response(new ReadableStream({start(controller){controller.error(new Error('Disconnected'));}}));
 await assert.rejects(resolveRepositorySource({url:'https://github.com/owner/repo'},{fetch:async()=>response}));
 assert.equal(response.body.locked,false);
});
