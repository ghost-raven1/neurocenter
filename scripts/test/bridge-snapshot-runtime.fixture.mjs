import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

// Executed by the extracted archive's own Node; every module/native library comes from that archive.
const content=process.cwd(),temporary=path.resolve(process.argv[2]),require=createRequire(path.join(content,'package.json'));
const native=require('@lancedb/lancedb'),arrow=require('apache-arrow');
const load=name=>import(pathToFileURL(path.join(content,'dist',name)).href);
const {setRoot,bindProject,projectBindingId}=await load('bridge/workspace.js');
const {writeState,jobContext}=await load('bridge/state.js');
const {captureProjectImage}=await load('features/project-snapshot/capture.js');
const {snapshotSchemaHash}=await load('features/project-snapshot/contract.js');
const root=path.join(temporary,'project'),store=path.join(root,'.opencode/rag_db');await fs.mkdir(root,{recursive:true});
await setRoot(temporary);await bindProject('native-runtime-snapshot',path.basename(root));
const deviceId=randomUUID();await writeState('credentials',{token:'OWN_ISOLATED_SNAPSHOT_FIXTURE',deviceId,email:'snapshot-native@example.test'});
await fs.mkdir(store,{recursive:true});const original=await native.connect(store);
try{
 const table=await original.createTable('chunks',Array.from({length:513},(_,index)=>({id:'row-'+index,content:'日本語 и русский '+index,custom:'all-fields-'+index,score:index,vector:[index+1,2,3,4,5,6,7]})));
 try{await table.createIndex('score',{config:native.Index.btree()});}finally{table.close();}
 (await original.createTable('documents',[{name:'document',nested:{owner:'Alex',rank:7}}])).close();
 (await original.createEmptyTable('empty_table',new arrow.Schema([new arrow.Field('custom',new arrow.Utf8(),true)]))).close();
}finally{original.close();}
await fs.mkdir(path.join(store,'eval-sessions'));await fs.writeFile(path.join(store,'eval-sessions/private-history.json'),'PRIVATE_HISTORY_EXCLUDED');await fs.writeFile(path.join(store,'runtime-overrides.json'),'PRIVATE_RUNTIME_EXCLUDED');
const digest=async()=>{const hash=createHash('sha256');for(const file of(await fs.readdir(store,{recursive:true})).sort()){const filename=path.join(store,file);if((await fs.lstat(filename)).isFile()){hash.update(file+'\0');hash.update(await fs.readFile(filename));}}return hash.digest('hex');};
const before=await digest(),bindingId=await projectBindingId('native-runtime-snapshot'),image=await jobContext.run({id:randomUUID(),lease:randomUUID(),deviceId},()=>captureProjectImage(root,{projectId:'native-runtime-snapshot',bindingId,snapshotId:randomUUID(),snapshotProtocol:'project-snapshots-v1'},async()=>{}));
const restored=path.join(temporary,'restored');await fs.mkdir(restored);
try{
 assert.deepEqual(image.manifest.tables.map(table=>table.name),['chunks','documents','empty_table']);
 assert.equal(image.manifest.files.some(file=>/eval-sessions|runtime-overrides|__manifest/.test(file.path)),false);
 for(const file of image.manifest.files){const destination=path.join(restored,...file.path.split('/'));await fs.mkdir(path.dirname(destination),{recursive:true});const parts=[];for(const chunk of file.chunks)parts.push(await image.readChunk(chunk.sha256));const bytes=Buffer.concat(parts);assert.equal(bytes.length,file.size);assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);await fs.writeFile(destination,bytes);}
 await image.assertCurrent();
}finally{await image.close();}
assert.equal(await digest(),before);
const database=await native.connect(restored);
try{for(const expected of image.manifest.tables){const table=await database.openTable(expected.name);try{assert.equal(await table.countRows(),expected.rows);assert.equal(await table.version(),expected.version);assert.equal(snapshotSchemaHash(await table.schema()),expected.schemaSha256);
  if(expected.name==='chunks'){assert.equal(expected.rows,513);assert.equal((await table.query().where("id='row-512'").toArray())[0].custom,'all-fields-512');assert.equal((await table.search([1,2,3,4,5,6,7]).limit(1).toArray())[0].id,'row-0');assert.equal((await table.listIndices()).length,1);}
 }finally{table.close();}}}finally{database.close();}
assert.equal(await digest(),before);
console.log(JSON.stringify({tables:3,rows:514,allColumns:true,schemaVersions:true,indexPreserved:true,semanticSearch:true,sourceUnchanged:true,privateFilesExcluded:true}));
