import {describe,expect,it} from 'vitest';
import {createLearningContext} from '../../shared/project-learning.cjs';
import {MEMORY_RECIPE,MEMORY_SYNC_LIMITS,memoryDigest,memoryNamespace,memoryRecipeSupported,normalizeMemorySyncContext,normalizeMemorySyncPayload,normalizeMemorySyncResult} from '../../shared/project-learning-memory-sync.cjs';
import {requiredJobFeatures} from '../../shared/feature-policy.cjs';

const context=createLearningContext({projectId:'project-fixture',revision:2,entries:[]});
const payload=normalizeMemorySyncPayload({schemaVersion:1,projectId:context.projectId,bindingId:'a'.repeat(64),instanceId:'11111111-1111-4111-8111-111111111111',assetId:'memory',version:2,manifest:'b'.repeat(64),learningRevision:context.revision,learningDigest:context.digest,mode:'sync'});
const pkg={schemaVersion:5,plugin:{id:'memory',kind:'mcp',version:2},manifest:{sha256:payload.manifest},config:{transport:'stdio',entrypoint:'entrypoint.mjs',args:[],extra:{learningMemory:MEMORY_RECIPE}}};
describe('Approved learning / installed Memory contract',()=>{
 it('accepts exact recipe+context and derives distinct site/project namespaces',()=>{
  expect(normalizeMemorySyncContext({schemaVersion:1,payload,context,package:pkg}).context).toEqual(context);
  expect(memoryNamespace('https://a.invalid','project')).not.toBe(memoryNamespace('https://b.invalid','project'));
  expect(memoryNamespace('https://a.invalid','project')).not.toBe(memoryNamespace('https://a.invalid','other'));
 });
 it.each(['version','manifest','source','extra'])('rejects an altered %s before the worker can read a graph',change=>{
  const value=structuredClone({schemaVersion:1,payload,context,package:pkg});
  if(change==='version')value.package.plugin.version++;
  if(change==='manifest')value.package.manifest.sha256='d'.repeat(64);
  if(change==='source')value.context.digest='d'.repeat(64);
  if(change==='extra')Object.assign(value.payload,{graphPath:'/private/graph'});
  expect(()=>normalizeMemorySyncContext(value)).toThrow();
 });
 it.each(['old','unknown','remote','args','env'])('does not infer trusted ABI from a display name or %s package',kind=>{
  const value=structuredClone(pkg) as any;if(kind==='old')delete value.config.extra.learningMemory;if(kind==='unknown')value.config.extra.learningMemory.version='2';if(kind==='remote')value.config.transport='remote';if(kind==='args')value.config.args=['--other'];if(kind==='env')value.config.env={MEMORY_FILE_PATH:'/other'};
  expect(memoryRecipeSupported(value)).toBe(false);
 });
 it('new sync is feature gated while owned cleanup remains available after OFF',()=>{
  expect(requiredJobFeatures('sync-learning-memory',{memoryMode:'sync'})).toEqual(['project_learning_memory']);
  expect(requiredJobFeatures('sync-learning-memory',{memoryMode:'cleanup'})).toEqual([]);
  expect(requiredJobFeatures('sync-learning-memory',{memory:{mode:'cleanup'}},true)).toEqual([]);
  expect(requiredJobFeatures('sync-learning-memory',{memory:{mode:'cleanup'}})).toEqual(['project_learning_memory']);
  expect(MEMORY_SYNC_LIMITS.concurrency).toBe(1);
 });
 it('public receipts reject graph or learned text, including an otherwise valid acknowledgement',()=>{
  const receipt={schemaVersion:1,protocol:'project-learning-memory-v1',projectId:payload.projectId,bindingId:payload.bindingId,instanceId:payload.instanceId,assetId:payload.assetId,manifest:payload.manifest,learningDigest:payload.learningDigest,mode:payload.mode,status:'complete',applied:0,removed:0,remaining:0,receiptDigest:memoryDigest('fixture'),code:'none'};
  expect(normalizeMemorySyncResult(receipt,payload)).toEqual(receipt);expect(()=>normalizeMemorySyncResult({...receipt,observations:['private']},payload)).toThrow();
 });
});
