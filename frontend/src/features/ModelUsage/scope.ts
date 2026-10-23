/** A valid server scope compares by its grant set, independently of SQL row ordering. */
export function usageScopeKey(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const scope = value as Record<string, unknown>;
    if (typeof scope.kind !== 'string' || !['all', 'projects', 'self'].includes(scope.kind) || !(scope.actorEmail === null || typeof scope.actorEmail === 'string' && scope.actorEmail.length > 0) || !Array.isArray(scope.projectIds) || !scope.projectIds.every(id => typeof id === 'string' && id.length > 0)) return null;
    return JSON.stringify([scope.kind, scope.actorEmail, [...new Set(scope.projectIds)].sort()]);
}
/** Pagination retains old rows only when both receipts confirm the same authorization scope. */
export function sameUsageScope(previous: unknown, next: unknown): boolean {
    const before = usageScopeKey(previous); return before !== null && before === usageScopeKey(next);
}
