import type { IRoleMcpCallContext } from '../../../shared/system-role-mcp.cjs';
import type { IMcpCallRow } from './system-role-mcp.store-interfaces';

export const mcpCallContext = (row: IMcpCallRow): IRoleMcpCallContext => ({
    id: row.id,
    kind: row.kind,
    ...(row.name ? { name: row.name, schemaDigest: row.schema_digest!, arguments: row.arguments! } : {}),
    deadlineAt: new Date(row.deadline_at).toISOString(),
});
