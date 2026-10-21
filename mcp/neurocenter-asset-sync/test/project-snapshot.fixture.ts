import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {vi} from 'vitest';
import {setRoot,bindProject,projectBindingId} from '../src/bridge/workspace.js';
import {writeState,jobContext} from '../src/bridge/state.js';

export const native=createRequire(import.meta.url)('@lancedb/lancedb') as typeof import('@lancedb/lancedb');
export const arrow=createRequire(import.meta.url)('apache-arrow') as typeof import('apache-arrow');
export const job={id:'22222222-2222-4222-8222-222222222222',lease:'33333333-3333-4333-8333-333333333333',deviceId:'44444444-4444-4444-8444-444444444444'};
/** The only paths and credentials used by full-image acceptance belong to this disposable fixture. */
export async function snapshotFixture(url='http://example.test',rows=503){
 const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-full-snapshot-'))),root=path.join(temporary,'project');
 vi.stubEnv('NEUROCENTER_BRIDGE_HOME',path.join(temporary,'private'));vi.stubEnv('NEUROCENTER_URL',url);
 await fs.mkdir(root);await setRoot(temporary);await bindProject('snapshot-test',path.basename(root));
 await writeState('credentials',{token:'FAKE_SNAPSHOT_DEVICE_TOKEN',deviceId:job.deviceId,email:'snapshot@example.test'});
 const store=path.join(root,'.opencode','rag_db');await fs.mkdir(store,{recursive:true});const database=await native.connect(store);
 try{
  const chunks=await database.createTable('chunks',Array.from({length:rows},(_,i)=>({id:'row-'+i,content:'日本語 и русский '+i,extra:'preserved-'+i,score:i,vector:[i+1,2,3,4,5,6,7]})));
  try{await chunks.createIndex('score',{config:native.Index.btree()});}finally{chunks.close();}
  (await database.createTable('documents',[{name:'all-fields',metadata:'PRIVATE_SHOULD_BE_PUBLIC_DATA',nested:{author:'Alex',rank:7}}])).close();
  (await database.createEmptyTable('empty_table',new arrow.Schema([new arrow.Field('custom',new arrow.Utf8(),true)]))).close();
 }finally{database.close();}
 await fs.writeFile(path.join(store,'runtime-overrides.json'),JSON.stringify({secret:'FAKE_PRIVATE_RUNTIME_KEY'}));
 return {temporary,root,store,input:{projectId:'snapshot-test',bindingId:await projectBindingId('snapshot-test'),snapshotId:randomUUID(),snapshotProtocol:'project-snapshots-v1' as const},
  run:<T>(fn:()=>Promise<T>)=>jobContext.run(job,fn)};
}
