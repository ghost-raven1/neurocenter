import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { SYSTEM_ROLE_CHAT_SCHEMA_CONTRACT } from './system-role-chat.schema-contract';

/** Readiness verifies the physical private ownership and immutable receipt contract. */
export async function assertSystemRoleChatSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!SYSTEM_ROLE_CHAT_SCHEMA_CONTRACT.length)
        throw new Error('Физический контракт сервисного чата ещё не проверен.');
    const { rows } = await db.query<{ issue: string }>(
        `WITH expected AS(SELECT * FROM jsonb_to_recordset($1::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
        SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`,
        [JSON.stringify(SYSTEM_ROLE_CHAT_SCHEMA_CONTRACT)],
    );
    if (rows.length)
        throw new Error(
            'Схема сервисного чата не готова: ' +
                rows
                    .slice(0, 10)
                    .map((row) => row.issue)
                    .join(', '),
        );
}
