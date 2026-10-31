import type { Pool } from 'pg';
import type { IAuditEvent, IPage } from './dto';
import { AGENT_AUDIT_ACTIONS, agentAuditSnapshot, isAgentAuditEvent } from '../agents/agent-audit';
import { REQUEST_AUDIT_ACTIONS, isRequestAudit, requestAuditSnapshot } from '../catalog-requests/request.audit';
import { assetImportAuditJobs, assetImportAuditSnapshot } from './asset-import-audit';
import { operationAuditDetailsSql, operationAuditSnapshot } from './operation-audit';

const history = `SELECT operation_id AS id,coalesce(started_at,created_at) AS at,actor,actor AS "versionAuthor",
    lower(resource_type||'.'||type) AS action,resource_type AS "resourceType",resource_id AS "resourceId",
    state AS outcome,'' AS "decisionId",operation_id AS "correlationId",'operation' AS source,${operationAuditDetailsSql} AS details FROM operations o
    UNION ALL SELECT 'security:'||event_id::text,created_at,actor,actor,action,split_part(action,'.',1),resource_id,
    CASE WHEN action='maintenance.run.failed' THEN 'FAILED' ELSE 'SUCCEEDED' END,'','','security',
    CASE WHEN action='asset.import.request' THEN jsonb_build_object('before',NULL,'after',jsonb_build_object('ids',after_state->'ids','repository',after_state->'repository','commit',after_state->'commit'))
        WHEN action='maintenance.policy.update' OR action='feature_flag.update'
        OR action IN ('plugin.create','plugin.update','plugin.activate','plugin.delete')
        OR action IN (${AGENT_AUDIT_ACTIONS.map((action) => "'" + action + "'").join(',')})
        OR action IN (${REQUEST_AUDIT_ACTIONS.map((action) => "'" + action + "'").join(',')})
        OR action IN ('asset.archive','asset.restore') AND (before_state->>'kind'='agent' OR after_state->>'kind'='agent')
        THEN jsonb_build_object('before',before_state,'after',after_state) ELSE NULL END FROM security_events`;

const publicationActions = new Set(['plugin.create', 'plugin.update', 'plugin.activate', 'plugin.delete']);

/** Историческое название и состав версии доступны без конфигурации, исходников и окружения. */
function publicationSnapshot(value: unknown): Record<string, string | number> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const input = value as Record<string, unknown>;
    const result: Record<string, string | number> = {};
    for (const key of ['name', 'kind', 'origin', 'revision', 'contentHash']) {
        if (typeof input[key] === 'string') {
            result[key] = input[key] as string;
        }
    }
    for (const key of ['version', 'filesCount']) {
        if (Number.isSafeInteger(input[key]) && Number(input[key]) >= 0) {
            result[key] = Number(input[key]);
        }
    }
    return result;
}

/** Единая страница истории включает транзакционный аудит; чужие payload в API не раскрываются. */
export async function listAuditHistory(pool: Pool, page: number, size: number): Promise<IPage<IAuditEvent>> {
    const [count, rows] = await Promise.all([
        pool.query('SELECT ((SELECT count(*) FROM operations)+(SELECT count(*) FROM security_events))::int AS n'),
        pool.query('SELECT * FROM (' + history + ') events ORDER BY at DESC,id DESC LIMIT $1 OFFSET $2', [
            size,
            (page - 1) * size,
        ]),
    ]);
    const events = rows.rows as IAuditEvent[],
        requests = events.filter((event) => event.action === 'asset.import.request');
    const jobs = requests.length
        ? await pool.query<{ id: string; items: unknown }>(assetImportAuditJobs, [
              [...new Set(requests.map((event) => event.resourceId))],
          ])
        : { rows: [] };
    const jobItems = new Map(jobs.rows.map((job) => [job.id, job.items]));
    const items = events.map((event) =>
        event.source === 'operation'
            ? {
                  ...event,
                  details: event.details ? { before: null, after: operationAuditSnapshot(event.details.after) } : null,
              }
            : event.action === 'asset.import.request'
              ? {
                    ...event,
                    details: {
                        before: null,
                        after: assetImportAuditSnapshot(event.details?.after, jobItems.get(event.resourceId)),
                    },
                }
              : isRequestAudit(event.action)
                ? {
                      ...event,
                      details: event.details
                          ? {
                                before: requestAuditSnapshot(event.details.before),
                                after: requestAuditSnapshot(event.details.after),
                            }
                          : null,
                  }
                : isAgentAuditEvent(event.action, event.details)
                  ? {
                        ...event,
                        details: event.details
                            ? {
                                  before: agentAuditSnapshot(event.details.before),
                                  after: agentAuditSnapshot(event.details.after),
                              }
                            : null,
                    }
                  : publicationActions.has(event.action)
                    ? {
                          ...event,
                          details: event.details
                              ? {
                                    before: publicationSnapshot(event.details.before),
                                    after: publicationSnapshot(event.details.after),
                                }
                              : null,
                      }
                    : event,
    );
    return { items, page, size, total: Number(count.rows[0].n) };
}
