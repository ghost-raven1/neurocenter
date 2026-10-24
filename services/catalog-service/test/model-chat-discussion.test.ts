import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discussionPlan, discussGroup } from '../src/model-chat/chat-discussion';
import { runChatDiscussion } from '../src/model-chat/chat-discussion.runner';
import { DISCUSSION_LIMITS, type DiscussionCall, type DiscussionRun, type DiscussionStep } from '../src/model-chat/chat-discussion.types';
import { currentModelUsage } from '../src/model-usage/model-usage.context';
import type { ChatResolvedAgent } from '../src/model-chat/chat-group.types';
import type { IModel } from '../src/models/model.types';
import { defaultFeatureFlags, evaluateFeatureFlags } from '../../shared/feature-flags.cjs';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import { requiredRouteFeatures } from '../../shared/feature-policy.cjs';

const model: IModel = { id:'model-test',name:'Test',description:'',capability:'chat',runtime:'ollama',model:'test:local',manifestSha256:'a'.repeat(64),
    dimension:null,source:'custom',revision:1,createdAt:'',updatedAt:'' };
const roster: ChatResolvedAgent[] = ['a','b'].map(id=>({model,snapshot:{agentId:'agent-'+id,name:id,slug:id,version:1,manifest:'b'.repeat(64),
    definition:{description:'Specialist '+id,prompt:'Persona '+id,mode:'all',permission:{}},modelId:model.id,modelName:model.name,modelPin:projectEmbeddingPin(model),sha256:id.repeat(64)}}));
const task=(id='agent-a')=>({agentId:id,instruction:'Проверь свою часть.'});
const planned=(responses=[task()],critic:ReturnType<typeof task>|null=null)=>JSON.stringify({responses,critic});
const final=()=>JSON.stringify({summary:'Проверенный итог.',decisions:['Решение'],disagreements:['Осталось ограничение'],nextSteps:['Проверить результат']});
const reply=(content:string)=>({message:{role:'assistant',content},done_reason:'stop'});
const noop=async()=>undefined;
const completion=(content:string,finishReason:'stop'|'length'='stop')=>({content,finishReason});
const textDiscussion=(question:string,participants:readonly ChatResolvedAgent[],maximum:number,invoke:(call:DiscussionCall)=>Promise<string>,checkpoint:()=>Promise<unknown>)=>discussGroup(question,participants,maximum,async call=>completion(await invoke(call)),checkpoint);
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();});

describe('An ordinary group question coordinates within the accepted roster',()=>{
    it('plans, obtains independent answers, critiques their actual saved content and synthesizes without another action',async()=>{
        const calls:DiscussionCall[]=[];
        const result=await textDiscussion('Вопрос',roster,3,async call=>{calls.push(call);return call.phase==='planning'?planned([task(),task('agent-b')],task()):call.phase==='synthesis'?final():'ANSWER '+call.key;},noop);
        expect(calls.map(call=>call.phase)).toEqual(['planning','response','response','critique','synthesis']);
        expect(JSON.stringify(calls[1].messages)).not.toContain('ANSWER');expect(JSON.stringify(calls[2].messages)).not.toContain('ANSWER');
        expect(JSON.stringify(calls[3].messages)).toContain('ANSWER response:agent-a');expect(JSON.stringify(calls[3].messages)).toContain('ANSWER response:agent-b');
        expect(result.content).toContain('Решения:');expect(result.content).toContain('Разногласия');expect(result.outcomes).toHaveLength(3);
        expect(JSON.stringify(calls[0].messages)).not.toContain('Persona a');
    });
    it('keeps a failed specialist local and sends the available answer and missing outcome to synthesis',async()=>{
        const calls:DiscussionCall[]=[];
        const result=await textDiscussion('Вопрос',roster,3,async call=>{calls.push(call);if(call.phase==='planning')return planned([task(),task('agent-b')]);if(call.task?.agentId==='agent-a')throw Error('private-provider-token');return call.phase==='synthesis'?final():'INDEPENDENT';},noop);
        expect(result.outcomes.map(item=>item.state)).toEqual(['failed','done']);
        expect(JSON.stringify(calls.at(-1)?.messages)).toContain('INDEPENDENT');expect(JSON.stringify(calls)).not.toContain('private-provider-token');
    });
    it('retains the useful contributions when final synthesis is unavailable',async()=>{
        const result=await textDiscussion('Вопрос',roster,3,async call=>{if(call.phase==='planning')return planned();if(call.phase==='synthesis')throw Error('https://private.invalid/key');return 'SAVED ANSWER';},noop);
        expect(result.content).toContain('SAVED ANSWER');expect(result.content).not.toContain('private.invalid');
    });
    it('does not spend a critique or synthesis call when no specialist produced an answer',async()=>{
        const phases:string[]=[];
        const result=await textDiscussion('Вопрос',roster,3,async call=>{phases.push(call.phase);if(call.phase==='planning')return planned([task()],task('agent-b'));throw Error('offline');},noop);
        expect(phases).toEqual(['planning','response']);expect(result.content).toContain('Проверенного ответа пока нет');
    });
    it('preserves truncated content and tells synthesis about its incomplete finish state',async()=>{
        const calls:DiscussionCall[]=[];
        const result=await discussGroup('Вопрос',roster,3,async call=>{calls.push(call);return call.phase==='planning'?completion(planned()):completion(call.phase==='synthesis'?final():'PARTIAL','length');},noop);
        expect(result.finishReason).toBe('length');expect(result.content).toContain('Итог обрезан');
        expect(JSON.parse(calls.at(-1)!.messages.at(-1)!.content).contributions).toContainEqual(expect.objectContaining({content:'PARTIAL',finishReason:'length'}));
    });
    it('never starts children from a plan whose provider reported truncation',async()=>{
        const phases:string[]=[];const result=await discussGroup('Вопрос',roster,3,async call=>{phases.push(call.phase);return completion(planned(),'length');},noop);
        expect(phases).toEqual(['planning']);expect(result.outcomes).toEqual([]);
    });
    it('stops between steps on revoked authority instead of hiding it as a child failure',async()=>{
        let authorized=true;const phases:string[]=[];
        await expect(textDiscussion('Вопрос',roster,3,async call=>{phases.push(call.phase);if(call.phase==='planning')return planned([task(),task('agent-b')]);authorized=false;return 'SAVED';},async()=>{if(!authorized)throw new ForbiddenException('revoked');})).rejects.toThrow('revoked');
        expect(phases).toEqual(['planning','response']);
    });
});

describe('A model plan grants no new participants, identity or recursive work',()=>{
    it.each([
        ['unknown',planned([task('agent-other')])],['duplicate',planned([task(),task()])],['empty',planned([])],
        ['too many',planned([task(),task('agent-b')],task())],['nested',JSON.stringify({responses:[{...task(),children:[]}],critic:null})],
        ['model override',JSON.stringify({responses:[{...task(),modelId:'other'}],critic:null})],['wrong critic',planned([task()],task('agent-other'))],
        ['blank instruction',planned([{...task(),instruction:' '}])],['unknown property',JSON.stringify({responses:[task()],critic:null,tools:['shell']})],
        ['malformed','{'],['oversized','x'.repeat(16385)],
    ])('rejects %s before any specialist dispatch',async(_name,value)=>{
        expect(()=>discussionPlan(value,roster,2)).toThrow(BadRequestException);
        const phases:string[]=[];await textDiscussion('Question',roster,2,async call=>{phases.push(call.phase);return value;},noop);
        expect(phases).toEqual(['planning']);
    });
    it('keeps explicit recipient scope even if a different project participant exists',()=>{
        expect(()=>discussionPlan(planned([task('agent-b')]),[roster[0]],3)).toThrow();
    });
    it('exposes a distinct flag without making history, cancel or legacy group sends require it',()=>{
        const flags=evaluateFeatureFlags({...defaultFeatureFlags(),group_chat:false});expect(flags.flags.group_discussions).toBe(false);
        expect(requiredRouteFeatures('POST','/api/model-chats',{mode:'group'})).toEqual(['group_chat']);
        expect(requiredRouteFeatures('GET','/api/model-chats/id')).toEqual([]);
        expect(requiredRouteFeatures('POST','/api/model-chats/id/turns/turn/cancel')).toEqual([]);
    });
});

/** A controlled durable port records observable receipts; SQL ownership and immutability are checked separately on real PostgreSQL. */
function runtimeFixture(withEmbedding=false){
    const controller=new AbortController(),state={authorized:true,pending:true,enabled:true,answer:'',changed:new Set<string>()};
    const conversation={id:'conversation',owner_email:'owner@example.test',project_id:'project',model_id:model.id,model_pin:projectEmbeddingPin(model),agent_ids:roster.map(item=>item.snapshot.agentId),mode:'group'};
    const turn={id:'turn',conversation_id:conversation.id,request_id:'request',input_text:'QUESTION',status:'pending',removed_at:null,lease_until:new Date(Date.now()+900000)};
    const run:DiscussionRun={turn_id:turn.id,request_id:turn.request_id,actor_role:'Разработчик',model,roster,calls_started:0,deadline_at:new Date(Date.now()+120000)};
    const receipts:DiscussionStep[]=[],calls:Array<{phase:string;agentId:unknown;body:unknown;signal:AbortSignal}>=[];
    const query=async(sql:string)=>sql.includes('model_chat_conversations')?{rows:[conversation],rowCount:1}:{rows:state.pending?[{}]:[],rowCount:state.pending?1:0};
    const db={query};
    const chats={pool:db,peek:async()=>conversation,owned:async(_owner:unknown,_id:unknown,authorize:(db:unknown)=>Promise<unknown>,work:(db:unknown,row:unknown)=>Promise<unknown>)=>{await authorize(db);const result=await work(db,conversation);await authorize(db);return result;},
        finish:async(_db:unknown,_row:unknown,_turn:unknown,answer:{content:string})=>{if(!state.pending)throw Error('cancelled');state.answer=answer.content;state.pending=false;return true;}};
    const steps={get:async()=>run,begin:async(_owner:unknown,_id:unknown,_turn:unknown,phase:string,key:string,selected:IModel,snapshot:unknown)=>{
        if(receipts.some(step=>step.step_key===key))throw new ConflictException('already accepted');
        if(run.calls_started>=(phase==='synthesis'?5:4))throw new ConflictException('budget');
        const step={id:'step-'+(++run.calls_started),turn_id:turn.id,request_id:turn.request_id,sequence:run.calls_started,step_key:key,phase,model_id:selected.id,model_pin:projectEmbeddingPin(selected),snapshot,input_hash:'hash',status:'pending',finish_reason:null,output:null,error:null} as DiscussionStep;
        receipts.push(step);return step;},current:async(_db:unknown,_turn:unknown,step:DiscussionStep)=>{if(!state.pending||step.status!=='pending')throw new ConflictException('cancelled');},
        finish:async(_owner:unknown,_id:unknown,_turn:unknown,step:DiscussionStep,status:DiscussionStep['status'],output:string|null,finishReason:'stop'|'length'|null,authorize:(db:unknown)=>Promise<unknown>)=>{await authorize(db);if(!state.pending||step.status!=='pending')throw new ConflictException('late');Object.assign(step,{status,output,finish_reason:finishReason});}};
    const checkpoint=async()=>{if(!state.authorized)throw new ForbiddenException('revoked');return model;};
    const scope={owner:conversation.owner_email,actorRole:run.actor_role,row:conversation,model,authorize:checkpoint};
    let provider=async(phase:string,_signal:AbortSignal)=>phase==='planning'?reply(planned([task(),task('agent-b')],withEmbedding?null:task())):phase==='synthesis'?reply(final()):phase==='context'?{embeddings:[[1]]}:reply('SAVED '+phase);
    const runtime={infer:async(_model:IModel,_endpoint:string,body:Record<string,unknown>,signal:AbortSignal)=>{
        await currentModelUsage().beforeInference?.();const step=receipts.at(-1)!;calls.push({phase:step.phase,agentId:currentModelUsage().agentId,body,signal});return provider(step.phase,signal);
    }};
    const project={evidence:{status:'metadata',sources:[]},messages:[],assertCurrent:noop,fit:(messages:unknown)=>({messages,evidence:{status:'metadata',sources:[]}})};
    const deps={chats,steps,runtime,settings:async()=>({contextWindowTokens:null}),history:async()=>[{role:'user',content:'QUESTION'}],
        groups:{assert:async(_req:unknown,_row:unknown,_base:unknown,snapshot:{agentId:string})=>{await checkpoint();if(state.changed.has(snapshot.agentId))throw new ConflictException('changed');return model;},learning:{prepare:async()=>({messages:[],requiredFeatures:[],beforeInference:noop})}},
        project:{prepare:async(_req:unknown,_project:unknown,prompt:string,_signal:unknown,_before:unknown,embedding?:(...args:unknown[])=>Promise<unknown>)=>{if(withEmbedding&&prompt&&embedding)await embedding({...model,capability:'embedding'},{input:[prompt]},controller.signal);return project;}}};
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(evaluateFeatureFlags({...defaultFeatureFlags(),group_discussions:state.enabled})),{status:200})));
    return {state,run,turn,receipts,calls,controller,setProvider(value:typeof provider){provider=value;},start:()=>runChatDiscussion({} as never,scope as never,turn as never,run,controller.signal,deps as never)};
}

describe('Discussion deadlines, call accounting and fresh authority',()=>{
    it('counts shared embedding in the same five-call bound and reserves synthesis',async()=>{
        const f=runtimeFixture(true);await f.start();
        expect(f.calls.map(call=>call.phase)).toEqual(['context','planning','response','response','synthesis']);
        expect(f.run.calls_started).toBe(5);expect(f.state.answer).toContain('Проверенный итог');
    });
    it('uses the accepted persona options instead of silently resetting its model configuration',async()=>{
        const original=roster[0].snapshot.definition;
        roster[0].snapshot.definition={...original,temperature:0.3,topP:0.8};
        try{const f=runtimeFixture();await f.start();const body=f.calls.find(call=>call.phase==='response')!.body;
            expect(body).toMatchObject({options:{temperature:0.3,top_p:0.8}});
        }finally{roster[0].snapshot.definition=original;}
    });
    it('times out an uncooperative child, accepts an independent answer and saves the partial final result before the parent deadline',async()=>{
        vi.useFakeTimers();const f=runtimeFixture();let first=true;
        f.setProvider(async phase=>{if(phase==='planning')return reply(planned([task(),task('agent-b')]));if(phase==='response'&&first){first=false;return new Promise(()=>{});}return phase==='synthesis'?reply(final()):reply('INDEPENDENT');});
        const work=f.start();await vi.advanceTimersByTimeAsync(0);await vi.advanceTimersByTimeAsync(40000);await work;
        expect(f.receipts.filter(step=>step.phase==='response').map(step=>step.status)).toEqual(['failed','done']);
        expect(f.state.answer).toContain('Проверенный итог');expect(f.calls[1].signal.aborted).toBe(true);expect(f.run.calls_started).toBe(4);
    });
    it('accepts a native delegate taking more than twenty seconds within its fair deadline',async()=>{
        vi.useFakeTimers();const f=runtimeFixture();
        f.setProvider(async phase=>{if(phase==='planning')return reply(planned());if(phase==='response')await new Promise(resolve=>setTimeout(resolve,22100));return phase==='synthesis'?reply(final()):reply('DELAYED');});
        const work=f.start();await vi.advanceTimersByTimeAsync(22100);await work;
        expect(f.receipts.find(step=>step.phase==='response')?.output).toBe('DELAYED');expect(f.calls).toHaveLength(3);
    });
    it('stops all subsequent dispatch when original actor access is revoked between steps',async()=>{
        const f=runtimeFixture();f.setProvider(async phase=>{if(phase==='planning')return reply(planned([task(),task('agent-b')]));f.state.authorized=false;return reply('PRIVATE LATE RESULT');});
        await expect(f.start()).rejects.toThrow('revoked');expect(f.calls.map(call=>call.phase)).toEqual(['planning','response']);
        expect(f.state.answer).toBe('');expect(f.receipts.some(step=>step.output==='PRIVATE LATE RESULT')).toBe(false);
    });
    it('keeps a received contribution but dispatches nothing further when the discussion flag turns off',async()=>{
        const f=runtimeFixture();f.setProvider(async phase=>{if(phase==='planning')return reply(planned([task(),task('agent-b')]));f.state.enabled=false;return reply('RETAINED');});
        await f.start();expect(f.calls.map(call=>call.phase)).toEqual(['planning','response']);expect(f.state.answer).toContain('RETAINED');
    });
    it('never imports late cancelled output into an answer or starts the next participant',async()=>{
        const f=runtimeFixture();f.setProvider(async phase=>{if(phase==='planning')return reply(planned([task(),task('agent-b')]));f.state.pending=false;f.controller.abort();return reply('LATE');});
        await expect(f.start()).rejects.toThrow();expect(f.calls).toHaveLength(2);expect(f.state.answer).toBe('');
        expect(f.receipts.some(step=>step.output==='LATE')).toBe(false);
    });
    it('does not reset durable step markers when the same accepted execution is observed again',async()=>{
        const f=runtimeFixture();await f.start();const count=f.calls.length;await expect(f.start()).rejects.toThrow('остановлено');expect(f.calls).toHaveLength(count);
        expect(f.run.calls_started).toBeLessThanOrEqual(DISCUSSION_LIMITS.calls);
    });
});
