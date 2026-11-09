import { describe, expect, it, vi } from 'vitest';
import { deliverRagQuotaUsage, type IRagQuotaUsageRecord } from '../quota/project-quota-usage';

function stubFetch(handler?: (input: string, init?: RequestInit) => Promise<Response>) {
    const fetchImpl =
        handler ??
        (vi.fn(async () => new Response(null, { status: 202 })) as unknown as typeof globalThis.fetch);
    return fetchImpl;
}

function record(partial: Partial<IRagQuotaUsageRecord> = {}): IRagQuotaUsageRecord {
    return { projectId: '11111111-1111-4111-8111-111111111111', deltaBytes: 4096, requestKey: 'intent:abc', ...partial };
}

describe('deliverRagQuotaUsage', () => {
    it('пустой список — без запросов', async () => {
        const fetchImpl = stubFetch();
        await expect(deliverRagQuotaUsage([], { fetchImpl: fetchImpl as never })).resolves.toBe(0);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('отправляет POST в catalog с dimension retention и internal-токеном', async () => {
        const fetchImpl = stubFetch() as ReturnType<typeof vi.fn>;
        const delivered = await deliverRagQuotaUsage([record()], {
            catalogUrl: 'http://catalog:4100/',
            internalToken: 'secret-token',
            fetchImpl: fetchImpl as never,
        });
        expect(delivered).toBe(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://catalog:4100/internal/projects/11111111-1111-4111-8111-111111111111/quota-usage');
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-neurocenter-internal': 'secret-token' });
        expect(JSON.parse(String(init.body))).toEqual({
            dimension: 'retention',
            deltaBytes: 4096,
            requestKey: 'intent:abc',
        });
    });

    it('запрашивает каждый record отдельно', async () => {
        const fetchImpl = stubFetch() as ReturnType<typeof vi.fn>;
        const delivered = await deliverRagQuotaUsage(
            [record({ requestKey: 'gen-create:aaa' }), record({ requestKey: 'gen-cancel:bbb', deltaBytes: -8192 })],
            { fetchImpl: fetchImpl as never },
        );
        expect(delivered).toBe(2);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('ошибка доставки не пробрасывается наружу и логируется как warn', async () => {
        const warn = vi.fn();
        const fetchImpl = vi.fn(async () => {
            throw new Error('catalog unavailable');
        }) as unknown as typeof globalThis.fetch;
        await expect(deliverRagQuotaUsage([record()], { fetchImpl, logger: warn })).resolves.toBe(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('quota usage delivery failed');
    });

    it('не-ok статус не считается доставленным, остальные записи уходят дальше', async () => {
        const warn = vi.fn();
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 503 }))
            .mockResolvedValueOnce(new Response(null, { status: 202 })) as unknown as typeof globalThis.fetch;
        const delivered = await deliverRagQuotaUsage([record({ requestKey: 'one' }), record({ requestKey: 'two' })], {
            fetchImpl,
            logger: warn,
        });
        expect(delivered).toBe(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('requestKey=one');
    });
});
