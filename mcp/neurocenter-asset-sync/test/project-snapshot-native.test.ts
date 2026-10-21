import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {captureProjectImage} from '../src/features/project-snapshot/capture.js';
import {allSnapshotTableNames} from '../src/features/project-snapshot/sdk.js';
import {snapshotCanonicalJson,snapshotSchemaHash} from '../src/features/project-snapshot/contract.js';
import {snapshotFixture,native} from './project-snapshot.fixture.js';

let fixture:Awaited<ReturnType<typeof snapshotFixture>>;
afterEach(async()=>{vi.unstubAllEnvs();if(fixture)await fs.rm(fixture.temporary,{recursive:true,force:true});});
describe('Native full LanceDB file image',()=>{
 it('captures all tables, extra fields, indices, empty schema and reconstructs a NEW readable database',async()=>{
  fixture=await snapshotFixture();const image=await captureProjectImage(fixture.root,fixture.input,async()=>{});
  try{
   expect(image.manifest.tables.map(t=>[t.name,t.rows])).toEqual([['chunks',503],['documents',1],['empty_table',0]]);
   expect(image.manifest.files.some(f=>f.path.includes('_indices/'))).toBe(true);
   expect(snapshotCanonicalJson(image.manifest)).not.toMatch(/FAKE_PRIVATE_RUNTIME_KEY|runtime-overrides|\/Users\//);
   const stage=path.join(fixture.temporary,'restored');await fs.mkdir(stage);
   const {materializeSnapshot}=await import('../../../scripts/snapshots/materialize.mjs');
   await materializeSnapshot(stage,{snapshotId:fixture.input.snapshotId,manifestSha256:image.manifestSha256,manifest:image.manifest},async(route:string)=>image.readChunk(route.split('/').at(-1)!),jobId);
   const imageId=process.env.NEUROCENTER_SNAPSHOT_TEST_VERIFIER_IMAGE;
   if(imageId){const {runSnapshotVerifier,snapshotVerifierImage}=await import('../../../scripts/snapshots/docker-verifier.mjs');const verified=await runSnapshotVerifier(stage,await snapshotVerifierImage(imageId));expect(verified).toMatchObject({manifestSha256:image.manifestSha256,sdkVersion:'0.29.0',readRows:504});expect(verified.tables).toEqual(image.manifest.tables);}
   const restored=await native.connect(path.join(stage,'database'),{manifestEnabled:false});
   try{expect((await restored.tableNames()).sort()).toEqual(['chunks','documents','empty_table']);
    for(const expected of image.manifest.tables){const table=await restored.openTable(expected.name);try{expect(await table.version()).toBe(expected.version);expect(await table.countRows()).toBe(expected.rows);expect(snapshotSchemaHash(await table.schema())).toBe(expected.schemaSha256);
     if(expected.name==='chunks'){expect(await table.listIndices()).toHaveLength(1);const row=(await table.query().where("id='row-502'").toArray())[0];expect(row.extra).toBe('preserved-502');expect(row.vector.toArray()).toEqual(new Float32Array([503,2,3,4,5,6,7]));}
     if(expected.name==='documents')expect((await table.query().toArray())[0].nested.author).toBe('Alex');
    }finally{table.close();}}
   }finally{restored.close();}
   await image.assertCurrent();
  }finally{await image.close();}
  await expect(fs.stat(path.join(fixture.store,'index.lock'))).rejects.toMatchObject({code:'ENOENT'});
 },120000);
 it.skipIf(!process.env.NEUROCENTER_RAG_PLUGIN_TEST_RUNTIME)('captures an actual managed OpenCodeRAG SDK store and restores its native semantic search',async()=>{
  fixture=await snapshotFixture(undefined,1);await fs.rm(fixture.store,{recursive:true});await fs.mkdir(fixture.store);
  const {createVectorStore}=createRequire(import.meta.url)(path.join(process.env.NEUROCENTER_RAG_PLUGIN_TEST_RUNTIME!,'upstream/dist/vectorstore/factory.js'));
  const config={vectorStore:{provider:'lancedb'}},managed=createVectorStore(config,fixture.store,3);try{await managed.addChunks([{id:'managed-row',content:'native full snapshot keeps semantic retrieval',embedding:[1,0.1,0.2],metadata:{filePath:path.join(fixture.root,'sample.ts'),startLine:1,endLine:1,language:'typescript'}}]);expect(await managed.count()).toBe(1);}finally{await managed.close();}
  await fs.mkdir(path.join(fixture.store,'eval-sessions'));await fs.writeFile(path.join(fixture.store,'eval-sessions','run.json'),'FAKE_PRIVATE_EVALUATION');
  const image=await captureProjectImage(fixture.root,fixture.input,async()=>{});try{expect(image.manifest.tables).toHaveLength(1);expect(image.manifest.tables[0]).toMatchObject({name:'chunks',rows:1});const stage=path.join(fixture.temporary,'restored-managed');await fs.mkdir(stage);
   const {materializeSnapshot}=await import('../../../scripts/snapshots/materialize.mjs');await materializeSnapshot(stage,{snapshotId:fixture.input.snapshotId,manifestSha256:image.manifestSha256,manifest:image.manifest},async(route:string)=>image.readChunk(route.split('/').at(-1)!),jobId);
   if(process.env.NEUROCENTER_SNAPSHOT_TEST_VERIFIER_IMAGE){const {snapshotVerifierImage,runSnapshotVerifier}=await import('../../../scripts/snapshots/docker-verifier.mjs');expect(await runSnapshotVerifier(stage,await snapshotVerifierImage(process.env.NEUROCENTER_SNAPSHOT_TEST_VERIFIER_IMAGE))).toMatchObject({manifestSha256:image.manifestSha256,readRows:1});}
   const restored=createVectorStore(config,path.join(stage,'database'),3);try{expect(await restored.count()).toBe(1);const found=await restored.search([1,0.1,0.2],3);expect(found[0].chunk.content).toContain('native full snapshot');}finally{await restored.close();}
   await image.assertCurrent();
  }finally{await image.close();}
 },120000);
 it('does not create or mutate source namespace metadata when SDK inspects a legacy physical store',async()=>{
  fixture=await snapshotFixture(undefined,1);await fs.rm(path.join(fixture.store,'__manifest'),{recursive:true});const image=await captureProjectImage(fixture.root,fixture.input,async()=>{});try{await image.assertCurrent();await expect(fs.stat(path.join(fixture.store,'__manifest'))).rejects.toMatchObject({code:'ENOENT'});}finally{await image.close();}
 });
 it.each(['table version','new table','raw bytes','binding','lock'])('rejects changed %s before completion and leaves source intact',async change=>{
  fixture=await snapshotFixture(undefined,2);const image=await captureProjectImage(fixture.root,fixture.input,async()=>{});
  try{if(change==='table version'||change==='new table'){const db=await native.connect(fixture.store);try{if(change==='new table')(await db.createTable('new_table',[{id:'new'}])).close();else{const table=await db.openTable('chunks');try{await table.add([{id:'changed',content:'new',extra:'new',score:42,vector:[1,2,3,4,5,6,7]}]);}finally{table.close();}}}finally{db.close();}}
   if(change==='raw bytes')await fs.writeFile(path.join(fixture.store,'chunks.lance','new-untracked-file'),'changed');
   if(change==='binding'){const file=path.join(fixture.root,'.opencode/neurocenter.json');const value=JSON.parse(await fs.readFile(file,'utf8'));await fs.writeFile(file,JSON.stringify({...value,instanceId:'99999999-9999-4999-8999-999999999999'}));}
   if(change==='lock')await fs.writeFile(path.join(fixture.store,'index.lock'),'{}');
   await expect(image.assertCurrent()).rejects.toThrow();expect(await fs.readFile(path.join(fixture.store,'runtime-overrides.json'),'utf8')).toContain('FAKE_PRIVATE_RUNTIME_KEY');
  }finally{await image.close();}
 });
 it('refuses zero tables rather than advertising a truncated empty snapshot',async()=>{
  fixture=await snapshotFixture(undefined,1);const db=await native.connect(fixture.store);try{for(const name of await db.tableNames())await db.dropTable(name);}finally{db.close();}
  await expect(captureProjectImage(fixture.root,fixture.input,async()=>{})).rejects.toThrow('нет таблиц');await expect(fs.stat(path.join(fixture.store,'index.lock'))).rejects.toMatchObject({code:'ENOENT'});
 });
 it.each(['child namespace','external catalog'])('refuses %s instead of dropping it from the portable image',async kind=>{
  fixture=await snapshotFixture(undefined,1);
  if(kind==='child namespace')await fs.mkdir(path.join(fixture.store,'child'));
  else{const copy=path.join(fixture.temporary,'catalog-edit');await fs.mkdir(copy);await fs.cp(path.join(fixture.store,'__manifest'),path.join(copy,'catalog.lance'),{recursive:true});const db=await native.connect(copy,{manifestEnabled:false});try{const table=await db.openTable('catalog');try{await table.add([{object_id:'outside',object_type:'table',location:'s3://must-not-read/table',metadata:null,base_objects:[]}]);}finally{table.close();}}finally{db.close();}await fs.rm(path.join(fixture.store,'__manifest'),{recursive:true});await fs.cp(path.join(copy,'catalog.lance'),path.join(fixture.store,'__manifest'),{recursive:true});}
  await expect(captureProjectImage(fixture.root,fixture.input,async()=>{})).rejects.toThrow();await expect(fs.stat(path.join(fixture.store,'index.lock'))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('paginates beyond one SDK table page and rejects a repeated or truncated page',async()=>{
  const names=Array.from({length:129},(_,i)=>'table_'+String(i).padStart(3,'0')),calls:unknown[]=[];
  expect(await allSnapshotTableNames({tableNames:async(options:any)=>{calls.push(options);const start=options.startAfter?names.indexOf(options.startAfter)+1:0;return names.slice(start,start+options.limit);}},async()=>{})).toEqual(names);
  expect(calls).toEqual([{limit:128},{limit:128,startAfter:'table_127'},{limit:128,startAfter:'table_128'}]);
  await expect(allSnapshotTableNames({tableNames:async()=>['same']},async()=>{})).rejects.toThrow();
 });
});
const jobId='55555555-5555-4555-8555-555555555555';
