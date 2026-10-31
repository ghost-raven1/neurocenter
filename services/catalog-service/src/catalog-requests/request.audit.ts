export const REQUEST_AUDIT_ACTIONS = [
    'create',
    'edit',
    'start',
    'needs_info',
    'reject',
    'complete',
    'resubmit',
    'cancel',
].map((action) => 'catalog_request.' + action);
export const isRequestAudit = (action: string): boolean => REQUEST_AUDIT_ACTIONS.includes(action);

/** The shared journal keeps decision metadata; descriptions, source URLs and comments stay in the request. */
export function requestAuditSnapshot(value: unknown): Record<string, string | number | null> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>,
        result: Record<string, string | number | null> = {};
    for (const key of ['id', 'title', 'kind', 'assetType', 'projectId', 'status'])
        if (typeof input[key] === 'string' || input[key] === null) result[key] = input[key] as string | null;
    if (Number.isSafeInteger(input.revision) && Number(input.revision) > 0) result.revision = Number(input.revision);
    return result;
}
