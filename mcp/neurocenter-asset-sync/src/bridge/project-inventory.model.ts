export type TInventoryKind = 'skill' | 'mcp' | 'plugin' | 'unknown';
export type TInventoryState = 'managed' | 'unmanaged' | 'damaged' | 'unsafe' | 'unreadable';
export interface IInventoryEntry {
    candidateId: string;
    kind: TInventoryKind;
    path: string;
    state: TInventoryState;
    reason: string;
}
export interface IProjectInventory {
    schemaVersion: 1;
    projectId: string;
    bindingId: string;
    instanceId: string;
    scanId: string;
    digest: string;
    checkedAt: string;
    expiresAt: string;
    complete: boolean;
    issues: string[];
    entries: IInventoryEntry[];
}
export interface IInventorySnapshot {
    relative: string;
    type: 'file' | 'directory';
    fingerprint: string | null;
    sha256: string | null;
}
export interface IPrivateInventoryScan {
    schemaVersion: 1;
    root: string;
    summary: IProjectInventory;
    snapshots: IInventorySnapshot[];
    selectors: Record<string, string>;
}
export interface IAdoptCandidateOptions {
    scanId: string;
    candidateId: string;
    digest: string;
}
