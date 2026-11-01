import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { query, claims } = vi.hoisted(() => ({ query: vi.fn(), claims: vi.fn() }));
vi.mock('../../database/pool', () => ({ createPool: () => ({ query }) }));
import { PackageBuildService } from '../package-build.service';

const id = '12345678-1234-4234-8234-123456789012';
const actor = { email: 'owner', activeRole: 'Главный админ' as const };
const source = { type: 'bundled', id: 'mcp-example', revision: 'a'.repeat(64) };
const row = {
    id,
    config: { source, targets: ['linux-x64'], kind: 'mcp', name: 'Example', description: 'Saved', tags: [] },
};
function service() {
    return new PackageBuildService({ claims } as never, {} as never, {} as never, {} as never);
}

describe('build recovery history authorization', () => {
    afterEach(() => vi.unstubAllGlobals());
    beforeEach(() => {
        vi.resetAllMocks();
        claims.mockResolvedValue({ userRoles: ['Главный админ'] });
        query.mockResolvedValue({ rows: [] });
    });
    it('reads saved input without starting build work or requiring the feature service', async () => {
        const fetch = vi.fn().mockRejectedValue(new Error('feature service unavailable'));
        vi.stubGlobal('fetch', fetch);
        query.mockResolvedValueOnce({ rows: [row] });
        const result = await service().get(actor, id);
        expect(result.recovery?.source).toEqual(source);
        expect(fetch).not.toHaveBeenCalled();
        expect(claims).toHaveBeenCalledTimes(2);
        expect(query.mock.calls.every(([sql]) => sql.trim().startsWith('SELECT'))).toBe(true);
    });
    it('rejects a role revoked before reading history', async () => {
        claims.mockResolvedValue({ userRoles: [] });
        await expect(service().get(actor, id)).rejects.toMatchObject({ status: 403 });
        expect(query).not.toHaveBeenCalled();
    });
    it('does not return input when rights change during the database read', async () => {
        query.mockResolvedValueOnce({ rows: [row] });
        claims.mockResolvedValueOnce({ userRoles: ['Главный админ'] }).mockResolvedValueOnce({ userRoles: [] });
        await expect(service().get(actor, id)).rejects.toMatchObject({ status: 403 });
    });
});
