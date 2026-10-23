import {describe,expect,it,vi} from 'vitest';
import {projectExecutionState} from '../src/model-chat/chat-execution-state';
import type {ChatDb} from '../src/model-chat/chat.repository';
import {turnView,type ConversationRow,type TurnRow} from '../src/model-chat/chat.types';
import {responseView,type ChatResponseRow} from '../src/model-chat/chat-group.types';

const conversation={owner_email:'owner@test',mode:'model',model_id:'model-a'} as ConversationRow;
const turn=()=>({id:'turn-a',request_id:'attempt-a',status:'pending',target_agent_ids:[],created_at:new Date(),responses:[]}) as unknown as TurnRow;
const call={turn_id:'turn-a',operation_id:'attempt-a',agent_id:null,model_id:'model-a',purpose:'chat'};
const db=(rows:unknown[])=>({query:vi.fn(async()=>({rows}))});
describe('Model answer execution is distinct from queueing and human read receipts',()=>{
    it('does not query inference for terminal history and emits no active state',async()=>{
        const row={...turn(),status:'done' as const},sql=db([]);await projectExecutionState(sql as unknown as ChatDb,conversation,[row]);
        expect(sql.query).not.toHaveBeenCalled();expect(turnView(row).executionState).toBeNull();
    });
    it('projects a dispatched current model attempt as running and an undispatched attempt as waiting',async()=>{
        const row=turn();await projectExecutionState(db([call]) as unknown as ChatDb,conversation,[row]);expect(turnView(row).executionState).toBe('running');
        await projectExecutionState(db([]) as unknown as ChatDb,conversation,[row]);expect(turnView(row).executionState).toBe('waiting');
    });
    it.each([{operation_id:'old-attempt'},{turn_id:'other-turn'},{model_id:'other-model'},{agent_id:'agent-other'},{purpose:'compaction'}])('does not borrow another call: %j',async patch=>{
        const row=turn();await projectExecutionState(db([{...call,...patch}]) as unknown as ChatDb,conversation,[row]);expect(row.execution_state).toBe('waiting');
    });
    it('projects each sibling separately and keeps successful siblings terminal',async()=>{
        const response=(id:string,status='pending')=>({id,agent_id:id,status,snapshot:{modelId:'model-a'},request_id:'attempt-a'}) as unknown as ChatResponseRow;
        const row={...turn(),responses:[response('agent-a'),response('agent-b'),response('agent-done','done')]};
        await projectExecutionState(db([{...call,agent_id:'agent-b',purpose:'agent'},{...call,agent_id:'agent-done',purpose:'agent'}]) as unknown as ChatDb,{...conversation,mode:'group'},[row]);
        expect(row.execution_state).toBe('running');expect(row.responses.map(response=>responseView(response).executionState)).toEqual(['waiting','running',null]);
    });
});
