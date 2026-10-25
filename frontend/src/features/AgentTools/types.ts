export interface AgentToolGrant {protocol: 'json-actions-v1'; rag: boolean; publicChats?: {modelId: string; expectedModelPin: string; consent: true; roomId?: string}; systemRoles?: boolean;}
export interface AgentToolModel {id: string; name: string; pin: string; dimension: number;}
export interface AgentToolCapabilities {
    protocol: 'json-actions-v1'; available: boolean; reason?: string;
    rag: {available: boolean; reason?: string}; publicChats: {available: boolean; models: AgentToolModel[]; reason?: string};
    systemRoles: {available: boolean; reason?: string}; mcp: {available: false; reason: string}; limits: {steps: number; deadlineMs: number};
}
export interface AgentToolsDraft {initialized: boolean; enabled: boolean; rag: boolean; systemRoles: boolean; publicChats: boolean; consent: boolean; model?: {id: string; pin: string; name?: string}; modelTouched: boolean; roomId?: string; restored?: AgentToolGrant;}
export interface AgentToolStep {
    id: string; turn_id: string; recipient_id: string; agent_id: string | null; model_id: string; sequence: number; action: string;
    state: 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'unknown' | 'cancelled'; error: string | null;
    reference: Record<string, unknown> | null; created_at: string; updated_at: string; input?: Record<string, unknown>; output?: unknown;
}
