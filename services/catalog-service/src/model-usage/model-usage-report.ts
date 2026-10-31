import type { PoolClient } from 'pg';
import type { ModelUsageItem, ModelUsageResult, UsageFilter, UsagePrivateRoom, UsageScope } from './model-usage.types';

const totals = `count(*) AS requests,count(*) FILTER(WHERE status='success') AS success,count(*) FILTER(WHERE status='error') AS error,
count(*) FILTER(WHERE status='cancelled') AS cancelled,count(*) FILTER(WHERE status='interrupted') AS interrupted,count(*) FILTER(WHERE status='pending') AS pending,
sum(input_tokens)::text AS "inputTokens",sum(output_tokens)::text AS "outputTokens",count(input_tokens) AS "knownInputRequests",count(output_tokens) AS "knownOutputRequests",
count(*) FILTER(WHERE input_tokens IS NULL) AS "unknownInputRequests",count(*) FILTER(WHERE output_tokens IS NULL) AS "unknownOutputRequests",avg(latency_ms)::float AS "averageLatencyMs",
sum(dispatch_count)::text AS "apiCalls",count(dispatch_count) AS "knownDispatchRequests",count(*) FILTER(WHERE dispatch_count IS NULL) AS "unknownDispatchRequests",
sum(rate_wait_ms)::text AS "rateWaitMs",avg(provider_latency_ms)::float AS "averageProviderLatencyMs"`;

/** Facets and every aggregate share one authorized period; user filters only narrow that relation. */
export function modelUsageReportQuery(scope: UsageScope, filter: UsageFilter): { sql: string; values: unknown[] } {
    const values: unknown[] = [filter.days, scope.all, scope.actor, scope.projectIds, scope.viewerEmail],
        where: string[] = [];
    const bind = (value: unknown): string => {
        values.push(value);
        return '$' + values.length;
    };
    for (const [column, value] of [
        ['project_id', filter.projectId],
        ['model_id', filter.modelId],
        ['agent_id', filter.agentId],
        ['purpose', filter.purpose],
        ['status', filter.status],
        ['endpoint', filter.endpoint],
        ['provider', filter.provider],
    ])
        if (value !== undefined) where.push(column + '=' + bind(value));
    if (filter.actorEmail !== undefined)
        where.push(filter.actorEmail === null ? 'actor_email IS NULL' : 'actor_email=' + bind(filter.actorEmail));
    let cursor = '';
    if (filter.cursor)
        cursor = `WHERE (started_at,id)<(${bind(filter.cursor.startedAt)}::timestamptz,${bind(filter.cursor.id)}::uuid)`;
    const limit = bind(filter.limit + 1),
        bucket = filter.days === 1 ? 'hour' : 'day';
    const array = (query: string): string => `(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (${query}) x)`;
    const facetUsers = array(
        `SELECT actor_email AS email,coalesce(max(actor_name),actor_email,'Серверные задания') AS "displayName" FROM scoped GROUP BY actor_email ORDER BY lower(coalesce(max(actor_name),actor_email,'')),actor_email NULLS LAST`,
    );
    const facetProjects = array(
        `SELECT project_id AS id,coalesce(max(project_name),'Удалённый проект') AS name FROM scoped WHERE project_id IS NOT NULL GROUP BY project_id ORDER BY name,id`,
    );
    const facetModels = array(
        `SELECT model_id AS id,max(model_name) AS name FROM scoped GROUP BY model_id ORDER BY name,id`,
    );
    const facetAgents = array(
        `SELECT agent_id AS id,coalesce(max(agent_name),'Агент проекта') AS name FROM scoped WHERE agent_id IS NOT NULL GROUP BY agent_id ORDER BY name,id`,
    );
    const sql = `WITH scoped AS MATERIALIZED (
        SELECT u.*,NULLIF(p.display_name,'') AS actor_name,j.name AS project_name,a.name AS agent_name,
            coalesce(u.private_project_chat_room_id,private_room.id) AS protected_room_id
        FROM model_usage_calls u LEFT JOIN platform_users p ON p.email=u.actor_email LEFT JOIN projects j ON j.id=u.project_id LEFT JOIN agent_catalog a ON a.id=u.agent_id
        LEFT JOIN project_chat_messages source ON source.project_id=u.project_id AND source.id=u.turn_id
        LEFT JOIN project_chat_rooms private_room ON private_room.project_id=source.project_id AND private_room.id=source.room_id AND private_room.visibility='PRIVATE'
        WHERE u.started_at>=now()-($1::integer*86400*interval '1 second') AND u.started_at<=now()
        AND ($2 OR ($3::text IS NOT NULL AND u.actor_email=$3 AND (u.project_id IS NULL OR u.project_id=ANY($4::text[]))) OR ($3::text IS NULL AND u.project_id=ANY($4::text[])))
        AND (coalesce(u.private_project_chat_room_id,private_room.id) IS NULL OR EXISTS(SELECT 1 FROM project_chat_rooms room
            WHERE room.project_id=u.project_id AND room.id=coalesce(u.private_project_chat_room_id,private_room.id) AND room.visibility='PRIVATE'
            AND (room.creator_email=$5::text OR EXISTS(SELECT 1 FROM project_chat_room_members member
                WHERE member.project_id=room.project_id AND member.room_id=room.id AND member.email=$5::text))))
    ),filtered AS MATERIALIZED (SELECT * FROM scoped${where.length ? ' WHERE ' + where.join(' AND ') : ''})
    SELECT now() AS "windowTo",(SELECT to_jsonb(x) FROM (SELECT ${totals} FROM filtered) x) AS summary,
        ${array('SELECT DISTINCT project_id AS "projectId",protected_room_id AS "roomId" FROM scoped WHERE protected_room_id IS NOT NULL ORDER BY "projectId","roomId"')} AS "privateRooms",
        ${array(`SELECT model_id AS "modelId",max(model_name) AS name,${totals} FROM filtered GROUP BY model_id ORDER BY count(*) DESC,model_id`)} AS "byModel",
        ${array(`SELECT purpose,${totals} FROM filtered GROUP BY purpose ORDER BY count(*) DESC,purpose`)} AS "byPurpose",
        ${array(`SELECT actor_email AS "actorEmail",coalesce(max(actor_name),actor_email,'Серверные задания') AS "displayName",${totals} FROM filtered GROUP BY actor_email ORDER BY count(*) DESC,actor_email NULLS LAST`)} AS "byActor",
        ${array(`SELECT project_id AS "projectId",coalesce(max(project_name),CASE WHEN project_id IS NULL THEN 'Без проекта' ELSE 'Удалённый проект' END) AS "projectName",${totals} FROM filtered GROUP BY project_id ORDER BY count(*) DESC,project_id NULLS LAST`)} AS "byProject",
        ${array(`SELECT endpoint,${totals} FROM filtered GROUP BY endpoint ORDER BY endpoint`)} AS "byEndpoint",
        ${array(`SELECT agent_id AS "agentId",coalesce(max(agent_name),CASE WHEN agent_id IS NULL THEN 'Без агента' ELSE 'Агент проекта' END) AS "agentName",${totals} FROM filtered GROUP BY agent_id ORDER BY count(*) DESC,agent_id NULLS LAST`)} AS "byAgent",
        ${array(`SELECT date_trunc('${bucket}',started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS "periodStart",${totals} FROM filtered GROUP BY 1 ORDER BY 1`)} AS series,
        jsonb_build_object('users',${facetUsers},'projects',${facetProjects},'models',${facetModels},'agents',${facetAgents},'providers',(SELECT coalesce(jsonb_agg(x.provider ORDER BY x.provider),'[]'::jsonb) FROM (SELECT DISTINCT provider FROM scoped) x)) AS facets,
        ${array(`SELECT id,model_id AS "modelId",model_name AS "modelName",provider,endpoint,purpose,actor_email AS "actorEmail",actor_name AS "actorName",project_id AS "projectId",project_name AS "projectName",agent_id AS "agentId",agent_name AS "agentName",turn_id AS "turnId",operation_id AS "operationId",
            status,started_at AS "startedAt",to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt",finished_at AS "finishedAt",latency_ms AS "latencyMs",input_tokens AS "inputTokens",output_tokens AS "outputTokens",
            dispatch_count AS "dispatchCount",dispatched_at AS "dispatchedAt",rate_wait_ms AS "rateWaitMs",provider_latency_ms AS "providerLatencyMs",failure_code AS "failureCode"
            FROM filtered ${cursor} ORDER BY started_at DESC,id DESC LIMIT ${limit}`)} AS items`;
    return { sql, values };
}

type ReportRow = Pick<
    ModelUsageResult,
    'summary' | 'byModel' | 'byPurpose' | 'facets' | 'byActor' | 'byProject' | 'byEndpoint' | 'byAgent' | 'series'
> & {
    windowTo: Date;
    items: Array<ModelUsageItem & { cursorAt: string }>;
    privateRooms: UsagePrivateRoom[];
};
const iso = (value: unknown): string => new Date(value as string | Date).toISOString();

/** One SQL snapshot produces both user detail and totals; history tokens retain PostgreSQL microseconds. */
export async function readModelUsageReport(db: Pick<PoolClient, 'query'>, scope: UsageScope, filter: UsageFilter) {
    const query = modelUsageReportQuery(scope, filter),
        row = (await db.query<ReportRow>(query.sql, query.values)).rows[0];
    const { items: raw, windowTo, ...report } = row;
    const items = raw.slice(0, filter.limit).map(({ cursorAt: _cursorAt, ...item }) => ({
        ...item,
        startedAt: iso(item.startedAt),
        finishedAt: item.finishedAt ? iso(item.finishedAt) : null,
        dispatchedAt: item.dispatchedAt ? iso(item.dispatchedAt) : null,
    }));
    const last = raw[Math.min(raw.length, filter.limit) - 1];
    return {
        ...report,
        items,
        windowTo: iso(windowTo),
        hasMore: raw.length > filter.limit,
        cursor: last ? { startedAt: last.cursorAt, id: last.id } : null,
    };
}
