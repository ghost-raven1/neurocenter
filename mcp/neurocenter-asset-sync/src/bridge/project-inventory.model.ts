export type InventoryKind = 'skill' | 'mcp' | 'plugin' | 'unknown';
export type InventoryState = 'managed' | 'unmanaged' | 'damaged' | 'unsafe' | 'unreadable';
export interface InventoryEntry {
    candidateId: string; kind: InventoryKind; path: string; state: InventoryState; reason: string;
}
export interface ProjectInventory {
    schemaVersion: 1; projectId: string; bindingId: string; instanceId: string; scanId: string; digest: string;
    checkedAt: string; expiresAt: string; complete: boolean; issues: string[]; entries: InventoryEntry[];
}
export interface InventorySnapshot {
    relative: string; type: 'file' | 'directory'; fingerprint: string | null; sha256: string | null;
}
export interface PrivateInventoryScan {
    schemaVersion: 1; root: string; summary: ProjectInventory; snapshots: InventorySnapshot[]; selectors: Record<string, string>;
}
export interface AdoptCandidateOptions { scanId: string; candidateId: string; digest: string }
