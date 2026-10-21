import type { IBridgeJob } from '../McpBridge/api';
import type { useBridge } from '../McpBridge/useBridge';

export type TAgentMode = 'primary' | 'subagent' | 'all';
export type TAgentPermissionAction = 'allow' | 'ask' | 'deny';
export type TAgentPermission = Record<string, TAgentPermissionAction>;
export interface IAgentDefinition {
    description: string; prompt: string; mode: TAgentMode; permission: TAgentPermission;
    model?: string; temperature?: number; topP?: number; steps?: number;
}
export type IAgentOverrides = Partial<Omit<IAgentDefinition, 'model' | 'temperature' | 'topP' | 'steps'>> & {
    model?: string | null; temperature?: number | null; topP?: number | null; steps?: number | null;
};
export interface ICatalogAgent {
    id: string; slug: string; name: string; description: string;
    version: number; manifest: string; definition: IAgentDefinition;
    archivedAt: string | null; createdAt: string; updatedAt: string;
}
export interface IProjectAgent {
    agentId: string; version: number; manifest: string; card: ICatalogAgent;
    overrides: IAgentOverrides; effective: IAgentDefinition; enabled: boolean; removed: boolean;
}
export interface IAgentDelivery {
    deviceId: string; bindingId: string; instanceId: string; jobId: string;
    state: string; revision: number; manifestSha256: string; message: string;
    createdAt: string; updatedAt: string; result: Record<string, unknown> | null;
}
export interface IAgentCatalog {
    items: ICatalogAgent[]; assignments: IProjectAgent[];
    revision: number | null; deliveries: IAgentDelivery[];
}
export interface IAgentCreate {slug: string; name: string; description: string; definition: IAgentDefinition}
export interface IAgentProjectPatch {overrides?: IAgentOverrides; enabled?: boolean; version?: number; manifest?: string}
export interface IAgentSaved {revision: number; assignment: IProjectAgent}
export interface IAgentConnectTarget {deviceId: string; expectedBindingId: string; expectedInstanceId: string}
export type TAgentJob = IBridgeJob & {desiredRevision?: number};
export interface IAgentCatalogProps {
    projectId?: string; projectName?: string; embedded?: boolean;
    canManage: boolean; isMain: boolean; bridge: ReturnType<typeof useBridge>;
}
