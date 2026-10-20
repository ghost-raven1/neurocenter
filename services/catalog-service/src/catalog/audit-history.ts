import type {Pool} from 'pg';
import type {IAuditEvent,IPage} from './dto';

const history=`SELECT operation_id AS id,coalesce(started_at,created_at) AS at,actor,actor AS "versionAuthor",
    lower(resource_type||'.'||type) AS action,resource_type AS "resourceType",resource_id AS "resourceId",
    state AS outcome,'' AS "decisionId",operation_id AS "correlationId",'operation' AS source,NULL::jsonb AS details FROM operations
    UNION ALL SELECT 'security:'||event_id::text,created_at,actor,actor,action,split_part(action,'.',1),resource_id,
    CASE WHEN action='maintenance.run.failed' THEN 'FAILED' ELSE 'SUCCEEDED' END,'','','security',
    CASE WHEN action='maintenance.policy.update' OR action='feature_flag.update'
        OR action IN ('plugin.create','plugin.update','plugin.activate','plugin.delete')
        THEN jsonb_build_object('before',before_state,'after',after_state) ELSE NULL END FROM security_events`;

const publicationActions = new Set(['plugin.create', 'plugin.update', 'plugin.activate', 'plugin.delete']);

/** Историческое название и состав версии доступны без конфигурации, исходников и окружения. */
function publicationSnapshot(value: unknown): Record<string, string | number> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return null; }
    const input = value as Record<string, unknown>;
    const result: Record<string, string | number> = {};
    for (const key of ['name', 'kind', 'origin', 'revision', 'contentHash']) {
        if (typeof input[key] === 'string') { result[key] = input[key] as string; }
    }
    for (const key of ['version', 'filesCount']) {
        if (Number.isSafeInteger(input[key]) && Number(input[key]) >= 0) { result[key] = Number(input[key]); }
    }
    return result;
}

/** Единая страница истории включает транзакционный аудит; чужие payload в API не раскрываются. */
export async function listAuditHistory(pool:Pool,page:number,size:number):Promise<IPage<IAuditEvent>> {
    const [count,rows]=await Promise.all([
        pool.query('SELECT ((SELECT count(*) FROM operations)+(SELECT count(*) FROM security_events))::int AS n'),
        pool.query('SELECT * FROM ('+history+') events ORDER BY at DESC,id DESC LIMIT $1 OFFSET $2',[size,(page-1)*size]),
    ]);
    const items = (rows.rows as IAuditEvent[]).map(event => publicationActions.has(event.action)
        ? { ...event, details: event.details ? {
            before: publicationSnapshot(event.details.before), after: publicationSnapshot(event.details.after),
        } : null } : event);
    return {items,page,size,total:Number(count.rows[0].n)};
}
