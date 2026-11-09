import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Logger } from '@nestjs/common';
import { SnapshotGarbageCollector } from '../snapshot-gc';
import { SnapshotService } from '../snapshot.service';

/**
 * AD-D3 (entry 5.9): in-process GC fallback for S3 snapshot blobs.
 *
 * Фейк пула отвечает только на два запроса самого тика (liveness верификатора и
 * наличие просроченных DELETING); двухфазный collect() — ратифицированный код,
 * его приёмка на реальной БД — scripts/test/snapshot-gc-fallback-db.mjs.
 */
const LIVE =
    "SELECT 1 FROM project_snapshot_verifiers WHERE sdk_version='0.29.0' AND last_seen>now()-interval '60 seconds' AND ($1::text IS NULL OR image_digest=$1) LIMIT 1";
const DUE = "SELECT 1 FROM project_snapshots WHERE status='DELETING' AND delete_after<=now() LIMIT 1";

interface ITickState {
    verifierLive: boolean;
    dueCandidates: number;
    livenessQueries: number;
    dueQueries: number;
}

function makeFakePool(state: ITickState) {
    const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
    const query = vi.fn(async (sql: string) => {
        const request = norm(String(sql));
        if (request === LIVE) {
            state.livenessQueries++;
            return { rows: state.verifierLive ? [{}] : [], rowCount: state.verifierLive ? 1 : 0 };
        }
        if (request === DUE) {
            state.dueQueries++;
            return { rows: state.dueCandidates ? [{}] : [], rowCount: state.dueCandidates ? 1 : 0 };
        }
        throw new Error('Непредвиденный SQL тика: ' + request);
    });
    return {
        query,
        connect: vi.fn().mockRejectedValue(new Error('Тик не открывает соединений')),
        end: vi.fn().mockResolvedValue(undefined),
    };
}

function buildService(state: ITickState) {
    const catalog = { ensureSchema: vi.fn().mockResolvedValue(undefined) };
    const devices = { ready: vi.fn().mockResolvedValue(undefined) };
    const service = new SnapshotService(catalog as never, devices as never, {} as never);
    const realPool = service.pool;
    const fakePool = makeFakePool(state);
    (service as unknown as Record<string, unknown>).pool = fakePool;
    return { service, realPool, fakePool, catalog, devices };
}

describe('SnapshotService.gcFallbackTick (AD-D3 in-process fallback)', () => {
    let state: ITickState;
    let fixture: ReturnType<typeof buildService> | undefined;
    let collect: Mock;

    beforeEach(() => {
        state = { verifierLive: false, dueCandidates: 0, livenessQueries: 0, dueQueries: 0 };
        vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        collect = vi.spyOn(SnapshotGarbageCollector.prototype, 'collect');
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        await fixture?.realPool.end();
        fixture = undefined;
    });

    it('verifier жив — fallback не запускает gc (основной путь)', async () => {
        state.verifierLive = true;
        state.dueCandidates = 1;
        collect.mockResolvedValue({ processed: 1, deleted: 1 });
        fixture = buildService(state);
        await fixture.service.gcFallbackTick();
        expect(state.livenessQueries).toBe(1);
        expect(state.dueQueries).toBe(0);
        expect(collect).not.toHaveBeenCalled();
    });

    it('verifier down, но нет просроченных DELETING — быстрый no-op', async () => {
        state.dueCandidates = 0;
        collect.mockResolvedValue({ processed: 1, deleted: 1 });
        fixture = buildService(state);
        await fixture.service.gcFallbackTick();
        expect(state.livenessQueries).toBe(1);
        expect(state.dueQueries).toBe(1);
        expect(collect).not.toHaveBeenCalled();
    });

    it('verifier down + просроченный DELETING — gc запущен от сервиса, reclaim залогирован', async () => {
        state.dueCandidates = 1;
        let owner: unknown;
        collect.mockImplementation(function (this: { snapshots: unknown }) {
            owner = this.snapshots;
            return Promise.resolve({ processed: 3, deleted: 1 });
        });
        fixture = buildService(state);
        await fixture.service.gcFallbackTick();
        expect(state.livenessQueries).toBe(1);
        expect(state.dueQueries).toBe(1);
        expect(collect).toHaveBeenCalledTimes(1);
        expect(owner).toBe(fixture.service);
        expect(Logger.prototype.log).toHaveBeenCalledTimes(1);
        expect(String(Logger.prototype.log.mock.calls[0]![0])).toMatch(/reclaimed 3 .* and 1/);
    });

    it('пустой gc (nothing reclaimed) — лог не пишется', async () => {
        state.dueCandidates = 1;
        collect.mockResolvedValue({ processed: 0, deleted: 0 });
        fixture = buildService(state);
        await fixture.service.gcFallbackTick();
        expect(Logger.prototype.log).not.toHaveBeenCalled();
    });

    it('сбой gc не роняет тик и не блокирует следующий (single-flight сброшен)', async () => {
        state.dueCandidates = 1;
        collect.mockRejectedValueOnce(new Error('S3 timeout')).mockResolvedValueOnce({ processed: 0, deleted: 0 });
        fixture = buildService(state);
        await fixture.service.gcFallbackTick();
        expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
        expect(String(Logger.prototype.warn.mock.calls[0]![0])).toMatch(/fallback tick failed/);
        await fixture.service.gcFallbackTick();
        expect(collect).toHaveBeenCalledTimes(2);
    });

    it('single-flight: второй tick во время первого не запускает второй gc', async () => {
        state.dueCandidates = 1;
        let release: (() => void) | undefined;
        collect.mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = () => resolve({ processed: 1, deleted: 1 });
                }),
        );
        fixture = buildService(state);
        const first = fixture.service.gcFallbackTick();
        await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
        const second = fixture.service.gcFallbackTick();
        release!();
        await Promise.all([first, second]);
        expect(collect).toHaveBeenCalledTimes(1);
    });

    it('onModuleInit стартует часовой fallback-таймер, onModuleDestroy останавливает его', async () => {
        vi.useFakeTimers();
        state.dueCandidates = 1;
        collect.mockResolvedValue({ processed: 1, deleted: 1 });
        fixture = buildService(state);
        const service = fixture.service as unknown as { gcFallbackTimer?: { unref: () => void } };
        await service.onModuleInit();
        expect(fixture.catalog.ensureSchema).toHaveBeenCalledTimes(1);
        expect(service.gcFallbackTimer).toBeDefined();
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(state.livenessQueries).toBe(1);
        const stopped = state.livenessQueries;
        await service.onModuleDestroy();
        expect(fixture.fakePool.end).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
        expect(state.livenessQueries).toBe(stopped);
    });
});
