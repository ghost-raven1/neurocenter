import type { IAgentDefinition, IProjectAgentsResult } from '../../../shared/project-agents.cjs';
export type TAgentOverrides = Partial<Omit<IAgentDefinition, 'model' | 'temperature' | 'topP' | 'steps'>> & {
    model?: string | null;
    temperature?: number | null;
    topP?: number | null;
    steps?: number | null;
};
export interface IAgentCard {
    id: string;
    slug: string;
    name: string;
    description: string;
    definition: IAgentDefinition;
    version: number;
    manifest: string;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface IProjectAgentAssignment {
    agentId: string;
    version: number;
    manifest: string;
    overrides: TAgentOverrides;
    enabled: boolean;
    removed: boolean;
    card: IAgentCard;
    effective: IAgentDefinition;
}
export interface IAgentDelivery {
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
    result: IProjectAgentsResult | null;
}
export interface IAgentList {
    items: IAgentCard[];
    assignments: IProjectAgentAssignment[];
    revision: number | null;
    deliveries: IAgentDelivery[];
}
export interface IAgentHeadRow {
    id: string;
    slug: string;
    name: string;
    definition: IAgentDefinition;
    version: number;
    manifest: string;
    archived_at: string | Date | null;
    created_at: string | Date;
    updated_at: string | Date;
}
export interface IAgentAssignmentRow {
    project_id: string;
    agent_id: string;
    version: number;
    manifest: string;
    overrides: TAgentOverrides;
    enabled: boolean;
    removed: boolean;
}
