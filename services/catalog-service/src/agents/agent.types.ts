import type { AgentDefinition, ProjectAgentsResult } from '../../../shared/project-agents.cjs';
export type AgentOverrides = Partial<Omit<AgentDefinition, 'model' | 'temperature' | 'topP' | 'steps'>> & {
    model?: string | null;
    temperature?: number | null;
    topP?: number | null;
    steps?: number | null;
};
export interface AgentCard {
    id: string;
    slug: string;
    name: string;
    description: string;
    definition: AgentDefinition;
    version: number;
    manifest: string;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface ProjectAgentAssignment {
    agentId: string;
    version: number;
    manifest: string;
    overrides: AgentOverrides;
    enabled: boolean;
    removed: boolean;
    card: AgentCard;
    effective: AgentDefinition;
}
export interface AgentDelivery {
    deviceId: string;
    bindingId: string;
    instanceId: string;
    jobId: string;
    state: string;
    revision: number;
    manifestSha256: string;
    message: string;
    createdAt: string;
    updatedAt: string;
    result: ProjectAgentsResult | null;
}
export interface AgentList {
    items: AgentCard[];
    assignments: ProjectAgentAssignment[];
    revision: number | null;
    deliveries: AgentDelivery[];
}
export interface AgentHeadRow {
    id: string;
    slug: string;
    name: string;
    definition: AgentDefinition;
    version: number;
    manifest: string;
    archived_at: string | Date | null;
    created_at: string | Date;
    updated_at: string | Date;
}
export interface AgentAssignmentRow {
    project_id: string;
    agent_id: string;
    version: number;
    manifest: string;
    overrides: AgentOverrides;
    enabled: boolean;
    removed: boolean;
}
