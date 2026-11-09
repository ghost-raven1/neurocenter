import http from 'node:http';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { McpHostService, type IMcpHostLimits } from '../host';
import type { IHostedMcpClaim } from '../ticket';

/** Минимальный streamable-HTTP MCP: initialize/tools/list по POST; GET — 405 (SSE-стрима нет). */
function startMcpServer(): Promise<{ url: string; close: () => Promise<void> }> {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.method === 'GET') {
                res.writeHead(405, { allow: 'POST' });
                res.end();
                return;
            }
            if (req.method === 'DELETE') {
                res.writeHead(200);
                res.end();
                return;
            }
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
            });
            req.on('end', () => {
                let message: { method?: string; id?: number } = {};
                try {
                    message = JSON.parse(body || '{}');
                } catch {
                    /* notification/повреждённое тело — 202 */
                }
                const json = (payload: unknown) => {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(payload));
                };
                if (message.method === 'initialize') {
                    json({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            protocolVersion: '2025-06-18',
                            capabilities: { tools: {} },
                            serverInfo: { name: 'pool-fixture', version: '1' },
                        },
                    });
                    return;
                }
                if (message.method === 'tools/list') {
                    json({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
                    return;
                }
                res.writeHead(202);
                res.end();
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as net.AddressInfo).port;
            resolve({
                url: `http://127.0.0.1:${port}/mcp`,
                close: () =>
                    new Promise<void>((done) => {
                        server.closeAllConnections?.();
                        server.close(() => done());
                    }),
            });
        });
    });
}

const limits = (over: Partial<IMcpHostLimits> = {}): IMcpHostLimits => ({
    maxHosts: 4,
    maxPerProject: 8,
    maxPerDevice: 2,
    maxChannelsPerHost: 4,
    authzCacheTtlMs: 60000,
    ...over,
});

const claimFor = (
    mcpUrl: string,
    over: { project?: string; device?: string; artifact?: string } = {},
): IHostedMcpClaim => ({
    artifactSha256: over.artifact ?? 'a'.repeat(64),
    descriptorSha256: 'e'.repeat(64),
    entrypoint: 'server.mjs',
    executable: false,
    name: 'pool',
    compressedBytes: 12,
    session: {
        deviceId: over.device ?? 'device-1',
        projectId: over.project ?? 'project-1',
        assetId: 'asset-' + (over.project ?? 'project-1'),
        version: 1,
        manifest: 'b'.repeat(64),
    },
    operationRemote: { url: mcpUrl, headers: {} },
});

describe('Пул хостов MCP: квоты (AD-4)', () => {
    it('глобальный лимит: превышение maxHosts — actionable 503', async () => {
        const mcp = await startMcpServer();
        const service = new McpHostService('http://catalog.test', 'token', limits({ maxHosts: 1 }));
        try {
            await service.adopt(claimFor(mcp.url, { project: 'p1' }));
            await expect(service.adopt(claimFor(mcp.url, { project: 'p2' }))).rejects.toMatchObject({
                status: 503,
            });
            await expect(service.adopt(claimFor(mcp.url, { project: 'p2' }))).rejects.toThrow(
                /Лимит хостов MCP площадки исчерпан/,
            );
        } finally {
            await service.onModuleDestroy();
            await mcp.close();
        }
    });

    it('per-project квота: второй хост того же проекта — 503, чужой проект проходит', async () => {
        const mcp = await startMcpServer();
        const service = new McpHostService('http://catalog.test', 'token', limits({ maxPerProject: 1 }));
        try {
            await service.adopt(claimFor(mcp.url, { project: 'p1', device: 'd1' }));
            await expect(
                service.adopt(claimFor(mcp.url, { project: 'p1', device: 'd2', artifact: 'c'.repeat(64) })),
            ).rejects.toThrow(/Лимит хостов MCP проекта исчерпан/);
            // Другой проект не ограничен квотой p1.
            await service.adopt(claimFor(mcp.url, { project: 'p2', device: 'd3' }));
        } finally {
            await service.onModuleDestroy();
            await mcp.close();
        }
    });

    it('per-device квота: второй хост того же устройства — 503, чужое устройство проходит', async () => {
        const mcp = await startMcpServer();
        const service = new McpHostService('http://catalog.test', 'token', limits({ maxPerDevice: 1 }));
        try {
            await service.adopt(claimFor(mcp.url, { project: 'p1', device: 'd1' }));
            await expect(
                service.adopt(claimFor(mcp.url, { project: 'p2', device: 'd1', artifact: 'c'.repeat(64) })),
            ).rejects.toThrow(/Лимит хостов MCP этого компьютера исчерпан/);
            await service.adopt(claimFor(mcp.url, { project: 'p3', device: 'd2' }));
        } finally {
            await service.onModuleDestroy();
            await mcp.close();
        }
    });

    it('cap каналов на hostKey: сверх лимита — 503, повторное подключение не тратит пул', async () => {
        const mcp = await startMcpServer();
        const service = new McpHostService('http://catalog.test', 'token', limits({ maxChannelsPerHost: 2 }));
        const claim = claimFor(mcp.url);
        try {
            const first = await service.adopt(claim);
            // Повторный канал того же hostKey — тот же child, без нового хоста в пуле.
            expect(await service.adopt(claim)).toBe(first);
            // Cap достигнут: третий канал на hostKey отклонён.
            await expect(service.adopt(claim)).rejects.toThrow(/Лимит каналов на этот MCP исчерпан/);
            // Свободился слот — канал снова принимается.
            service.release(claim, first);
            expect(await service.adopt(claim)).toBe(first);
            service.release(claim, first);
            service.release(claim, first);
        } finally {
            await service.onModuleDestroy();
            await mcp.close();
        }
    });
});
