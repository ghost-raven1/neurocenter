import api from '../../core/api/base';
import type { IInstallPlan, IInstallPlanInput } from './installPlanTypes';
import type { IBridgeBinding, IRuntimeProbe, TWorkspaceBindingMode } from './operationTypes';
import type { IMcpConfigurationRevision, IMcpConfigurationStatus } from './mcpConfigurationTypes';
export type { IInstallPlan, IInstallPlanInput } from './installPlanTypes';
export type { IBridgeBinding, IRuntimeProbe, IWorkspacePreparation, ILocalChangePlan, IProjectInventory, IProjectInventoryEntry,
    ILocalVariant, ILocalVariants, TWorkspaceBindingMode } from './operationTypes';

export interface IBridgePair {name:string;fingerprint:string;approved:boolean;expiresAt:string;}

export interface IBridgeDevice {
    id: string;
    name: string;
    role: string;
    fingerprint: string;
    online: boolean;
    lastSeen: string | null;
    expiresAt?: string;
    requiresReconnect?: boolean;
    report: {
        root?: string | null;
        rootError?: string;
        folders?: string[];
        platform?: string;
        arch?: string;
        runtimeArtifactTarget?: string;
        runtimeVersion?: string;
        bridgeVersion?: string;
        buildId?: string;
        protocolVersion?: number;
        capabilities?: string[];
        previousDeviceCompletions?: number;
        ragSupported?: boolean;
        ragError?: string;
        bindings?: IBridgeBinding[];
    };
}
export interface IBridgeJob {
    id: string;
    deviceId: string;
    projectId: string | null;
    kind: string;
    state: string;
    percent?: number;
    message: string;
    assetId?: string;
    assetKind?: string;
    version?: string;
    bindingId?: string | null;
    expectedManifest?: string;
    expectedInstanceId?: string;
    createdAt: string;
    startedAt?: string | null;
    updatedAt: string;
    result?: Record<string, unknown>;
}
export type TInspectionIssue = 'inspection-busy' | 'binding-changed' | 'receipt-missing' | 'receipt-invalid' | 'receipt-mismatch'
    | 'ledger-missing' | 'ledger-invalid' | 'ledger-mismatch' | 'file-missing' | 'file-modified' | 'file-unsafe'
    | 'config-missing' | 'config-invalid' | 'config-modified' | 'config-ambiguous' | 'limit-exceeded' | 'read-failed'
    | 'snapshot-changed' | 'inspection-failed' | 'runtime-path-unverified';
export interface IInstallationInspection {
    schemaVersion: 1;
    projectId: string;
    bindingId: string;
    assetId: string;
    assetKind: 'skill' | 'mcp' | 'plugin';
    version: number;
    manifest: string;
    checkedAt: string;
    readiness: 'unverified';
    state: 'checked' | 'busy';
    status: 'synced' | 'modified' | 'missing' | 'unknown';
    issues: TInspectionIssue[];
}
export interface IBridgeInstallation {
    deviceId: string;
    projectId: string;
    assetId: string;
    assetKind: 'skill' | 'mcp' | 'plugin';
    version: number;
    name: string;
    manifest: string;
    updatedAt: string;
    bindingId?: string | null;
    bindingChanged?: boolean;
    isCurrentBinding?: boolean;
    legacyBinding?: boolean;
    folderName?: string;
    inspection?: IInstallationInspection;
    runtime?: IRuntimeProbe;
    runtimeObservedAt?: string;
    configurationSchemaDigest?: string;
    configurationInvalidatedAt?: string;
    configurationObservedAt?: string;
    configuration?: IMcpConfigurationStatus;
    ragUi?: { supported: true; mode: 'web' };
    hostedEmbedding?: { supported: true;reindexSupported?:true };
}
interface IBridgeJobInputBase {
    deviceId: string;
    projectId?: string;
    requestKey: string;
    folderName?: string;
    assetId?: string;
    assetKind?: string;
    version?: number;
    expectedManifest?: string;
    planId?: string;
    planRevision?: number;
}
export type IBridgeJobInput = IBridgeJobInputBase & (
    {kind: 'open-rag-ui'; projectId: string; assetId: string; assetKind: 'mcp' | 'plugin'; version: number;
        expectedManifest: string; expectedBindingId: string; expectedInstanceId: string}
    | {kind: 'connect-rag-model'; projectId: string; assetId: string; assetKind: 'mcp' | 'plugin'; version: number;
        expectedManifest: string; expectedBindingId: string; expectedInstanceId: string;
        expectedEmbeddingRevision: number; expectedEmbeddingPin: string;reindex:true}
    | {kind: 'uninstall' | 'inspect-installation'; assetId: string; assetKind: string; expectedManifest: string; expectedBindingId: string}
    | {kind: 'prepare-bind-project' | 'bind-project'; projectId: string; folderName: string; bindingMode: TWorkspaceBindingMode;
        expectedBindingId?: string; expectedInstanceId?: string; preparationJobId?: string; expectedPreparation?: string}
    | {kind: 'prepare-local-change' | 'apply-local-change' | 'open-local-change-report' | 'probe-runtime'; projectId: string;
        assetId: string; assetKind: string; expectedManifest: string; expectedBindingId: string;
        changePlanId?: string; changePlanRevision?: number; expectedChangeDigest?: string; consentManifest?: string;
        expectedConfigurationRevisions?: IMcpConfigurationRevision[]}
    | {kind: 'prepare-mcp-configuration' | 'get-mcp-configuration-status' | 'open-mcp-configuration'; projectId: string;
        assetId: string; assetKind: 'mcp'; version: number; expectedManifest: string; expectedBindingId: string;
        configurationPreparationJobId?: string; expectedConfigurationSchemaDigest?: string}
    | {kind: 'open-local-recovery-folder'; projectId: string; expectedBindingId: string}
    | {kind: 'scan-project-inventory'; projectId: string; expectedBindingId: string}
    | {kind: 'scan-opencode-models'; scope:'global'; projectId?:never; expectedBindingId?:never}
    | {kind: 'scan-opencode-models'; scope:'project'; projectId:string; expectedBindingId:string}
    | {kind: 'prepare-adopt-installation'; projectId: string; assetId: string; assetKind: string; version: number;
        expectedBindingId: string; expectedManifest: string; planId: string; planRevision: number;
        inventoryJobId: string; scanId: string; candidateId: string; expectedInventoryDigest: string}
    | {kind: 'apply-adopt-installation' | 'list-local-variants' | 'prepare-local-restore' | 'apply-local-restore'; projectId: string;
        assetId: string; assetKind: string; expectedManifest: string; expectedBindingId: string;
        changePlanId?: string; changePlanRevision?: number; expectedChangeDigest?: string; recoveryId?: string; restorePaths?: string[]}
    | {kind: 'choose-root' | 'install' | 'restore-rag' | 'sync-rag'; expectedBindingId?: string}
);
export type IBridgeJobDraft = IBridgeJobInput extends infer T ? T extends IBridgeJobInput ? Omit<T, 'requestKey'> : never : never;
export const bridgeApi = {
    plan: async (id: string): Promise<IInstallPlan> =>
        (await api.get<IInstallPlan>('/api/device-install-plans/' + encodeURIComponent(id))).data,
    preparePlan: async (input: IInstallPlanInput): Promise<IInstallPlan> =>
        (await api.post<IInstallPlan>('/api/device-install-plans', input)).data,
    approvePlan: async (plan: Pick<IInstallPlan, 'id' | 'manifest' | 'revision'>): Promise<IInstallPlan> =>
        (await api.post<IInstallPlan>('/api/device-install-plans/' + encodeURIComponent(plan.id) + '/approve',
            { expectedManifest: plan.manifest, expectedRevision: plan.revision })).data,
    revokePlan: async (plan: Pick<IInstallPlan, 'id' | 'manifest' | 'revision'>): Promise<IInstallPlan> =>
        (await api.post<IInstallPlan>('/api/device-install-plans/' + encodeURIComponent(plan.id) + '/revoke',
            { expectedManifest: plan.manifest, expectedRevision: plan.revision })).data,
    devices: async (signal?:AbortSignal): Promise<IBridgeDevice[]> =>
        (await api.get<IBridgeDevice[]>('/api/devices',{signal,timeout:10000})).data,
    jobs: async (): Promise<IBridgeJob[]> =>
        (await api.get<IBridgeJob[]>('/api/device-jobs',{timeout:10000})).data,
    installations: async (): Promise<IBridgeInstallation[]> =>
        (await api.get<IBridgeInstallation[]>('/api/device-installations',{timeout:10000}))
            .data,
    create: async (input: IBridgeJobInput): Promise<IBridgeJob> =>
        (await api.post<IBridgeJob>('/api/device-jobs', input,{timeout:10000})).data,
    retry:async(id:string,requestKey:string):Promise<IBridgeJob> => (await api.post<IBridgeJob>('/api/device-jobs/'+encodeURIComponent(id)+'/retry',{requestKey})).data,
    cancel: async (id: string): Promise<void> => {
        await api.delete('/api/device-jobs/' + encodeURIComponent(id),{timeout:10000});
    },
    revoke: async (id: string): Promise<void> => {
        await api.delete('/api/devices/' + encodeURIComponent(id));
    },
    pair: async (
        code: string,
    ): Promise<IBridgePair> =>
        (await api.get('/api/device-pairs/' + encodeURIComponent(code),{timeout:15000})).data,
    approve: async (code: string): Promise<void> => {
        await api.post(
            '/api/device-pairs/' + encodeURIComponent(code) + '/approve',
            undefined,{timeout:15000},
        );
    },
};
