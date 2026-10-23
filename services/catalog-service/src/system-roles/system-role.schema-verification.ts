import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { SYSTEM_ROLE_SCHEMA_CONTRACT } from './system-role.schema-contract';
/** A source-only candidate cannot advertise readiness before its exact physical contract is measured. */
export async function assertSystemRoleSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!SYSTEM_ROLE_SCHEMA_CONTRACT.length) throw new Error('Физический контракт системных агентов ещё не проверен. Применение этой candidate-сборки заблокировано.');
    const issues = await db.query<{issue:string}>(`WITH expected AS(SELECT * FROM jsonb_to_recordset($1::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
        SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`, [JSON.stringify(SYSTEM_ROLE_SCHEMA_CONTRACT)]);
    if (issues.rows.length) throw new Error('Схема системных агентов не готова: ' + issues.rows.slice(0, 10).map(row => row.issue).join(', '));
}
