import type { IChatAgentSnapshot, IChatResolvedAgent } from './chat-group.interfaces';
import type { IChatMessage, IChatTurn } from './chat.interfaces';
import type { IModel } from '../models/model.interfaces';

export type TDiscussionPhase = 'context' | 'planning' | 'response' | 'critique' | 'synthesis';

export interface IDiscussionTask {
    agentId: string;
    instruction: string;
}

export interface IDiscussionPlan {
    responses: IDiscussionTask[];
    critic: IDiscussionTask | null;
}

export interface IDiscussionCompletion {
    content: string;
    finishReason: 'stop' | 'length';
}

export interface IDiscussionOutcome {
    agentId: string;
    phase: 'response' | 'critique';
    state: 'done' | 'failed';
    content?: string;
    finishReason?: IDiscussionCompletion['finishReason'];
}

export interface IDiscussionRun {
    turn_id: string;
    request_id: string;
    actor_role: string;
    model: IModel;
    roster: IChatResolvedAgent[];
    calls_started: number;
    deadline_at: string | Date;
    summary_policy?: 'legacy' | 'unique-v1';
}

export interface IDiscussionStep {
    id: string;
    turn_id: string;
    request_id: string;
    sequence: number;
    step_key: string;
    phase: TDiscussionPhase;
    snapshot: IChatAgentSnapshot | null;
    model_id: string;
    model_pin: string;
    input_hash: string;
    status: 'pending' | 'done' | 'failed' | 'cancelled';
    finish_reason: 'stop' | 'length' | null;
    output: string | null;
    error: string | null;
    execution_state?: 'waiting' | 'running';
}

export interface IDiscussionCall {
    key: string;
    phase: Exclude<TDiscussionPhase, 'context'>;
    messages: IChatMessage[];
    task?: IDiscussionTask;
    remainingSteps: number;
}

export interface IDiscussionResult extends IDiscussionCompletion {
    outcomes: IDiscussionOutcome[];
}

export type TDiscussionInvoke = (call: IDiscussionCall) => Promise<IDiscussionCompletion>;

export type TDiscussionAnswer = NonNullable<IChatTurn['answer']>;
