import 'fake-indexeddb/auto';
import {describe,expect,it} from 'vitest';
import {clearSnapshotIntent,readSnapshotIntent,saveSnapshotIntent,snapshotDraftScope,validSnapshotIntent} from '../src/features/ProjectSnapshots/snapshotDraftStore';
import type {SnapshotIntent} from '../src/features/ProjectSnapshots/types';
const create=(projectId='project-one'):SnapshotIntent=>({projectId,kind:'create',input:{requestKey:crypto.randomUUID(),deviceId:crypto.randomUUID(),expectedBindingId:'a'.repeat(64),expectedHeadId:null,expectedHeadRevision:0}});
describe('Snapshot intents — actual IndexedDB commit/CAS',()=>{
    it('Keeps original computer/binding/head/request UUID across reload',async()=>{const intent=create(),scope=crypto.randomUUID();await saveSnapshotIntent(scope,intent);expect(await readSnapshotIntent(scope,intent.projectId)).toEqual(intent);});
    it('Serializes two competing tabs and refuses a different command until the original is closed',async()=>{const a=create(),b=create(),scope=crypto.randomUUID();const result=await Promise.allSettled([saveSnapshotIntent(scope,a),saveSnapshotIntent(scope,b)]);expect(result.filter(row=>row.status==='fulfilled')).toHaveLength(1);const current=await readSnapshotIntent(scope,a.projectId);expect([a,b]).toContainEqual(current);await expect(saveSnapshotIntent(scope,{projectId:a.projectId,kind:'cancel',snapshotId:crypto.randomUUID(),input:{requestKey:crypto.randomUUID()}})).rejects.toThrow('другой вкладке');});
    it('Exact retry is allowed, but late clear cannot erase a newer tab intent (ABA)',async()=>{const a=create(),b=create(),scope=crypto.randomUUID();await saveSnapshotIntent(scope,a);await saveSnapshotIntent(scope,a);expect(await clearSnapshotIntent(scope,a.projectId,a.input.requestKey)).toBe(true);await saveSnapshotIntent(scope,b);expect(await clearSnapshotIntent(scope,a.projectId,a.input.requestKey)).toBe(false);expect(await readSnapshotIntent(scope,a.projectId)).toEqual(b);});
    it('Isolates accounts/projects and rejects a cross-project damaged record',async()=>{const a=create(),b=create('project-two'),one=snapshotDraftScope(' Alice@Example.test ',a.projectId),two=snapshotDraftScope('alice@example.test',b.projectId),other=snapshotDraftScope('bob@example.test',a.projectId);expect(one).not.toBe(two);expect(one).not.toBe(other);await saveSnapshotIntent(one,a);await saveSnapshotIntent(two,b);expect(await readSnapshotIntent(two,b.projectId)).toEqual(b);await expect(readSnapshotIntent(one,b.projectId)).rejects.toThrow('повреждён');});
    it.each([
        {...create(),kind:'execute',input:{requestKey:crypto.randomUUID()}},
        {...create(),input:{...create().input,expectedBindingId:'bad'}},
        {...create(),input:{...create().input,expectedHeadRevision:-1}},
        {...create(),input:{...create().input,serverPath:'/private'}},
        {projectId:'p',kind:'delete',snapshotId:crypto.randomUUID(),input:{requestKey:crypto.randomUUID(),expectedManifest:'a'.repeat(64),gracePeriodHours:0}},
        {projectId:'p',kind:'release',input:{requestKey:crypto.randomUUID(),snapshotId:crypto.randomUUID(),expectedProfileId:null,expectedProfileRevision:0,moveHead:{expectedHeadId:null,expectedHeadRevision:0,extra:true}}},
    ])('Rejects malformed intent before storage/network: %j',async value=>{expect(validSnapshotIntent(value)).toBe(false);await expect(saveSnapshotIntent(crypto.randomUUID(),value as SnapshotIntent)).rejects.toThrow();});
    it('Accepts exact release/profile CAS with atomic head move and canonical create/command variants',async()=>{const snapshotId=crypto.randomUUID(),input={requestKey:crypto.randomUUID()};for(const value of [
        {projectId:'p',kind:'release',input:{...input,snapshotId,expectedProfileId:null,expectedProfileRevision:0,moveHead:{expectedHeadId:null,expectedHeadRevision:7}}},
        {projectId:'p',kind:'activate',snapshotId,input:{...input,expectedHeadId:null,expectedHeadRevision:2}},
        {projectId:'p',kind:'rollback',snapshotId,input:{...input,expectedHeadId:crypto.randomUUID(),expectedHeadRevision:9}},
        {projectId:'p',kind:'delete',snapshotId,input:{...input,expectedManifest:null,gracePeriodHours:24}},
        {projectId:'p',kind:'cancel',snapshotId,input},
    ])expect(validSnapshotIntent(value)).toBe(true);});
});
