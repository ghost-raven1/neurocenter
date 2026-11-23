import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { listAuditHistory } from '../audit-history';

/**
 * P0-RES/AD-O7: единая история (UNION operations + security_events) подхватывает
 * новые security-события (login.*, ticket.*, device.*) с source='security'
 * и корректной пагинацией.
 */
const securityRow = (id: string, action: string, actor: string, resourceId: string, at: string) => ({
    id: 'security:' + id,
    at: new Date(at),
    actor,
    versionAuthor: actor,
    action,
    resourceType: action.split('.')[0],
    resourceId,
    outcome: 'SUCCEEDED',
    decisionId: '',
    correlationId: '',
    source: 'security',
    details: null,
});

const operationRow = {
    id: 'op-1',
    at: new Date('2026-11-20T08:00:00Z'),
    actor: 'owner@local',
    versionAuthor: 'owner@local',
    action: 'project.update',
    resourceType: 'project',
    resourceId: 'p-1',
    outcome: 'SUCCEEDED',
    decisionId: '',
    correlationId: 'op-1',
    source: 'operation',
    details: null,
};

function fakePool(rows: Array<Record<string, unknown>>, total: number) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const handle = async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.startsWith('SELECT ((SELECT count(*)')) return { rows: [{ n: total }] };
        return { rows };
    };
    const pool = { query: handle } as unknown as Pool;
    return { pool, calls };
}

describe('FR-903/AD-O7: единая история — новые security-события видимы, пагинация', () => {
    it('security-события новых действий проходят маппинг с source=security и details=null', async () => {
        const rows = [
            securityRow('aaaa-1', 'login.success', 'owner@local', 'owner@local', '2026-11-23T10:00:00Z'),
            securityRow('aaaa-2', 'ticket.denied', '1.2.3.4', 'mcp-ticket', '2026-11-23T09:00:00Z'),
            securityRow('aaaa-3', 'device.revoke', 'owner@local', 'dev-1', '2026-11-22T12:00:00Z'),
            operationRow,
        ];
        const { pool } = fakePool(rows, 4);
        const page = await listAuditHistory(pool, 1, 20);
        expect(page.total).toBe(4);
        expect(page.items).toHaveLength(4);
        const actions = page.items.map((item) => item.action);
        expect(actions).toContain('login.success');
        expect(actions).toContain('ticket.denied');
        expect(actions).toContain('device.revoke');
        for (const item of page.items) {
            if (item.source === 'security') {
                expect(item.outcome).toBe('SUCCEEDED');
                expect(item.details).toBeNull();
            }
        }
    });

    it('пагинация передаёт LIMIT/OFFSET и total из общего счётчика', async () => {
        const { pool, calls } = fakePool([], 42);
        const page = await listAuditHistory(pool, 3, 10);
        expect(page.total).toBe(42);
        const pageQuery = calls.find((c) => c.sql.includes('LIMIT $1 OFFSET $2'));
        expect(pageQuery).toBeDefined();
        expect(pageQuery!.params).toEqual([10, 20]);
    });
});
