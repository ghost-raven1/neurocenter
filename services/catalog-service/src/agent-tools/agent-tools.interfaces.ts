import type { IChatMessage } from '../model-chat/chat.interfaces';
import type { IChatContextSettings } from '../model-chat/chat-context';
import type { PoolClient } from 'pg';

export interface IAgentToolGrant {
    protocol: 'json-actions-v1';
    rag: boolean;
    publicChats?: { modelId: string; expectedModelPin: string; consent: true; roomId?: string };
    systemRoles?: boolean;
}

export type TAgentToolAction =
    | { action: 'finish' }
    | { action: 'rag_search'; query: string }
    | { action: 'rag_read'; sourceId: string }
    | { action: 'public_chat_search'; query: string }
    | { action: 'request_system_role'; roleId: string; instruction: string };

export type TAgentToolState = 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';

export interface IAgentToolOwner {
    kind: 'model-chat' | 'project-chat';
    originId: string;
    turnId: string;
    recipientId: string;
    generation: string;
    ownerEmail: string;
    actorRole: string;
    projectId: string;
    agentId: string | null;
    modelId: string;
    modelPin: string;
    grant: IAgentToolGrant;
}

export type TAgentToolDb = Pick<PoolClient, 'query'>;

export interface IAgentToolStepRow {
    id: string;
    owner_kind: IAgentToolOwner['kind'];
    origin_id: string;
    turn_id: string;
    recipient_id: string;
    generation: string;
    owner_email: string;
    actor_role: string;
    project_id: string;
    agent_id: string | null;
    model_id: string;
    model_pin: string;
    grant_snapshot: IAgentToolGrant;
    sequence: number;
    action: string;
    input: Record<string, unknown>;
    input_hash: string;
    state: TAgentToolState;
    output: unknown | null;
    reference: Record<string, unknown> | null;
    error: string | null;
    deadline_at: Date | string;
    created_at: Date | string;
    updated_at: Date | string;
}

export interface IAgentToolScope {
    owner: IAgentToolOwner;
    messages: IChatMessage[];
    settings: IChatContextSettings;
    signal: AbortSignal;
    assertCurrent(db?: TAgentToolDb): Promise<void>;
    /** Final answer owners may transition a turn to done inside their authorized transaction. */
    assertAuthorized?(db?: TAgentToolDb): Promise<void>;
    infer(messages: IChatMessage[], beforeInference: () => Promise<void>): Promise<string>;
    execute(
        action: Exclude<TAgentToolAction, { action: 'finish' }>,
        step: IAgentToolStepRow,
        reference: (value: Record<string, unknown>) => Promise<void>,
    ): Promise<unknown>;
    observe?(action: Exclude<TAgentToolAction, { action: 'finish' }>, output: unknown): void | Promise<void>;
    present?(action: Exclude<TAgentToolAction, { action: 'finish' }>, output: unknown): Promise<unknown>;
}

export interface IAgentToolCapabilities {
    protocol: 'json-actions-v1';
    available: boolean;
    reason?: string;
    rag: { available: boolean; reason?: string };
    publicChats: {
        available: boolean;
        models: Array<{ id: string; name: string; pin: string; dimension: number }>;
        reason?: string;
    };
    systemRoles: { available: boolean; reason?: string };
    mcp: { available: false; reason: string };
    limits: { steps: number; deadlineMs: number };
}
