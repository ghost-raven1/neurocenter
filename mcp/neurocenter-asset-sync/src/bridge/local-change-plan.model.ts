import type { InstallSet, PackageRef } from './install-set.js';
import type { FileChange } from './installation-journal.js';
import type { SnapshotFingerprint } from './installation-plan.js';

export interface LocalChangeFile {
    path: string; operation: 'add' | 'replace' | 'remove';
    beforeSha256: string | null; afterSha256: string | null;
    beforeBytes: number; afterBytes: number; binary: boolean;
}
export interface LocalChangeSummary {
    schemaVersion: 1; planId: string; revision: 1; digest: string;
    projectId: string; bindingId: string; instanceId: string;
    assetId: string; assetKind: 'skill' | 'mcp' | 'plugin'; version: number; manifest: string;
    checkedAt: string; expiresAt: string; status: 'prepared'; files: LocalChangeFile[];
    runtimeRepairRequired?: true;
}
export interface PrivateLocalChangePlan {
    schemaVersion: 1; summary: LocalChangeSummary; root: string; installationManifest: string;
    packages: PackageRef[]; changes: FileChange[]; snapshots: SnapshotFingerprint[]; reportSha256: string;
    purpose?: 'adopt' | 'restore-local'; sourceId?: string;
}
export interface ApplyLocalChangeOptions {
    planId: string; revision: 1; digest: string; expectedBindingId: string; installSet?: InstallSet;
}
