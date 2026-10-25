import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Request} from 'express';
import type {ConversationRow,TurnRow} from '../src/model-chat/chat.types';
import {captureDevTrace,deferred} from './dev-trace.fixture';

vi.mock('../src/database/pool',()=>({createPool:()=>({})}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined),requireFeatureEnabled:vi.fn(async()=>undefined)}));
import {ModelChatService} from '../src/model-chat/chat.service';

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});

function fixture(){
    const capture=captureDevTrace(),conversation={id:randomUUID(),model_pin:'a'.repeat(64),mode:'model',project_id:null} as ConversationRow;
    const runtime={infer:vi.fn(async()=>({message:{role:'assistant',content:'private-answer'},done_reason:'stop'}))};
    const service=new ModelChatService({} as never,runtime as never),turnId=randomUUID();let current:TurnRow|undefined;
    const db={query:vi.fn(async(sql:string,values:string[])=>{
        if(sql.startsWith('UPDATE model_chat_turns SET request_id=')){
            current={...current!,request_id:values[2],request_ids:[...current!.request_ids,values[2]],status:'pending'};return {rows:[current],rowCount:1};
        }
        if(sql.startsWith("UPDATE model_chat_turns SET status='cancelled'")){
            current!.status='cancelled';return {rows:[{request_id:current!.request_id}],rowCount:1};
        }
        return {rows:[],rowCount:0};
    })};
    const repository={pool:{},owned:async(_owner:string,_id:string,authorize:()=>Promise<unknown>,work:(db:unknown,row:ConversationRow)=>Promise<unknown>)=>{await authorize();return work(db,conversation);},
        priorTurn:vi.fn(async(_db:unknown,_id:string,requestId:string)=>current?.request_ids.includes(requestId)?current:undefined),
        revision:vi.fn(),tail:vi.fn(async()=>current),stage:vi.fn(),bump:vi.fn(),
        addTurn:vi.fn(async(_db:unknown,_row:ConversationRow,input:{requestId:string;hash:string;prompt:string;text:string})=>{
            current={id:turnId,conversation_id:conversation.id,request_id:input.requestId,request_ids:[input.requestId],request_hash:input.hash,prompt:input.prompt,
                input_text:input.text,status:'pending',removed_at:null,target_agent_ids:[],lease_until:new Date(Date.now()+60000)} as unknown as TurnRow;return {...current};
        }),
        finish:vi.fn(async()=>{current!.status='done';return true;}),fail:vi.fn(async(_id:string,_turn:string,requestId:string,status:TurnRow['status'])=>{
            if(current?.request_id!==requestId||current.status!=='pending'||current.removed_at)return false;
            current.status=status;return true;
        })};
    const project={requiredFeatures:[],assertCurrent:async()=>{},beforeInference:async()=>{},fit:(messages:unknown)=>({messages,evidence:{status:'none',sources:[]}})};
    const scope={owner:'private-owner@example.test',row:conversation,authorize:async()=>({id:'model-fixture',runtime:'ollama'})};
    Object.assign(service,{repository,scope:async()=>scope,discussions:{get:async()=>undefined,cancel:async()=>{}},settings:async()=>({}),
        researchAllowed:async()=>{},inputText:async(_db:unknown,_id:string,prompt:string)=>prompt,contextFor:async()=>({exceeded:false,compactionNeeded:false}),
        compact:async()=>[{role:'user',content:'private-prompt'}],projectContext:{prepare:async()=>project},
        read:async()=>({turns:current?[{id:current.id,requestId:current.request_id,status:current.status}]:[]})});
    const req={headers:{authorization:'private-token'}} as Request;
    const send=(requestId=randomUUID(),signal=new AbortController().signal)=>service.send(req,conversation.id,
        {expectedRevision:1,expectedModelPin:conversation.model_pin,requestId,prompt:'private-prompt',attachmentIds:[]},signal);
    const retry=(requestId:string)=>service.retry(req,conversation.id,turnId,{expectedRevision:1,expectedModelPin:conversation.model_pin,requestId},new AbortController().signal);
    const abortCurrent=()=>{(service as unknown as{active:Map<string,{abort:AbortController}>}).active.get(turnId)!.abort.abort();};
    return {capture,service,conversation,turnId,runtime,repository,send,retry,req,current:()=>current,abortCurrent};
}

describe('Production saved-chat methods trace the durable turn and each request attempt',()=>{
    it('an explicit stop and retry keep the turn while assigning the new attempt identity',async()=>{
        const f=fixture(),dispatched=deferred(),first=randomUUID(),next=randomUUID();
        f.runtime.infer.mockImplementationOnce(async(_model:unknown,_endpoint:unknown,_body:unknown,signal:AbortSignal)=>{
            dispatched.resolve();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('private-provider-error')),{once:true}));
            throw Error('unreachable');
        });
        const pending=f.send(first);await dispatched.promise;await f.service.cancel(f.req,f.conversation.id,f.turnId,{expectedRevision:1});await pending;
        expect(f.current()?.status).toBe('cancelled');await f.retry(next);expect(f.current()?.status).toBe('done');
        const records=f.capture.records();expect(records.map(row=>row.event)).toEqual(['accepted','started','cancel-requested','retried','started','succeeded']);
        for(const record of records)expect(record).toMatchObject({conversationId:f.conversation.id,turnId:f.turnId,launchId:f.capture.launchId,attemptId:record.requestId});
        expect(records.slice(0,3).map(row=>row.requestId)).toEqual(Array(3).fill(first));expect(records.slice(3).map(row=>row.requestId)).toEqual(Array(3).fill(next));
        expect(JSON.stringify(records)).not.toMatch(/private-|prompt|answer|authorization|token|error/);
    });
    it('a trace write failure does not change the saved answer',async()=>{
        const f=fixture();f.capture.write.mockImplementation(()=>{throw Error('private-log-error');});
        await expect(f.send()).resolves.toMatchObject({turns:[{status:'done'}]});expect(f.repository.finish).toHaveBeenCalledOnce();
    });
    it('a stale or superseded finish cannot publish a successful trace outcome',async()=>{
        const f=fixture();f.repository.finish.mockImplementationOnce(async()=>false);
        await expect(f.send()).resolves.toMatchObject({turns:[{status:'pending'}]});
        expect(f.repository.finish).toHaveBeenCalledOnce();expect(f.repository.fail).not.toHaveBeenCalled();
        expect(f.capture.records().map(record=>record.event)).toEqual(['accepted','started']);
    });
    it.each(['removed','done','superseded'] as const)('a %s attempt cannot publish failure when trusted cleanup applies no transition',async state=>{
        const f=fixture();f.runtime.infer.mockImplementationOnce(async()=>{
            if(state==='removed')f.current()!.removed_at=new Date();
            if(state==='done')f.current()!.status='done';
            if(state==='superseded')f.current()!.request_id=randomUUID();
            throw Error('private-provider-error');
        });
        await f.send();expect(f.repository.fail).toHaveResolvedWith(false);
        expect(f.capture.records().map(record=>record.event)).toEqual(['accepted','started']);
    });
    it('an applied failure transition publishes a failed event',async()=>{
        const f=fixture();f.runtime.infer.mockRejectedValueOnce(Error('private-provider-error'));
        await f.send();expect(f.current()!.status).toBe('failed');expect(f.repository.fail).toHaveResolvedWith(true);
        expect(f.capture.records().map(record=>record.event)).toEqual(['accepted','started','failed']);
    });
    it('server-owned cancellation publishes its terminal event only when cleanup applies it',async()=>{
        const f=fixture(),dispatched=deferred();
        f.runtime.infer.mockImplementationOnce(async(_model:unknown,_endpoint:unknown,_body:unknown,signal:AbortSignal)=>{
            dispatched.resolve();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('private-provider-error')),{once:true}));
            throw Error('unreachable');
        });
        const pending=f.send();await dispatched.promise;f.abortCurrent();await pending;
        expect(f.current()!.status).toBe('cancelled');expect(f.repository.fail).toHaveResolvedWith(true);
        expect(f.capture.records().map(record=>record.event)).toEqual(['accepted','started','cancelled']);
    });
    it('pre-admission cancellation does not manufacture an accepted turn or dispatch',async()=>{
        const f=fixture(),controller=new AbortController();controller.abort(Error('private-cancel-reason'));
        await expect(f.send(randomUUID(),controller.signal)).rejects.toThrow('private-cancel-reason');
        expect(f.repository.addTurn).not.toHaveBeenCalled();expect(f.runtime.infer).not.toHaveBeenCalled();expect(f.capture.records()).toEqual([]);
    });
});
