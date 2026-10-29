import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
vi.mock('../src/features/system-role-mcp/owned-process.js',()=>({roleMcpProcessOwner:async()=>({pid:12345,uid:process.getuid?.()??0,birth:'fixture-born',entry:'/fixture/owned-worker.js'}),roleMcpOwnerAlive:async()=>false}));
import {beginGlobalReceipt,completeGlobalReceipt,queueGlobalReceipt,globalReceipts,readGlobalReceipt} from '../src/features/opencode-local-providers/receipts.js';
import {saveCompletion,pendingCompletions} from '../src/bridge/completions.js';
let root:string;
const deviceId='11111111-1111-4111-8111-111111111111',kind='inspect-opencode-global-providers';
const result=(id:string,large=false)=>({schemaVersion:1,scope:'global',deviceId,jobId:id,kind,checkedAt:'2026-10-29T00:00:00.000Z',status:'checked',inventory:{providers:Array.from({length:large?20:1},(_,index)=>({id:'provider-'+index,modelIds:large?Array.from({length:50},(_,model)=>'long-model-name-'+model):[],hasConfiguration:true,hasAuthentication:false,authentication:'none',enabled:true})),configurationFound:true,authenticationFound:false,overrideDetected:false,issues:[]}});
beforeEach(async()=>{root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc global outbox ')));vi.stubEnv('NEUROCENTER_BRIDGE_HOME',root);vi.stubEnv('NEUROCENTER_URL','https://global-providers.test');});
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await fs.rm(root,{recursive:true,force:true});});
it('valid inventory above10KiB round-trips through the private outbox while malformed small/large results are rejected',async()=>{
    const id=randomUUID(),completion={id,lease:randomUUID(),deviceId,state:'succeeded' as const,message:'Synthetic public observation',result:result(id,true)};expect(Buffer.byteLength(JSON.stringify(completion.result))).toBeGreaterThan(10000);
    await saveCompletion(completion);expect((await pendingCompletions())[0].result).toEqual(completion.result);
    for(const large of [false,true]){const wrong=randomUUID();await expect(saveCompletion({...completion,id:wrong,result:{...result(wrong,large),apiKey:'SYNTHETIC_PRIVATE_UNKNOWN_FIELD'}})).rejects.toThrow();}
});
it('outboxed receipts are archived; recovery reads no archived bodies while exact UUID replay remains available',async()=>{
    const ids:string[]=[],save=vi.fn(async()=>{});
    for(let index=0;index<16;index++){
        const id=randomUUID();ids.push(id);let receipt=await beginGlobalReceipt({id,lease:randomUUID(),deviceId,kind,project_id:null,payload:{schemaVersion:1,scope:'global',deviceId}});
        receipt=await completeGlobalReceipt(receipt,{id,lease:receipt.job.lease,deviceId,state:'succeeded',message:'SYNTHETIC_PRIVATE_MESSAGE',result:result(id)});await queueGlobalReceipt(receipt,save);
    }
    expect(save).toHaveBeenCalledTimes(16);expect(JSON.stringify(save.mock.calls)).not.toContain('SYNTHETIC_PRIVATE_MESSAGE');
    const open=vi.spyOn(fs,'open');expect(await Array.fromAsync(globalReceipts())).toEqual([]);expect(open.mock.calls.filter(([name])=>String(name).endsWith('.json'))).toHaveLength(0);
    const receipt=await readGlobalReceipt(ids[0]);expect(receipt?.phase).toBe('closed');expect(receipt?.outboxed).toBe(true);await queueGlobalReceipt(receipt!,save);expect(save).toHaveBeenCalledTimes(16);
});
it('outbox failure preserves one closed receipt and retries delivery without another local action',async()=>{
    const id=randomUUID();let receipt=await beginGlobalReceipt({id,lease:randomUUID(),deviceId,kind,project_id:null,payload:{schemaVersion:1,scope:'global',deviceId}});
    receipt=await completeGlobalReceipt(receipt,{id,lease:receipt.job.lease,deviceId,state:'succeeded',message:'public',result:result(id)});await expect(queueGlobalReceipt(receipt,async()=>{throw Error('Lost outbox ACK');})).rejects.toThrow();
    expect(await Array.fromAsync(globalReceipts())).toHaveLength(1);const save=vi.fn(async()=>{});await queueGlobalReceipt((await readGlobalReceipt(id))!,save);expect(save).toHaveBeenCalledOnce();expect(await Array.fromAsync(globalReceipts())).toEqual([]);
});
