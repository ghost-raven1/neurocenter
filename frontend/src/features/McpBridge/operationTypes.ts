export type TWorkspaceBindingMode = 'new' | 'new-copy' | 'adopt-legacy' | 'transfer' | 'resume';
export interface IBridgeBinding {
    projectId: string; folderName: string; valid?: boolean; bindingId?: string; instanceId?: string;
    identityStatus?: 'verified' | 'legacy' | 'copied' | 'changed' | 'unavailable'; previousBindingId?: string; error?: string;
}
export interface IWorkspacePreparation {
    projectId: string; folderName: string; mode: TWorkspaceBindingMode; preparation: string; requiresFileVerification: boolean;
    expectedBindingId?: string; expectedInstanceId?: string; instanceId?: string; previousBindingId?: string; sourceFolderName?: string;
}
export interface ILocalChangeFile {
    path: string; operation: 'add' | 'replace' | 'remove'; beforeSha256: string | null; afterSha256: string | null;
    beforeBytes: number; afterBytes: number; binary: boolean;
}
export interface ILocalChangePlan {
    schemaVersion: 1; planId: string; revision: 1; digest: string; projectId: string; bindingId: string; instanceId: string;
    assetId: string; assetKind: 'skill' | 'mcp' | 'plugin'; version: number; manifest: string;
    checkedAt: string; expiresAt: string; status: 'prepared'; files: ILocalChangeFile[];
    runtimeRepairRequired?: true;
}
export type TInventoryCapability = 'project-inventory-v1' | 'adopt-installation-v1' | 'local-recovery-v1';
export const inventoryReasons = ['managed-receipt','managed-project-learning','unmanaged-files','unmanaged-config','receipt-invalid','receipt-missing','file-mismatch',
    'config-mismatch','config-invalid','unsafe-path','read-failed','read-limit','snapshot-changed','entry-limit','project-busy','binding-changed','unknown-layout'] as const;
export interface IProjectInventoryEntry {
    candidateId: string; kind: 'skill' | 'mcp' | 'plugin' | 'unknown'; path: string;
    state: 'managed' | 'unmanaged' | 'damaged' | 'unsafe' | 'unreadable'; reason: typeof inventoryReasons[number];
}
/** Обзор ограничен выбранной папкой проекта, без содержимого файлов и абсолютных путей. */
export interface IProjectInventory {
    schemaVersion: 1; projectId: string; bindingId: string; instanceId: string; scanId: string; digest: string;
    checkedAt: string; expiresAt: string; complete: boolean; issues: Array<typeof inventoryReasons[number]>; entries: IProjectInventoryEntry[];
}
export const localVariantReasons = ['ready','legacy-unverified','different-installation','different-instance','shared-dependency',
    'no-restorable-files','invalid-backup','limit-exceeded'] as const;
export interface ILocalVariant {
    recoveryId: string; createdAt: string; files: number; eligible: boolean; reason: typeof localVariantReasons[number];
}
export interface ILocalVariants {
    schemaVersion: 1; projectId: string; bindingId: string; instanceId: string; assetId: string; assetKind: 'skill'|'mcp'|'plugin';
    version: number; manifest: string; checkedAt: string; complete: boolean; entries: ILocalVariant[];
}
export const runtimeCodes = ['verified', 'not-approved', 'invalid-package', 'installation-not-current', 'inspection-busy', 'authorization-denied',
    'runtime-unavailable', 'runtime-mismatch', 'unsupported-platform', 'managed-configuration', 'dependency-required', 'configuration-required', 'invalid-skill',
    'entrypoint-unsupported', 'external-command-unsupported', 'unsafe-environment', 'mcp-connect-failed', 'mcp-list-failed', 'plugin-initialization-failed',
    'timeout', 'output-limit', 'probe-failed', 'configuration-changed'] as const;
export interface IRuntimeProbe {
    schemaVersion: 1; projectId: string; bindingId: string; assetId: string; assetKind: string; version: number; manifest: string;
    approvalManifest: string; checkedAt: string; engineVersion: string; engineSha256: string;
    configurationRevisions?: Array<{assetId: string; manifest: string; revision: string | null}>;
    status: 'not_checked' | 'passed' | 'needs_configuration' | 'failed' | 'unsupported' | 'stale' | 'busy'; code: typeof runtimeCodes[number];
    counts: { packages: number; files: number; skills: number; mcp: number; tools: number; resources: number; prompts: number; pluginsInitialized: number };
}
