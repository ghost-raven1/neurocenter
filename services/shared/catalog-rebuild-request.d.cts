export interface ICatalogRebuildRequest {
    schemaVersion: 1;
    requestId: string;
    sourceRevision: string;
    requestedAt: string;
}
export function parseCatalogRebuildRequest(value: unknown): ICatalogRebuildRequest;
export function makeCatalogRebuildRequest(sourceRevision: string): ICatalogRebuildRequest;
export function catalogRebuildRequestKey(requestId: string, component: string): string;
