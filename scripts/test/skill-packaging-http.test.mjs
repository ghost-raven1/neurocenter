import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {startSkillPackagingFixture} from './skill-packaging.fixture.mjs';

const adminUrl=process.env.SKILL_PACKAGING_TEST_ADMIN_URL;
const files=[
 {path:'SKILL.md',content:'---\nname: qa-packaging-skill\ndescription: Проверка полного цикла упаковки.\nlicense: MIT\n---\n\n# Проверка\n\nИспользуйте references/checklist.md и scripts/build/check.mjs.\n'},
 {path:'references/checklist.md',content:'Проверить результат и отрицательные сценарии.\n'},
 {path:'scripts/build/check.mjs',content:'export const check = true;\n'},
 {path:'assets/dist/reference.txt',content:'Не терять эту вложенную папку.\n'},
 {path:'assets/preview.png',content:Buffer.from('89504e470d0a1a0a0000ff80','hex').toString('base64'),encoding:'base64'},
];
const payload=()=>({requestKey:randomUUID(),kind:'skill',name:'QA: полный скилл',description:'Проверка полного цикла упаковки.',tags:[],source:{type:'files',files,entrypoint:'SKILL.md'}});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function completed(f,id){
 const deadline=Date.now()+30_000;
 while(Date.now()<deadline){const job=await f.request('main','/api/tool-builds/'+id);if(['SUCCEEDED','FAILED'].includes(job.state))return job;await wait(25);}
 throw Error('Skill packaging did not reach a durable terminal state.');
}

test('Skill packaging survives the native catalog, export, project, bridge and archive lifecycle',{
 skip:!adminUrl?'Set SKILL_PACKAGING_TEST_ADMIN_URL to a disposable PostgreSQL port.':false,timeout:120_000,
},async t=>{
 const f=await startSkillPackagingFixture({adminUrl});t.after(()=>f.close());
 const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
 const {validateAsset,serializeAsset,assetDigest}=require('@neurocenter/asset-contract');
 const {verifyPackage}=require('./dist/catalog/bundle-package.js');
 let input,job,asset,projectPackage;
 await t.test('Authentication and the active admin role protect both listing and packaging',async()=>{
  await f.request(null,'/api/asset-sources',{status:401});
  await f.request('developer','/api/asset-sources',{status:403});
  await f.request('developer','/api/tool-builds',{method:'POST',body:payload(),status:403});
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM tool_build_jobs')).rows[0].n,0);
 });
 await t.test('Invalid instructions and traversal fail before accepting a durable job',async()=>{
  for(const source of [
   {type:'files',entrypoint:'SKILL.md',files:[{path:'SKILL.md',content:'Без frontmatter'}]},
   {type:'files',entrypoint:'SKILL.md',files:[{path:'SKILL.md',content:'---\nname: INVALID NAME\n---\nInvalid slug'}]},
   {type:'files',entrypoint:'SKILL.md',files:[files[0],{path:'../secret.txt',content:'invalid'}]},
  ])await f.request('main','/api/tool-builds',{method:'POST',body:{...payload(),source},status:400});
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM tool_build_jobs')).rows[0].n,0);
 });
 await t.test('A skill with resources requires no executable or target platform and publishes once',async()=>{
  input=payload();const accepted=await f.request('main','/api/tool-builds',{method:'POST',body:input,status:201});
  job=await completed(f,accepted.id);assert.equal(job.state,'SUCCEEDED',job.error||job.message);
  assert.equal(job.result.kind,'skill');assert.equal(job.result.catalogId,'common/qa-packaging-skill');
  const repeat=await f.request('main','/api/tool-builds',{method:'POST',body:input,status:201});assert.equal(repeat.id,job.id);
  const card=await f.request('main','/api/skills/'+job.result.catalogId);assert.equal(card.meta.version,1);
  assert.deepEqual(card.resources.map(file=>file.path).sort(),files.slice(1).map(file=>file.path).sort());
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM asset_source_receipts')).rows[0].n,1);
  const recovered=await f.request('main','/api/tool-builds/requests/'+input.requestKey);assert.equal(recovered.result.catalogId,job.result.catalogId);
 });
 await t.test('The new SkillAsset exports without private paths and reimports without a duplicate native version',async()=>{
  asset=validateAsset(await f.request('main','/api/tool-builds/'+job.id+'/asset'));
  assert.equal(asset.kind,'skill');assert.equal(asset.card.slug,'qa-packaging-skill');assert.equal(asset.delivery.type,'inline');
  assert.equal(serializeAsset(asset).includes(f.temporary),false);
  const imported=await f.request('main','/api/tool-builds/imports',{method:'POST',body:{requestKey:randomUUID(),asset},status:201});
  assert.equal(imported.catalogId,job.result.catalogId);
  const after=await f.request('main','/api/skills/'+job.result.catalogId);assert.equal(after.meta.version,1);
 });
 await t.test('Lost native acknowledgement recovers through a new request without another skill version',async()=>{
  const recovery=payload();recovery.source.files=[{path:'SKILL.md',content:files[0].content.replaceAll('qa-packaging-skill','qa-recovery-skill')},...files.slice(1)];
  f.state.loseSkillPublishAck=1;
  const first=await f.request('main','/api/tool-builds',{method:'POST',body:recovery,status:201});
  assert.equal((await completed(f,first.id)).state,'FAILED');
  assert.equal((await f.request('main','/api/skills/common/qa-recovery-skill')).meta.version,1);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM asset_source_receipts WHERE external_id='skill-qa-recovery-skill'")).rows[0].n,0);
  const retry=await f.request('main','/api/tool-builds',{method:'POST',body:{...recovery,requestKey:randomUUID()},status:201});
  const result=await completed(f,retry.id);assert.equal(result.state,'SUCCEEDED',result.error||result.message);
  assert.equal(result.result.version,1);assert.equal((await f.request('main','/api/skills/common/qa-recovery-skill')).meta.version,1);
 });
 await t.test('An unrelated manual skill is never overwritten by packaging the same slug',async()=>{
  await f.request('main','/api/skills',{method:'POST',body:{path:'common',slug:'qa-manual-skill',name:'QA Manual Skill',body:'Оставить эту инструкцию.',meta:{description:'Ручная карточка.'}},status:201});
  const collision=payload();collision.source.files=[{path:'SKILL.md',content:files[0].content.replaceAll('qa-packaging-skill','qa-manual-skill')},...files.slice(1)];
  const accepted=await f.request('main','/api/tool-builds',{method:'POST',body:collision,status:201});assert.equal((await completed(f,accepted.id)).state,'FAILED');
  const card=await f.request('main','/api/skills/common/qa-manual-skill');assert.equal(card.body,'Оставить эту инструкцию.');assert.equal(card.meta.version,1);
 });
 await t.test('A real archive with two wrapper directories preserves the selected skill tree and binary bytes',async()=>{
  const root=path.join(f.temporary,'nested-archive'),skillRoot=path.join(root,'archive','outer','my-skill');await fs.mkdir(skillRoot,{recursive:true});
  await fs.writeFile(path.join(root,'archive','README.md'),'Описание внешней папки.');
  for(const file of files){const name=path.join(skillRoot,file.path);await fs.mkdir(path.dirname(name),{recursive:true});await fs.writeFile(name,Buffer.from(file.path==='SKILL.md'?file.content.replaceAll('qa-packaging-skill','qa-nested-skill'):file.content,file.encoding==='base64'?'base64':'utf8'));}
  const tar=require('tar'),archive=path.join(f.temporary,'nested-skill.tgz');await tar.c({cwd:root,file:archive,gzip:true,portable:true},['archive']);
  const decoded=await f.request('main','/api/tool-builds/archive',{method:'POST',body:{name:'nested-skill.tgz',contentBase64:(await fs.readFile(archive)).toString('base64')},status:201});
  const instruction=decoded.files.find(file=>/(?:^|\/)SKILL\.md$/.test(file.path));assert.ok(instruction);assert.ok(instruction.path.includes('/'));
  const accepted=await f.request('main','/api/tool-builds',{method:'POST',body:{...payload(),source:{type:'files',files:decoded.files,entrypoint:instruction.path}},status:201});
  const built=await completed(f,accepted.id);assert.equal(built.state,'SUCCEEDED',built.error||built.message);
  const card=await f.request('main','/api/skills/common/qa-nested-skill');
  assert.deepEqual(card.resources.map(file=>file.path).sort(),files.slice(1).map(file=>file.path).sort());
  const binary=card.resources.find(file=>file.path==='assets/preview.png');assert.equal(binary.encoding,'base64');assert.deepEqual(Buffer.from(binary.content,'base64'),Buffer.from(files.at(-1).content,'base64'));
 });
 await t.test('A complete downloadable supply retains the exact envelope and source snapshot',async()=>{
  const response=await fetch(f.gatewayUrl+'/api/tool-builds/'+job.id+'/supply',{headers:{cookie:f.cookie('main'),'x-neurocenter-request':'1',origin:f.base}});
  assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length>0);
  const tar=require('tar'),{Readable}=await import('node:stream'),contents=new Map(),reads=[];
  const parser=tar.t({onReadEntry(entry){const chunks=[];entry.on('data',chunk=>chunks.push(chunk));reads.push(new Promise((resolve,reject)=>{entry.on('end',()=>{contents.set(entry.path,Buffer.concat(chunks));resolve();});entry.on('error',reject);}));}});
  await new Promise((resolve,reject)=>{parser.on('end',resolve);parser.on('error',reject);Readable.from([bytes]).pipe(parser);});await Promise.all(reads);
  assert.equal(assetDigest(contents.get('asset.json')),assetDigest(serializeAsset(asset)));
  if(asset.source.type==='archive'){
   const source=contents.get('source/'+asset.source.sha256+'.source');assert.ok(source);assert.equal(source.length,asset.source.bytes);
   assert.equal(createHash('sha256').update(source).digest('hex'),asset.source.sha256);
  }
 });
 await t.test('Local assets remain available when the external source cannot refresh',async()=>{
  let view=await f.request('main','/api/asset-sources');assert.equal(view.source.verified,false);assert.equal(view.assets.length,0);
  const local=view.localAssets.find(value=>value.id===asset.id);assert.ok(local);assert.equal(local.imported.id,job.result.catalogId);assert.equal(local.imported.unavailable,false);
  const response=await fetch(f.gatewayUrl+'/api/asset-sources/refresh',{method:'POST',headers:{cookie:f.cookie('main'),'x-neurocenter-request':'1',origin:f.base}});assert.equal(response.status,503);
  view=await f.request('main','/api/asset-sources');assert.ok(view.localAssets.some(value=>value.id===asset.id));assert.ok(view.source.error);
 });
 await t.test('A native skill outage marks one card unavailable and recovers without losing local assets',async()=>{
  f.state.skillsAvailable=false;
  try{const view=await f.request('main','/api/asset-sources');assert.equal(view.localAssets.find(value=>value.id===asset.id).imported.unavailable,true);}
  finally{f.state.skillsAvailable=true;}
  assert.equal((await f.request('main','/api/asset-sources')).localAssets.find(value=>value.id===asset.id).imported.unavailable,false);
 });
 await t.test('A cached external source stays selectable offline and uses the same native skill contract',async()=>{
  const external=validateAsset({schemaVersion:1,id:'qa-external-skill',version:'1.0.0',kind:'skill',
   source:{type:'git',repository:'https://github.com/example/qa-skills',commit:'a'.repeat(40)},license:{spdx:'MIT'},compatibility:{packageFormat:5},
   card:{path:'common',slug:'qa-external-skill',name:'QA External Skill',body:'Источник проверен и закреплён.',meta:{description:'Сохранённый внешний ассет.'}},delivery:{type:'inline'}});
  const record={asset:external,sha256:assetDigest(serializeAsset(external)),path:'assets/qa-external-skill/1.0.0/asset.json',current:true};
  const index={schemaVersion:1,assets:[{id:external.id,version:external.version,kind:external.kind,path:record.path,sha256:record.sha256,current:true}]};
  const pin={schemaVersion:1,repository:'ghost-raven1/neurocenter-assets',commit:'a'.repeat(40),index:{path:'index.json',sha256:assetDigest(JSON.stringify(index)+'\n')}};
  await f.pool.query('INSERT INTO asset_source_snapshots(commit,pin,index,assets) VALUES($1,$2,$3,$4)',[pin.commit,JSON.stringify(pin),JSON.stringify(index),JSON.stringify([record])]);
  const accepted=await f.request('main','/api/asset-imports',{method:'POST',body:{requestKey:randomUUID(),ids:[external.id],commit:pin.commit},status:201});
  let result;const deadline=Date.now()+15_000;
  do{result=await f.request('main','/api/asset-imports/'+accepted.id);if(['SUCCEEDED','FAILED','PARTIAL','NEEDS_INPUT'].includes(result.state))break;await wait(25);}while(Date.now()<deadline);
  assert.equal(result.state,'SUCCEEDED',result.message);
  const view=await f.request('main','/api/asset-sources');assert.ok(view.localAssets.some(value=>value.id===asset.id));
  assert.equal(view.assets.find(value=>value.id===external.id).imported.id,'common/qa-external-skill');
 });
 await t.test('Project assignment preserves an exact verifiable package across later catalog edits',async()=>{
  const body={assetId:job.result.catalogId,assetKind:'skill'};
  await f.request('main','/api/projects/'+f.projectId+'/assets',{method:'POST',body,status:201});
  const row=(await f.pool.query('SELECT pin_snapshot FROM project_assets WHERE project_id=$1',[f.projectId])).rows[0];
  projectPackage=row.pin_snapshot.package;assert.equal(projectPackage.plugin.version,1);assert.equal(verifyPackage(projectPackage),true);
  await f.request('main','/api/skills/'+job.result.catalogId,{method:'PUT',body:{expectedVersion:1,body:'Обновлённая инструкция'},status:200});
  const old=(await f.pool.query('SELECT pin_snapshot FROM project_assets WHERE project_id=$1',[f.projectId])).rows[0].pin_snapshot.package;
  assert.equal(old.manifest.sha256,projectPackage.manifest.sha256);
 });
 await t.test('The real bridge installs all skill resources into an isolated project and uninstalls them',async()=>{
  const previous={NEUROCENTER_BRIDGE_HOME:process.env.NEUROCENTER_BRIDGE_HOME,NEUROCENTER_URL:process.env.NEUROCENTER_URL};
  process.env.NEUROCENTER_BRIDGE_HOME=path.join(f.temporary,'bridge-private');process.env.NEUROCENTER_URL=f.base;
  try{
   const projectRoot=path.join(f.temporary,'projects','Скилл с пробелами');await fs.mkdir(projectRoot,{recursive:true});
   const workspace=await import(pathToFileURL(path.resolve('mcp/neurocenter-asset-sync/dist/bridge/workspace.js')).href);
   const {install}=await import(pathToFileURL(path.resolve('mcp/neurocenter-asset-sync/dist/bridge/installer.js')).href);
   const {uninstall}=await import(pathToFileURL(path.resolve('mcp/neurocenter-asset-sync/dist/bridge/uninstaller.js')).href);
   await workspace.setRoot(path.dirname(projectRoot));await workspace.bindProject('qa-skill-packaging',path.basename(projectRoot));
   await install('qa-skill-packaging',projectPackage,async()=>{},async()=>{});
   const target=path.join(projectRoot,'.opencode/skills/qa-packaging-skill');
   assert.match(await fs.readFile(path.join(target,'SKILL.md'),'utf8'),/Проверка/);
   for(const file of files.slice(1))assert.deepEqual(await fs.readFile(path.join(target,file.path)),Buffer.from(file.content,file.encoding==='base64'?'base64':'utf8'));
   await uninstall('qa-skill-packaging',projectPackage,async()=>{},async()=>{});
   await assert.rejects(fs.stat(path.join(target,'SKILL.md')),{code:'ENOENT'});
  }finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
 });
 await t.test('Archive and restore retain project pins, local source history and source availability',async()=>{
  const impact=await f.request('main','/api/asset-management/impact',{method:'POST',body:{kind:'skill',id:job.result.catalogId},status:201});
  assert.ok(impact.projects.some(value=>value.id===f.projectId));
  const body={impactId:impact.impactId,expectedDigest:impact.digest,mode:'catalog-only'};
  assert.equal((await f.request('main','/api/asset-management/archive',{method:'POST',body,status:201})).state,'SUCCEEDED');
  assert.equal((await f.request('main','/api/asset-management/archive',{method:'POST',body,status:201})).state,'SUCCEEDED');
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM project_assets')).rows[0].n,1);
  let local=(await f.request('main','/api/asset-sources')).localAssets.find(value=>value.id===asset.id);assert.equal(local.imported.archived,true);
  const restore=await f.request('main','/api/asset-management/impact',{method:'POST',body:{kind:'skill',id:job.result.catalogId},status:201});
  assert.equal((await f.request('main','/api/asset-management/archive',{method:'POST',body:{impactId:restore.impactId,expectedDigest:restore.digest,mode:'restore'},status:201})).state,'SUCCEEDED');
  local=(await f.request('main','/api/asset-sources')).localAssets.find(value=>value.id===asset.id);assert.equal(local.imported.archived,false);
  assert.ok((await f.pool.query('SELECT count(*)::int n FROM asset_source_versions')).rows[0].n>=1);
 });
 await t.test('A GitHub file link packages the pinned skill and resources through Gateway into the native catalog',async()=>{
  const commit='b'.repeat(40),prefix='skills/qa-github-skill',api='https://api.github.com/repos/example/qa-skills';
  const instruction=files[0].content.replaceAll('qa-packaging-skill','qa-github-skill');
  f.state.github.set(api,{name:'qa-skills',private:false,default_branch:'main'});
  for(const ref of ['main',commit])f.state.github.set(api+'/commits/'+ref,{sha:commit});
  f.state.github.set(api+'/contents/'+prefix+'/SKILL.md?ref='+commit,{type:'file',encoding:'base64',content:Buffer.from(instruction).toString('base64'),size:Buffer.byteLength(instruction)});
  const root=path.join(f.temporary,'github-source'),tree='qa-skills-'+commit;
  for(const file of [{...files[0],content:instruction},...files.slice(1)]){
   const name=path.join(root,tree,prefix,file.path);await fs.mkdir(path.dirname(name),{recursive:true});
   await fs.writeFile(name,Buffer.from(file.content,file.encoding==='base64'?'base64':'utf8'));
  }
  const archive=path.join(f.temporary,'github-source.tgz');await require('tar').c({cwd:root,file:archive,gzip:true,portable:true},[tree]);
  f.state.github.set('https://codeload.github.com/example/qa-skills/tar.gz/'+commit,new Response(await fs.readFile(archive)));
  const link='https://github.com/example/qa-skills/blob/main/'+prefix+'/SKILL.md';
  const metadata=await f.request('main','/api/tool-builds/repository?'+new URLSearchParams({url:link}));
  assert.equal(metadata.recommendedKind,'skill');assert.equal(metadata.commit,commit);
  const source={type:'repository',url:metadata.url,ref:metadata.commit,entrypoint:metadata.entrypoint,...(metadata.subdirectory?{subdirectory:metadata.subdirectory}:{})};
  const accepted=await f.request('main','/api/tool-builds',{method:'POST',body:{...payload(),name:metadata.name,source},status:201});
  const built=await completed(f,accepted.id);assert.equal(built.state,'SUCCEEDED',built.error||built.message);
  const card=await f.request('main','/api/skills/common/qa-github-skill');
  assert.deepEqual(card.resources.map(value=>value.path).sort(),files.slice(1).map(value=>value.path).sort());
  assert.deepEqual(Buffer.from(card.resources.find(value=>value.path==='assets/preview.png').content,'base64'),Buffer.from(files.at(-1).content,'base64'));
  const exported=validateAsset(await f.request('main','/api/tool-builds/'+built.id+'/asset'));
  assert.deepEqual(exported.source,{type:'git',repository:'https://github.com/example/qa-skills',commit,path:prefix});
  assert.ok((await f.request('main','/api/asset-sources')).localAssets.some(value=>value.id===exported.id));
  const jobs=(await f.pool.query('SELECT count(*)::int n FROM tool_build_jobs')).rows[0].n;
  await f.request('main','/api/tool-builds/repository?'+new URLSearchParams({url:link.replace('SKILL.md','missing/SKILL.md')}),{status:400});
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM tool_build_jobs')).rows[0].n,jobs);
 });
});
