import type {
    TAgentMethod,
    IAgentMethodWorkflowAgentIdentity,
    IAgentMethodWorkflowResult,
} from '../../../shared/agent-method-workflow.cjs';

export interface IMethodChatOrigin {
    roomId: string;
    messageId: string;
}
export type TMethodChatPublication = 'pending' | 'published' | 'withheld';
export interface IProjectChatMethodWorkflowPage {
    items: IProjectChatMethodWorkflow[];
    hasMore: boolean;
    nextCursor: string | null;
}
/** Shared chat receipt exposes observed facts, never the private device payload or free-form logs. */
export interface IProjectChatMethodWorkflow {
    jobId: string;
    workflowId: string;
    method: TAgentMethod;
    agent: IAgentMethodWorkflowAgentIdentity;
    state: 'queued' | 'running' | 'reconciling' | 'succeeded' | 'failed' | 'cancelled';
    percent: number | null;
    createdAt: string;
    startedAt: string | null;
    updatedAt: string;
    canCancel: boolean;
    publicationState: TMethodChatPublication;
    result?: IAgentMethodWorkflowResult;
}
