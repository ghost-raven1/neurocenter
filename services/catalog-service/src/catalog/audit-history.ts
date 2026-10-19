import type {Pool} from 'pg';
import type {IAuditEvent,IPage} from './dto';

const history=`SELECT operation_id AS id,coalesce(started_at,created_at) AS at,actor,actor AS "versionAuthor",
    lower(resource_type||'.'||type) AS action,resource_type AS "resourceType",resource_id AS "resourceId",
    state AS outcome,'' AS "decisionId",operation_id AS "correlationId",'operation' AS source,NULL::jsonb AS details FROM operations
    UNION ALL SELECT 'security:'||event_id::text,created_at,actor,actor,action,split_part(action,'.',1),resource_id,
    CASE WHEN action='maintenance.run.failed' THEN 'FAILED' ELSE 'SUCCEEDED' END,'','','security',
    CASE WHEN action='maintenance.policy.update' OR action='feature_flag.update' THEN jsonb_build_object('before',before_state,'after',after_state) ELSE NULL END FROM security_events`;

/** Единая страница истории включает транзакционный аудит; чужие payload в API не раскрываются. */
export async function listAuditHistory(pool:Pool,page:number,size:number):Promise<IPage<IAuditEvent>> {
    const [count,rows]=await Promise.all([
        pool.query('SELECT ((SELECT count(*) FROM operations)+(SELECT count(*) FROM security_events))::int AS n'),
        pool.query('SELECT * FROM ('+history+') events ORDER BY at DESC,id DESC LIMIT $1 OFFSET $2',[size,(page-1)*size]),
    ]);
    return {items:rows.rows as IAuditEvent[],page,size,total:Number(count.rows[0].n)};
}
