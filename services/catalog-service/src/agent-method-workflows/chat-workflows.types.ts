import type {
    AgentMethod,
    AgentMethodWorkflowAgentIdentity,
    AgentMethodWorkflowResult,
} from '../../../shared/agent-method-workflow.cjs';

export interface MethodChatOrigin {
    roomId: string;
    messageId: string;
}
export type MethodChatPublication = 'pending' | 'published' | 'withheld';
export interface ProjectChatMethodWorkflowPage {
    items: ProjectChatMethodWorkflow[];
    hasMore: boolean;
    nextCursor: string | null;
}
/** Shared chat receipt exposes observed facts, never the private device payload or free-form logs. */
export interface ProjectChatMethodWorkflow {
    jobId: string;
    workflowId: string;
    method: AgentMethod;
    agent: AgentMethodWorkflowAgentIdentity;
    state: 'queued' | 'running' | 'reconciling' | 'succeeded' | 'failed' | 'cancelled';
    percent: number | null;
    createdAt: string;
    startedAt: string | null;
    updatedAt: string;
    canCancel: boolean;
    publicationState: MethodChatPublication;
    result?: AgentMethodWorkflowResult;
}
