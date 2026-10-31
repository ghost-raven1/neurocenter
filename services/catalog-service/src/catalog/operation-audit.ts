/** Historical identities come from the deleted-project receipt or immutable job package, never current cards. */
export const operationAuditDetailsSql = `CASE
    WHEN o.resource_type='project' AND o.type='DELETE' THEN
        (SELECT jsonb_build_object('before',NULL,'after',jsonb_build_object('name',r.project_name))
         FROM project_retirements r WHERE r.project_id=o.resource_id AND r.actor=o.actor AND r.origin='deletion')
    WHEN o.resource_type='bridge' THEN
        (SELECT jsonb_build_object('before',NULL,'after',jsonb_build_object('jobKind',j.kind,
            'name',j.payload#>>'{package,plugin,name}','kind',j.payload#>>'{package,plugin,kind}',
            'version',j.payload#>'{package,plugin,version}')) FROM bridge_jobs j
         WHERE j.id=o.resource_id AND j.email=o.actor AND j.project_id IS NOT DISTINCT FROM o.project_id)
    ELSE NULL END`;

/** Unknown payloads and technical/private fields cannot escape the operation identity projection. */
export function operationAuditSnapshot(value: unknown): Record<string, string | number> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>,
        snapshot: Record<string, string | number> = {};
    for (const key of ['name', 'jobKind', 'kind'])
        if (
            typeof input[key] === 'string' &&
            input[key] &&
            Buffer.byteLength(input[key]) <= 512 &&
            !/[\x00-\x1f\x7f]/.test(input[key] as string)
        )
            snapshot[key] = input[key] as string;
    if (Number.isSafeInteger(input.version) && Number(input.version) > 0) snapshot.version = Number(input.version);
    return Object.keys(snapshot).length ? snapshot : null;
}
