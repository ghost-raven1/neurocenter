import type { Pool } from 'pg';
import { CATALOG_SCHEMA_FACTS_SQL } from '../database/schema-catalog';
import { CURRENT_SYSTEM_ROLE_SCHEMA_CONTRACT as coordinator } from '../system-roles/system-role.coordinator.schema-contract';
import { SYSTEM_ROLE_MCP_SCHEMA_CONTRACT } from './system-role-mcp.schema-contract';
import { SYSTEM_ROLE_MCP_MAINTENANCE_SCHEMA_CONTRACT } from './system-role-mcp-maintenance.schema-contract';

const current = [...SYSTEM_ROLE_MCP_SCHEMA_CONTRACT, ...SYSTEM_ROLE_MCP_MAINTENANCE_SCHEMA_CONTRACT];

const key = (value: { kind: string; id: string }): string => value.kind + ':' + value.id;
const replaced = new Set(SYSTEM_ROLE_MCP_SCHEMA_CONTRACT.map(key)), old = new Set(coordinator.map(key));
/** Released role facts stay frozen; only the measured MCP budget constraint replaces its current counterpart. */
export const CURRENT_MCP_SYSTEM_ROLE_SCHEMA_CONTRACT = [...coordinator.filter(value => !replaced.has(key(value))), ...SYSTEM_ROLE_MCP_SCHEMA_CONTRACT.filter(value => old.has(key(value)))];
export const CURRENT_SYSTEM_ROLE_MCP_SCHEMA_CONTRACT = current.filter(value => !old.has(key(value)));
export async function assertSystemRoleMcpSchema(db: Pick<Pool, 'query'>): Promise<void> {
    if (!current.length) throw new Error('Физический контракт MCP системных агентов ещё не проверен.');
    const { rows } = await db.query<{ issue: string }>(`WITH expected AS(SELECT * FROM jsonb_to_recordset($1::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS(${CATALOG_SCHEMA_FACTS_SQL})
        SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`, [JSON.stringify(current)]);
    if (rows.length) throw new Error('Схема MCP системных агентов не готова: ' + rows.slice(0, 10).map(row => row.issue).join(', '));
}
