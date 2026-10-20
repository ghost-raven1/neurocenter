import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { HostedMcpClaim } from './ticket';
import { materializeArtifact } from './artifact-cache';

const MAX_HOSTS = Math.max(1, Number(process.env.NEUROCENTER_MCP_HOST_MAX || 4));
const IDLE_TTL_MS = 30 * 60 * 1000;
const START_TIMEOUT_MS = 20000;
const TOOL_OUTPUT_LIMIT = 8 * 1024 * 1024;

interface HostSession { claim: HostedMcpClaim; client: Client; lastUsed: number; listeners: number }

class McpHostService {
    private readonly hosts = new Map<string, HostSession>();
    private readonly starting = new Map<string, Promise<HostSession>>();

    constructor(private readonly catalogUrl: string, private readonly internalToken: string) {
        setInterval(() => { this.reap(); }, 60 * 1000).unref();
    }

    private async adopt(claim: HostedMcpClaim): Promise<HostSession> {
        let session = this.hosts.get(claim.artifactSha256);
        if (!session) {
            const starting = this.starting.get(claim.artifactSha256);
            if (starting) { session = await starting; }
            else {
                this.reap();
                if (this.hosts.size >= MAX_HOSTS) { throw httpError(503, 'Лимит хостов MCP площадки исчерпан. Вернитесь позже.'); }
                const task = this.spawn(claim).finally(() => this.starting.delete(claim.artifactSha256));
                this.starting.set(claim.artifactSha256, task);
                session = await task;
                this.hosts.set(claim.artifactSha256, session);
            }
        }
        if (session.claim.entrypoint !== claim.entrypoint || session.claim.executable !== claim.executable) {
            throw httpError(503, 'Комплект хоста конфликтует. Повторите подключение.');
        }
        session.lastUsed = Date.now();
        session.listeners += 1;
        return session;
    }

    private release(_claim: HostedMcpClaim, session: HostSession): void {
        session.listeners = Math.max(0, session.listeners - 1);
        session.lastUsed = Date.now();
    }

    private async spawn(claim: HostedMcpClaim): Promise<HostSession> {
        const root = await materializeArtifact(claim, this.catalogUrl, this.internalToken);
        const entry = entryPath(root, claim.entrypoint);
        let started: HostSession | undefined;
        const transport = new StdioClientTransport({
            command: claim.executable ? entry : process.execPath,
            args: claim.executable ? [] : [entry],
            cwd: root,
            env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || '/tmp', LANG: 'C.UTF-8' },
            stderr: 'pipe',
        });
        const client = new Client({ name: 'neurocenter-mcp-host', version: '1' }, { capabilities: {} });
        try {
            await withTimeout(client.connect(transport), START_TIMEOUT_MS, 'Запуск сервера MCP на площадке превысил время ожидания.');
            started = { claim, client, lastUsed: Date.now(), listeners: 0 };
        } catch (error) {
            await transport.close().catch(() => undefined);
            throw httpError(502, (error as Error).message || 'Сервер MCP не запустился на площадке.');
        }
        transport.onclose = () => {
            const current = this.hosts.get(claim.artifactSha256);
            if (current && current.client === client) {
                this.hosts.delete(claim.artifactSha256);
                void client.close().catch(() => undefined);
            }
        };
        return started;
    }

    private reap(): void {
        for (const [key, session] of [...this.hosts]) {
            if (session.lastUsed < Date.now() - IDLE_TTL_MS) {
                this.hosts.delete(key);
                void session.client.close().catch(() => undefined);
            }
        }
    }

    /** Безstate-канал: инструменты проксируются в общий процесс-сервер, транспорт живёт ровно время канала. */
    async handle(claim: HostedMcpClaim, req: Request, res: Response): Promise<void> {
        let session: HostSession;
        try { session = await this.adopt(claim); }
        catch (error) {
            const e = error as { status?: number; message?: string };
            if (!res.headersSent) { res.status(e.status || 502).json({ jsonrpc: '2.0', error: { code: e.status === 503 ? -32000 : -32603, message: e.message || 'Хост MCP недоступен.' }, id: null }); }
            return;
        }
        try {
            const listed = await withTimeout(session.client.listTools(), START_TIMEOUT_MS, 'Список инструментов хоста не отвечал вовремя.');
            const server = new Server({ name: claim.name || 'neurocenter-hosted-mcp', version: '1' }, { capabilities: { tools: { listChanged: false } } });
            server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed.tools }));
            server.setRequestHandler(CallToolRequestSchema, async request => {
                const result = await session.client.callTool({ name: request.params.name, arguments: request.params.arguments ?? {} });
                if (Buffer.byteLength(JSON.stringify(result.content ?? []), 'utf8') > TOOL_OUTPUT_LIMIT) {
                    return { content: [{ type: 'text', text: 'Ответ инструмента превышает размер площадки.' }], isError: true };
                }
                return result;
            });
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
            transport.onclose = () => { this.release(claim, session); };
            await server.connect(transport);
            await transport.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, (req.body ?? {}) as Record<string, unknown>);
            if (!res.writableEnded) { res.end(); }
        } catch (error) {
            const e = error as { status?: number; message?: string };
            if (!res.headersSent && !res.writableEnded) { res.status(e.status || 500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message || 'Хост MCP недоступен.' }, id: null }); }
            else if (!res.writableEnded) { try { res.end(); } catch { /* Канал уже закрыт. */ } }
        }
    }
}

function entryPath(root: string, entrypoint: string): string {
    if (path.isAbsolute(entrypoint) || entrypoint.includes('..')) { throw httpError(500, 'Некорректная точка входа хоста.'); }
    const absolute = path.resolve(root, entrypoint);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) { throw httpError(500, 'Некорректная точка входа хоста.'); }
    return absolute;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(httpError(504, message)), ms); timer.unref(); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function httpError(status: number, message: string): Error & { status: number } {
    const error = new Error(message) as Error & { status: number };
    error.status = status;
    return error;
}

export { McpHostService };
