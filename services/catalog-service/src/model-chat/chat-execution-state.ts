import type { ChatDb } from './chat.repository';
import type { ConversationRow, TurnRow } from './chat.types';

interface ActiveCall { turn_id: string; operation_id: string; agent_id: string | null; model_id: string; purpose: string }

/** Only a dispatched, leased call for the current attempt means an answer is being generated. */
export async function projectExecutionState(db: ChatDb, conversation: ConversationRow, turns: TurnRow[]): Promise<void> {
    const pending = turns.filter(turn => turn.status === 'pending');
    const calls = pending.length ? (await db.query<ActiveCall>(`SELECT turn_id,operation_id,agent_id,model_id,purpose FROM model_usage_calls
        WHERE actor_email=$1 AND turn_id=ANY($2::uuid[]) AND operation_id=ANY($3::uuid[])
        AND status='pending' AND endpoint='chat' AND purpose IN ('chat','agent')
        AND dispatch_count>0 AND provider_latency_ms IS NULL AND lease_until>now()`, [conversation.owner_email, pending.map(turn => turn.id), pending.map(turn => turn.request_id)])).rows : [];
    for (const turn of turns) {
        const own = calls.filter(call => call.turn_id === turn.id && call.operation_id === turn.request_id);
        for (const response of turn.responses ?? []) response.execution_state = turn.status !== 'pending' || response.status !== 'pending' ? null
            : response.request_id === turn.request_id && own.some(call => call.purpose === 'agent' && call.agent_id === response.agent_id && call.model_id === response.snapshot.modelId) ? 'running' : 'waiting';
        const active = conversation.mode === 'group' ? turn.responses?.some(response => response.execution_state === 'running')
            : own.some(call => call.purpose === 'chat' && call.agent_id === null && call.model_id === conversation.model_id);
        turn.execution_state = turn.status === 'pending' ? active ? 'running' : 'waiting' : null;
    }
}
