import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hash,readState} from '../src/bridge/state.js';
import * as privateStore from '../src/features/local-configuration/private-store.js';
import {acknowledgeMemoryCheckpoint,journalKey,projectionStorage,publicMemoryResult,recoverMemoryCompletions,saveMemoryCheckpoint} from '../src/features/project-learning-memory-sync/receipts.js';
import {memoryDigest,memoryNamespace,normalizeMemorySyncPayload} from '../src/features/project-learning-memory-sync/contract.js';
import type {Completion} from '../src/bridge/completions.js';

const site='https://fixture.invalid',namespace=memoryNamespace(site,'project-fixture');
const payload=normalizeMemorySyncPayload({schemaVersion:1,projectId:'project-fixture',bindingId:'a'.repeat(64),instanceId:'11111111-1111-4111-8111-111111111111',assetId:'memory',version:2,manifest:'b'.repeat(64),learningRevision:1,learningDigest:'c'.repeat(64),mode:'sync'});
const pending={id:'22222222-2222-4222-8222-222222222222',lease:'33333333-3333-4333-8333-333333333333',deviceId:'44444444-4444-4444-8444-444444444444',payload,
 result:publicMemoryResult(payload,memoryDigest('plan'),{applied:0,removed:0,remaining:1},false,'unavailable')};
let root:string;
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-memory-receipts-'));vi.stubEnv('NEUROCENTER_BRIDGE_HOME',root);});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(root,{recursive:true,force:true});});
describe('Private journal and public checkpoint recovery',()=>{
 it('a crash gap between public pointer and private checkpoint remains reportable without executing Memory',async()=>{
  vi.spyOn(privateStore,'writePrivateConfiguration').mockRejectedValueOnce(new Error('simulated storage crash'));
  await expect(saveMemoryCheckpoint(pending)).rejects.toThrow('storage crash');
  const delivered:Completion[]=[];await recoverMemoryCompletions(async value=>{delivered.push(value);});
  expect(delivered).toHaveLength(1);expect(delivered[0]).toMatchObject({id:pending.id,lease:pending.lease,state:'failed',result:pending.result});
 });
 it('lost delivery ACK repeats only the public completed receipt; ACK retains ownership for later revocation',async()=>{
  const storage=await projectionStorage(journalKey(site,payload),namespace),name=namespace+'approved';
  storage.journal.owned[name]={name,entityType:'neurocenter.approved-project-knowledge.v1',observations:['approved private fixture text']};await storage.save(storage.journal);
  await saveMemoryCheckpoint(pending);const completed={...pending,result:publicMemoryResult(payload,memoryDigest('plan'),{applied:1,removed:0,remaining:0},true,'none')};await saveMemoryCheckpoint(completed);
  const delivered:Completion[]=[];const deliver=async(value:Completion)=>{delivered.push(value);};await recoverMemoryCompletions(deliver);await recoverMemoryCompletions(deliver);
  expect(delivered).toHaveLength(2);expect(delivered[0]).toEqual(delivered[1]);expect(delivered[0]).toMatchObject({state:'succeeded',result:completed.result});
  expect(JSON.stringify(await readState('learning-memory-pending'))).not.toContain('approved private fixture text');expect(JSON.stringify(delivered)).not.toContain('approved private fixture text');
  await acknowledgeMemoryCheckpoint(pending.id);await acknowledgeMemoryCheckpoint(pending.id);await recoverMemoryCompletions(deliver);expect(delivered).toHaveLength(2);
  expect((await projectionStorage(journalKey(site,payload),namespace)).journal.owned[name].observations).toEqual(['approved private fixture text']);
 });
 it('two snapshot writers cannot overwrite each other ownership changes',async()=>{
  const key=journalKey(site,payload),first=await projectionStorage(key,namespace),second=await projectionStorage(key,namespace),name=namespace+'approved';
  first.journal.owned[name]={name,entityType:'neurocenter.approved-project-knowledge.v1',observations:['approved']};await first.save(first.journal);
  await expect(second.save(second.journal)).rejects.toThrow('другом окне');expect((await projectionStorage(key,namespace)).journal.owned[name]).toEqual(first.journal.owned[name]);
 });
 it('site identity isolates ownership and rejects opening another namespace receipt',async()=>{
  const key=journalKey(site,payload),storage=await projectionStorage(key,namespace);await storage.save(storage.journal);
  expect(journalKey('https://other.invalid',payload)).not.toBe(key);await expect(projectionStorage(key,memoryNamespace('https://other.invalid',payload.projectId))).rejects.toThrow();
 });
 it('recovery refuses a private checkpoint with another device identity',async()=>{
  await saveMemoryCheckpoint(pending);const key=hash('learning-memory-result:'+pending.id);
  await privateStore.writePrivateConfiguration(key,{...pending,deviceId:'55555555-5555-4555-8555-555555555555'},pending);
  const deliver=vi.fn();await expect(recoverMemoryCompletions(deliver)).rejects.toThrow('другому заданию');expect(deliver).not.toHaveBeenCalled();
 });
});
