import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { workspaceReport } from '../devices/device-report';
import { containerObservation, validComposeProject } from '../../../shared/container-observation.cjs';
import type { DiagnosticFact, DiagnosticKind } from './system-role.types';
type Db = Pick<PoolClient, 'query'>;
const unavailable = (reason: string): Record<string, unknown> => ({ available: false, reason });
/** Reads only a fresh safe observation from the existing authenticated, image-pinned snapshot runner. */
export async function composeContainerState(
    db: Db,
    environment: NodeJS.ProcessEnv,
    now = Date.now(),
): Promise<Record<string, unknown>> {
    const project = environment.SYSTEM_ROLE_COMPOSE_PROJECT,
        image = environment.SNAPSHOT_VERIFIER_IMAGE_DIGEST;
    if (!validComposeProject(project) || !image || !/^sha256:[a-f0-9]{64}$/.test(image))
        return unavailable('container-inspector-not-configured');
    const row = (
        await db.query<{ container_observation: unknown }>(
            `SELECT container_observation FROM project_snapshot_verifiers
        WHERE last_seen>now()-interval '60 seconds' AND image_digest=$1 AND container_observation->>'project'=$2
        ORDER BY last_seen DESC LIMIT 1`,
            [image, project],
        )
    ).rows[0];
    if (!row) return unavailable('container-runner-unavailable');
    let report;
    try {
        report = containerObservation(row.container_observation);
    } catch {
        return unavailable('container-observation-invalid');
    }
    const age = now - Date.parse(report.checkedAt);
    if (age < -5000 || age > 60000)
        return { ...unavailable('container-observation-stale'), checkedAt: report.checkedAt };
    return { ...report, scope: 'configured-compose-project' };
}

export interface RoleDiagnosticContext {
    db: Db;
    actor: string;
    projectId: string | null;
    main: boolean;
    ready: () => Promise<unknown>;
    environment?: NodeJS.ProcessEnv;
}
/** Each adapter returns a small allowlisted projection. Errors are reason codes, never raw logs or connection strings. */
export async function collectRoleDiagnostic(
    kind: DiagnosticKind,
    context: RoleDiagnosticContext,
    signal: AbortSignal,
): Promise<DiagnosticFact> {
    const fact: DiagnosticFact = {
        id: randomUUID(),
        kind,
        checkedAt: new Date().toISOString(),
        status: 'unavailable',
        data: unavailable('observation-unavailable'),
    };
    signal.throwIfAborted();
    try {
        if (kind === 'health') {
            await context.ready();
            fact.data = {
                available: true,
                catalog: 'ready',
                check: 'database-readiness',
                livenessAloneIsReadiness: false,
            };
        }
        if (kind === 'containers')
            fact.data =
                context.main && !context.projectId
                    ? await composeContainerState(context.db, context.environment ?? process.env)
                    : unavailable('system-scope-requires-main-admin');
        if (kind === 'project') {
            if (!context.projectId) fact.data = unavailable('project-not-selected');
            else {
                const row = (
                    await context.db.query(
                        `SELECT p.state,p.head_revision AS "headRevision",
                    (SELECT count(*)::int FROM project_models m WHERE m.project_id=p.id) AS models,
                    (SELECT count(*)::int FROM project_agents a WHERE a.project_id=p.id AND NOT a.removed) AS agents,
                    (SELECT count(*)::int FROM project_assets a WHERE a.project_id=p.id) AS assets,
                    (SELECT count(*)::int FROM operations o WHERE o.project_id=p.id AND o.state IN ('RUNNING','QUEUED')) AS "activeOperations"
                    FROM projects p WHERE p.id=$1`,
                        [context.projectId],
                    )
                ).rows[0];
                fact.data = row ? { available: true, ...row } : unavailable('project-unavailable');
            }
        }
        if (kind === 'index') {
            if (!context.projectId) fact.data = unavailable('project-not-selected');
            else {
                const profile =
                    (
                        await context.db.query(
                            'SELECT revision,data_revision,active_generation,active_snapshot,model_id,model_pin,dimension FROM project_embedding_settings WHERE project_id=$1',
                            [context.projectId],
                        )
                    ).rows[0] ?? null;
                const snapshots = (
                    await context.db.query(
                        'SELECT id,status,manifest_sha256,created_at,verified_at FROM project_snapshots WHERE project_id=$1 ORDER BY created_at DESC LIMIT 5',
                        [context.projectId],
                    )
                ).rows;
                const sync = (
                    await context.db.query(
                        'SELECT state,count(*)::int AS count FROM project_rag_sync_intents WHERE project_id=$1 GROUP BY state',
                        [context.projectId],
                    )
                ).rows;
                const reindex = (
                    await context.db.query(
                        'SELECT id,state,progress,created_at FROM project_reindex_plans WHERE project_id=$1 ORDER BY created_at DESC LIMIT 5',
                        [context.projectId],
                    )
                ).rows;
                fact.data = {
                    available: true,
                    profile,
                    snapshots,
                    sync,
                    reindex,
                    snapshotCaptureOwner: 'project-snapshots',
                    synchronizationOwner: 'bridge-rag-sync',
                    mutationPerformed: false,
                    chatSearch: 'separate-authorized-search-owner',
                };
            }
        }
        if (kind === 'bridge') {
            const rows = (
                await context.db.query<{ id: string; online: boolean; report: unknown }>(
                    `SELECT id,last_seen>now()-interval '40 seconds' AND expires_at>now() AS online,report
                FROM bridge_devices WHERE email=$1 AND NOT revoked ORDER BY last_seen DESC NULLS LAST LIMIT 20`,
                    [context.actor],
                )
            ).rows;
            const devices = rows.map((row) => {
                const report = workspaceReport(row.report),
                    capabilities = (Array.isArray(report.capabilities) ? report.capabilities : [])
                        .filter(
                            (value): value is string =>
                                typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value),
                        )
                        .slice(0, 80);
                return {
                    id: row.id,
                    online: row.online === true,
                    protocolVersion: report.protocolVersion ?? null,
                    buildId:
                        typeof report.buildId === 'string' && /^[a-f0-9]{64}$/.test(report.buildId)
                            ? report.buildId
                            : null,
                    capabilities,
                    bindings: (Array.isArray(report.bindings) ? report.bindings : [])
                        .filter((binding) => !context.projectId || binding.projectId === context.projectId)
                        .slice(0, 20)
                        .map((binding) => ({
                            valid: binding.valid === true,
                            identityStatus: binding.identityStatus ?? 'unavailable',
                        })),
                };
            });
            fact.data = { available: true, scope: 'initiator-owned-devices', devices };
        }
        signal.throwIfAborted();
        fact.status = fact.data.available === true ? 'measured' : 'unavailable';
        return fact;
    } catch {
        signal.throwIfAborted();
        return fact;
    }
}
