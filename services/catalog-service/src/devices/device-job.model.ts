import type {AgentMethod} from '../../../shared/agent-method-workflow.cjs';

export interface Job {
    id: string;
    device_id: string;
    email: string;
    role: string;
    project_id: string | null;
    kind: string;
    payload: Record<string, unknown>;
    state: string;
    lease: string;
    lease_until: Date;
    percent: number|null;
}
export interface JobInput {
    deviceId: string;
    projectId?: string;
    expectedLearningRevision?:number; expectedLearningDigest?:string; memoryMode?:'sync'|'cleanup';
    kind: string;
    requestKey: string;
    scope?: 'global'|'project';
    runtimeCachePolicy?: import('../../../shared/runtime-cache-policy.cjs').RuntimeCachePolicyPayload;
    assetKind?: string;
    assetId?: string;
    version?: number;
    folderName?: string;
    expectedManifest?:string;
    expectedBindingId?: string;
    planId?: string;
    planRevision?: number;
    bindingMode?: string;
    expectedInstanceId?: string;
    preparationJobId?: string;
    expectedPreparation?: string;
    changePlanId?: string;
    changePlanRevision?: number;
    expectedChangeDigest?: string;
    consentManifest?: string;
    inventoryJobId?: string; scanId?: string; candidateId?: string; expectedInventoryDigest?: string;
    recoveryId?: string; restorePaths?: string[];
    configurationPreparationJobId?: string; expectedConfigurationSchemaDigest?: string;
    expectedConfigurationRevisions?: Array<{assetId:string;manifest:string;revision:string|null}>;
    expectedEmbeddingRevision?: number;
    expectedEmbeddingPin?: string;
    reindex?:true;
    snapshotId?:string;
    expectedAgentsRevision?:number;
    workflow?:{method:AgentMethod;instruction:string;checks:Array<{command:string;args:string[]}>};
    providerKind?:'openai-compatible'|'ollama'|'codex-bridge';
    catalogModelId?:string;
    expectedModelPin?:string;
    expectedProviderSchemaDigest?:string;
}
