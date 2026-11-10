import http from 'node:http';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { McpHostService, type IMcpHostLimits } from '../host';
import type { IHostedMcpClaim } from '../ticket';
import { makeClaim, makeLimits } from './claim.fixture';

/** Mock-каталог /internal/mcp-host/authorize-session: счётчик запросов, управляемый статус, режим hang. */
interface ICatalogState {
    requests: number;
    status: number;
    /** true — принять соединение и рвать сокет без ответа (lookup timeout/error). */
    hang: boolean;
    bodies: Array<Record<string, unknown>>;
}
function startCatalog(state: ICatalogState): Promise<{ url: string; close: () => Promise<void> }> {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.method !== 'POST' || req.url !== '/internal/mcp-host/authorize-session') {
                res.writeHead(404);
                res.end();
                return;
            }
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
            });
            req.on('end', () => {
                state.requests += 1;
                try {
                    state.bodies.push(JSON.parse(body || '{}'));
                } catch {
                    state.bodies.push({});
                }
                if (state.hang) {
                    req.socket.destroy();
                    return;
                }
                res.writeHead(state.status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(state.status === 200 ? { ok: true } : { message: 'denied' }));
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as net.AddressInfo).port;
            resolve({
                url: `http://127.0.0.1:${port}`,
                close: () =>
                    new Promise<void>((done) => {
                        server.closeAllConnections?.();
                        server.close(() => done());
                    }),
            });
        });
    });
}

// Общий claim/limits-fixture (S3.a: дубли фабрик сведены в claim.fixture.ts).
const LIMITS: IMcpHostLimits = makeLimits({ authzCacheTtlMs: 250 });

const claimFor = (over: { device?: string; project?: string; artifact?: string } = {}): IHostedMcpClaim =>
    makeClaim({
        name: 'cache',
        deviceId: over.device,
        projectId: over.project,
        artifactSha256: over.artifact,
    });

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('Единый кэш re-check device↔project (AD-4)', () => {
    it('CACHE_MISS → lookup в каталоге; CACHE_HIT → без DB-транзакции (тот же канонический ключ)', async () => {
        const state: ICatalogState = { requests: 0, status: 200, hang: false, bodies: [] };
        const catalog = await startCatalog(state);
        const service = new McpHostService(catalog.url, 'token', LIMITS);
        try {
            const claim = claimFor();
            await service.authorizeSession(claim);
            expect(state.requests).toBe(1);
            // Тело lookup'а — каноническая сессия + artifactSha256.
            expect(state.bodies[0]).toEqual({
                deviceId: 'device-1',
                projectId: 'project-1',
                assetId: 'asset-1',
                version: 1,
                manifest: 'b'.repeat(64),
                artifactSha256: 'a'.repeat(64),
            });
            // Свежий кэш: повтор per-op — без запроса в каталог.
            await service.authorizeSession(claim);
            await service.authorizeSession(claim);
            expect(state.requests).toBe(1);
            // Другая каноническая сессия — другой ключ кэша.
            await service.authorizeSession(claimFor({ device: 'device-2' }));
            expect(state.requests).toBe(2);
            await service.authorizeSession(claimFor({ artifact: 'c'.repeat(64) }));
            expect(state.requests).toBe(3);
        } finally {
            await service.onModuleDestroy();
            await catalog.close();
        }
    });

    it('протухший кэш → новый lookup; lookup error/timeout → 503 fail-closed, stale не отдаётся', async () => {
        const state: ICatalogState = { requests: 0, status: 200, hang: false, bodies: [] };
        const catalog = await startCatalog(state);
        const service = new McpHostService(catalog.url, 'token', LIMITS);
        const claim = claimFor();
        try {
            await service.authorizeSession(claim);
            // TTL истёк: протухший кэш не возвращает старый результат — идёт lookup.
            await wait(300);
            await service.authorizeSession(claim);
            expect(state.requests).toBe(2);
            // Catalog 500: fail-closed 503, прежний (протухший) успех не возвращается.
            state.status = 500;
            await wait(300);
            await expect(service.authorizeSession(claim)).rejects.toMatchObject({ status: 503 });
            // Сетевая ошибка (разрыв сокета — timeout-путь): тоже 503, без кэширования отказа.
            state.hang = true;
            await wait(300);
            await expect(service.authorizeSession(claim)).rejects.toThrow(/Не удалось подтвердить доступ/);
        } finally {
            await service.onModuleDestroy();
            await catalog.close();
        }
    });

    it('403 отзыва не кэшируется: каждый re-check идёт в каталог', async () => {
        const state: ICatalogState = { requests: 0, status: 403, hang: false, bodies: [] };
        const catalog = await startCatalog(state);
        const service = new McpHostService(catalog.url, 'token', LIMITS);
        try {
            await expect(service.authorizeSession(claimFor())).rejects.toMatchObject({ status: 403 });
            await expect(service.authorizeSession(claimFor())).rejects.toMatchObject({ status: 403 });
            expect(state.requests).toBe(2);
        } finally {
            await service.onModuleDestroy();
            await catalog.close();
        }
    });

    it('окно отзыва ≤ TTL кэша: после отвязки канал живёт до протухания, затем 403', async () => {
        const state: ICatalogState = { requests: 0, status: 200, hang: false, bodies: [] };
        const catalog = await startCatalog(state);
        const service = new McpHostService(catalog.url, 'token', LIMITS);
        const claim = claimFor();
        try {
            await service.authorizeSession(claim);
            expect(state.requests).toBe(1);
            // Устройство отвязано: каталог отвечает 403.
            state.status = 403;
            // Пока кэш свежий (≤TTL) — окно отзыва; lookup не идёт.
            await service.authorizeSession(claim);
            expect(state.requests).toBe(1);
            // Кэш протух — отзыв применён, следующий re-check получает 403.
            await wait(300);
            await expect(service.authorizeSession(claim)).rejects.toMatchObject({ status: 403 });
            expect(state.requests).toBe(2);
        } finally {
            await service.onModuleDestroy();
            await catalog.close();
        }
    });

    it('неканоническая сессия — 401 без lookup в каталог', async () => {
        const state: ICatalogState = { requests: 0, status: 200, hang: false, bodies: [] };
        const catalog = await startCatalog(state);
        const service = new McpHostService(catalog.url, 'token', LIMITS);
        try {
            const claim = claimFor();
            claim.session.manifest = 'x'.repeat(64); // не sha256 — неканоническая сессия
            await expect(service.authorizeSession(claim)).rejects.toMatchObject({ status: 401 });
            expect(state.requests).toBe(0);
        } finally {
            await service.onModuleDestroy();
            await catalog.close();
        }
    });
});
