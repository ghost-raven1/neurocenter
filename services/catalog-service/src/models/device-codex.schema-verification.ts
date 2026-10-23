import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { DEVICE_CODEX_SCHEMA_CONTRACT } from './device-codex.schema-contract';
/** Private call storage must exist with its measured contract before inference readiness is advertised. */
export async function assertDeviceCodexSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!DEVICE_CODEX_SCHEMA_CONTRACT.length)
        throw new Error('Физический контракт приватных вызовов Codex ещё не проверен. Запуск candidate-сборки заблокирован.');
    const issues = await db.query<{
        issue: string;
    }>(`WITH expected AS(SELECT * FROM jsonb_to_recordset($1::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
  SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`, [JSON.stringify(DEVICE_CODEX_SCHEMA_CONTRACT)]);
    if (issues.rows.length)
        throw new Error('Схема приватных вызовов Codex не готова: ' + issues.rows.slice(0, 10).map(r => r.issue).join(', '));
}
