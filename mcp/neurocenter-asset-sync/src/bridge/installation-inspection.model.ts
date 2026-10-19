export type InspectionStatus = 'synced' | 'modified' | 'missing' | 'unknown';
export type InspectionIssue = 'inspection-busy' | 'binding-changed' | 'receipt-missing' | 'receipt-invalid' | 'receipt-mismatch'
    | 'ledger-missing' | 'ledger-invalid' | 'ledger-mismatch' | 'file-missing' | 'file-modified' | 'file-unsafe'
    | 'config-missing' | 'config-invalid' | 'config-modified' | 'config-ambiguous' | 'limit-exceeded'
    | 'read-failed' | 'snapshot-changed' | 'inspection-failed' | 'runtime-path-unverified';
export interface InstallationInspection {
    schemaVersion: 1;
    projectId: string;
    bindingId: string;
    assetId: string;
    assetKind: string;
    version: number;
    manifest: string;
    checkedAt: string;
    readiness: 'unverified';
    state: 'checked' | 'busy';
    status: InspectionStatus;
    issues: InspectionIssue[];
    ownerKeys?: string[];
}
