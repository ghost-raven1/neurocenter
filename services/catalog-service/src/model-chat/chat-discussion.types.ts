import type { ChatAgentSnapshot, ChatResolvedAgent } from './chat-group.types';
import type { ChatMessage, ChatTurn } from './chat.types';
import type { IModel } from '../models/model.types';

/** A discussion is one private turn, never an administrative agent or a recursive task tree. */
export const DISCUSSION_LIMITS = Object.freeze({ calls: 5, depth: 1, contributions: 3, deadlineMs: 120000, stepMs: 40000, reserveMs: 2000, outputBytes: 16384 });
export type DiscussionPhase = 'context' | 'planning' | 'response' | 'critique' | 'synthesis';
export interface DiscussionTask { agentId: string; instruction: string }
export interface DiscussionPlan { responses: DiscussionTask[]; critic: DiscussionTask | null }
export interface DiscussionCompletion { content: string; finishReason: 'stop' | 'length' }
export interface DiscussionOutcome { agentId: string; phase: 'response' | 'critique'; state: 'done' | 'failed'; content?: string; finishReason?: DiscussionCompletion['finishReason'] }
export interface DiscussionRun {
    turn_id: string; request_id: string; actor_role: string; model: IModel; roster: ChatResolvedAgent[];
    calls_started: number; deadline_at: string | Date;
    summary_policy?: 'legacy' | 'unique-v1';
}
export interface DiscussionStep {
    id: string; turn_id: string; request_id: string; sequence: number; step_key: string; phase: DiscussionPhase;
    snapshot: ChatAgentSnapshot | null; model_id: string; model_pin: string; input_hash: string;
    status: 'pending' | 'done' | 'failed' | 'cancelled'; finish_reason: 'stop' | 'length' | null; output: string | null; error: string | null;
    execution_state?: 'waiting' | 'running';
}
export interface DiscussionCall {
    key: string; phase: Exclude<DiscussionPhase, 'context'>; messages: ChatMessage[];
    task?: DiscussionTask; remainingSteps: number;
}
export interface DiscussionResult extends DiscussionCompletion { outcomes: DiscussionOutcome[] }
export type DiscussionInvoke = (call: DiscussionCall) => Promise<DiscussionCompletion>;
export type DiscussionAnswer = NonNullable<ChatTurn['answer']>;
