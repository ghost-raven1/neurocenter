import type { IInstallSet, IPackageRef } from './install-set.js';
import type { IFileChange } from './installation-journal.js';
import type { ISnapshotFingerprint } from './installation-plan.js';

export interface ILocalChangeFile {
    path: string;
    operation: 'add' | 'replace' | 'remove';
    beforeSha256: string | null;
    afterSha256: string | null;
    beforeBytes: number;
    afterBytes: number;
    binary: boolean;
}
export interface ILocalChangeSummary {
    schemaVersion: 1;
    planId: string;
    revision: 1;
    digest: string;
    projectId: string;
    bindingId: string;
    instanceId: string;
    assetId: string;
    assetKind: 'skill' | 'mcp' | 'plugin';
    version: number;
    manifest: string;
    checkedAt: string;
    expiresAt: string;
    status: 'prepared';
    files: ILocalChangeFile[];
    runtimeRepairRequired?: true;
}
export interface IPrivateLocalChangePlan {
    schemaVersion: 1;
    summary: ILocalChangeSummary;
    root: string;
    installationManifest: string;
    packages: IPackageRef[];
    changes: IFileChange[];
    snapshots: ISnapshotFingerprint[];
    reportSha256: string;
    purpose?: 'adopt' | 'restore-local';
    sourceId?: string;
}
export interface IApplyLocalChangeOptions {
    planId: string;
    revision: 1;
    digest: string;
    expectedBindingId: string;
    installSet?: IInstallSet;
}
