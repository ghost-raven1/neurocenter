import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startSkillPackagingFixture} from './skill-packaging.fixture.mjs';
const adminUrl=process.env.STORE_ARCHIVE_TEST_ADMIN_URL;
test('Common tool archive through real Gateway/Catalog/Skills preserves project pins and history',{
 skip:!adminUrl?'Set isolated STORE_ARCHIVE_TEST_ADMIN_URL.':false,timeout:120000,
},async t=>{
 const f=await startSkillPackagingFixture({adminUrl});t.after(()=>f.close());const targets=[];
 for(const kind of ['mcp','plugin']){
  const card=await f.request('main','/api/ai-plugins',{method:'POST',status:201,body:{publicationKey:randomUUID(),kind,name:'QA archive '+kind,description:'QA common catalog archive',
   files:kind==='plugin'?[{path:'index.mjs',content:'export const QAPlugin = async () => ({})'}]:[],config:kind==='mcp'?{transport:'remote',url:'https://qa.example.test/mcp'}:{entrypoint:'index.mjs'}}});
  targets.push({kind,id:card.id});
 }
 await f.request('main','/api/skills',{method:'POST',status:201,body:{path:'common',slug:'qa-archive-skill',name:'QA archive skill',body:'Историческая инструкция.',meta:{description:'QA skill archive'}}});targets.push({kind:'skill',id:'common/qa-archive-skill'});
 const inspect=target=>f.request('main',target.kind==='skill'?'/api/skills/'+target.id:'/api/ai-plugins/'+target.id);
 const impact=target=>f.request('main','/api/asset-management/impact',{method:'POST',status:201,body:target});
 const apply=(preview,mode='catalog-only',status=201)=>f.request('main','/api/asset-management/archive',{method:'POST',status,body:{impactId:preview.impactId,expectedDigest:preview.digest,mode}});
 for(const target of targets)await f.request('main',`/api/projects/${f.projectId}/assets`,{method:'POST',status:201,body:{assetId:target.id,assetKind:target.kind}});
 for(const target of targets)await t.test(target.kind+': main admin chooses catalog-only or project removal; retries preserve immutable content',async()=>{
  await f.request('developer','/api/asset-management/impact',{method:'POST',status:403,body:target});
  const before=(await f.pool.query('SELECT * FROM project_assets WHERE asset_id=$1 AND asset_kind=$2',[target.id,target.kind])).rows;
  const versions=target.kind==='skill'?null:(await f.pool.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=$1 ORDER BY version',[target.id])).rows;
  const first=await impact(target);assert.ok(first.projects.some(project=>project.id===f.projectId));
  await f.request('main','/api/asset-management/archive',{method:'POST',status:409,body:{impactId:first.impactId,expectedDigest:'0'.repeat(64),mode:'catalog-only'}});
  const result=await apply(first);assert.equal(result.state,'SUCCEEDED');assert.equal((await apply(first)).id,result.id);
  assert.deepEqual((await f.pool.query('SELECT * FROM project_assets WHERE asset_id=$1 AND asset_kind=$2',[target.id,target.kind])).rows,before);
  if(versions)assert.deepEqual((await f.pool.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=$1 ORDER BY version',[target.id])).rows,versions);
  const card=await inspect(target);if(target.kind==='skill')assert.equal(card.body,'Историческая инструкция.');else assert.ok(card.archivedAt);
  const listed=target.kind==='skill'?await f.request('main','/api/skills'): (await f.request('main','/api/ai-plugins')).items;
  assert.equal(listed.some(item=>(target.kind==='skill'?item.path:item.id)===target.id),false);
  const restored=await apply(await impact(target),'restore');assert.equal(restored.state,'SUCCEEDED');
  assert.equal((await apply(await impact(target),'catalog-and-projects')).state,'SUCCEEDED');
  assert.equal((await f.pool.query('SELECT count(*) AS n FROM project_assets WHERE asset_id=$1 AND asset_kind=$2',[target.id,target.kind])).rows[0].n,'0');
  if(versions)assert.deepEqual((await f.pool.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=$1 ORDER BY version',[target.id])).rows,versions);
  else assert.equal((await inspect(target)).body,'Историческая инструкция.');
 });
 await t.test('A concurrent project-reference change rejects stale impact and exposes a fresh review instead',async()=>{
  const target=targets[0];await apply(await impact(target),'restore');const stale=await impact(target);
  await f.request('main',`/api/projects/${f.projectId}/assets`,{method:'POST',status:201,body:{assetId:target.id,assetKind:target.kind}});
  await apply(stale,'catalog-only',409);assert.equal(!!(await inspect(target)).archivedAt,false);
  assert.equal((await apply(await impact(target))).state,'SUCCEEDED');assert.equal((await f.pool.query('SELECT count(*) AS n FROM project_assets WHERE asset_id=$1',[target.id])).rows[0].n,'1');
 });
});
