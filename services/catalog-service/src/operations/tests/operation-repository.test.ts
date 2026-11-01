import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { OperationRepository } from '../operation-repository';

const id = '12345678-1234-4234-8234-123456789012';
const source = { type: 'bundled', id: 'mcp-example', revision: 'a'.repeat(64) };
const operation = {
    operation_id: `tool-build-${id}`,
    resource_id: id,
    resource_type: 'tool-build',
    project_id: null,
    actor: 'owner',
    bytes_done: 0,
    bytes_total: 0,
    log: [],
};

describe('operation bundled recovery identity', () => {
    it('exposes only safe identity from the matching build on a read', async () => {
        const query = vi
            .fn()
            .mockResolvedValueOnce({ rows: [operation] })
            .mockResolvedValueOnce({ rows: [{ id, actor: 'owner', source, secret: 'private' }] });
        const result = await new OperationRepository({ query } as unknown as Pool).get(operation.operation_id);
        expect(result?.toolBuildSource).toEqual({ id: source.id, revision: source.revision });
        expect(JSON.stringify(result)).not.toContain('private');
        expect(query).toHaveBeenCalledTimes(2);
        expect(query.mock.calls.every(([sql]) => sql.trim().startsWith('SELECT'))).toBe(true);
    });
    it.each(['different-owner', 'missing', 'nonbundled'])('does not attach metadata for %s', async (caseName) => {
        const job = {
            id,
            actor: caseName === 'different-owner' ? 'other' : 'owner',
            source: caseName === 'nonbundled' ? { type: 'files' } : source,
        };
        const query = vi
            .fn()
            .mockResolvedValueOnce({ rows: [operation] })
            .mockResolvedValueOnce({ rows: caseName === 'missing' ? [] : [job] });
        expect(
            await new OperationRepository({ query } as unknown as Pool).get(operation.operation_id),
        ).not.toHaveProperty('toolBuildSource');
    });
    it('enriches a page through one lookup while preserving unmatched operations', async () => {
        const secondId = '22345678-1234-4234-8234-123456789012';
        const query = vi
            .fn()
            .mockResolvedValueOnce({ rows: [{ n: 2, active: 0, active_percent: 0, running: 0, queued: 0 }] })
            .mockResolvedValueOnce({
                rows: [operation, { ...operation, resource_id: secondId, operation_id: `tool-build-${secondId}` }],
            })
            .mockResolvedValueOnce({ rows: [{ id, actor: 'owner', source }] });
        const page = await new OperationRepository({ query } as unknown as Pool).list(1, 20);
        expect(page.items.map((item) => item.toolBuildSource)).toEqual([
            { id: source.id, revision: source.revision },
            undefined,
        ]);
        expect(query).toHaveBeenCalledTimes(3);
        expect(query.mock.calls[2][1]).toEqual([[id, secondId]]);
    });
    it('does not look up hidden operations or project operations', async () => {
        for (const rows of [[], [{ ...operation, project_id: 'project' }]]) {
            const query = vi.fn().mockResolvedValue({ rows });
            const result = await new OperationRepository({ query } as unknown as Pool).get(operation.operation_id, {
                actor: 'owner',
                projectIds: [],
            });
            expect(result?.toolBuildSource).toBeUndefined();
            expect(query).toHaveBeenCalledTimes(1);
        }
    });
});
