import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { OwnedHostedStdio } from './owned-stdio';
import { operationRemoteTransport } from './operation-remote';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { IHostedMcpClaim, IHostedMcpSession } from './ticket';
import { materializeArtifact } from './artifact-cache';
import { validHostedMcpSession } from './ticket';

/** Child MCPs inherit trusted CA/proxy settings, without provider keys or arbitrary Node preload code. */
export function hostedMcpEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const result: Record<string, string> = {
        PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
        HOME: env.HOME || '/tmp',
        LANG: 'C.UTF-8',
    };
    for (const key of [
        'NODE_EXTRA_CA_CERTS',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
        'NODE_USE_SYSTEM_CA',
        'NODE_USE_ENV_PROXY',
        'HTTPS_PROXY',
        'HTTP_PROXY',
        'ALL_PROXY',
        'NO_PROXY',
        'https_proxy',
        'http_proxy',
        'all_proxy',
        'no_proxy',
    ])
        if (env[key]) result[key] = env[key]!;
    return result;
}

const IDLE_TTL_MS = 30 * 60 * 1000;
const START_TIMEOUT_MS = 20000;
const TOOL_OUTPUT_LIMIT = 8 * 1024 * 1024;
/** AD-4: окно отзыва привязки = TTL кэша re-check; больше 60s не разрастается по построению. */
export const AUTHZ_CACHE_TTL_CAP_MS = 60 * 1000;

/** AD-4/AD-9: квоты пула хостов. Недопустимое значение — fail-fast на старте (не неограниченный пул). */
export interface IMcpHostLimits {
    /** Глобальный пул child-MCP (default 4). */
    maxHosts: number;
    /** Активные хосты одного проекта (default 8). */
    maxPerProject: number;
    /** Активные хосты одного устройства (default 2). */
    maxPerDevice: number;
    /** Активные каналы (OpenCode-клиенты) на один hostKey (default 4). */
    maxChannelsPerHost: number;
    /** TTL единого кэша device↔project re-check, ms (default 60000, максимум 60000 — AD-4). */
    authzCacheTtlMs: number;
}
const AUTHZ_CACHE_MAX_ENTRIES = 1024;
export function parseMcpHostLimits(env: NodeJS.ProcessEnv = process.env): IMcpHostLimits {
    const positive = (name: string, fallback: number): number => {
        const raw = env[name];
        if (raw === undefined || raw === '') return fallback;
        const value = Number(raw);
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new Error(name + ' обязателен целым числом не меньше 1.');
        }
        return value;
    };
    let authzCacheTtlMs = AUTHZ_CACHE_TTL_CAP_MS;
    const ttlRaw = env.NEUROCENTER_MCP_HOST_AUTHZ_TTL_MS;
    if (ttlRaw !== undefined && ttlRaw !== '') {
        const ttl = Number(ttlRaw);
        if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > AUTHZ_CACHE_TTL_CAP_MS) {
            throw new Error(
                'NEUROCENTER_MCP_HOST_AUTHZ_TTL_MS обязателен целым числом 1..' + AUTHZ_CACHE_TTL_CAP_MS + '.',
            );
        }
        authzCacheTtlMs = ttl;
    }
    return {
        maxHosts: positive('NEUROCENTER_MCP_HOST_MAX', 4),
        maxPerProject: positive('NEUROCENTER_MCP_HOST_MAX_PER_PROJECT', 8),
        maxPerDevice: positive('NEUROCENTER_MCP_HOST_MAX_PER_DEVICE', 2),
        maxChannelsPerHost: positive('NEUROCENTER_MCP_HOST_MAX_CHANNELS', 4),
        authzCacheTtlMs,
    };
}

interface IHostSession {
    claim: IHostedMcpClaim;
    client: Client;
    lastUsed: number;
    listeners: number;
    deadline?: ReturnType<typeof setTimeout>;
}

class McpHostService {
    private readonly hosts = new Map<string, IHostSession>();
    private readonly starting = new Map<string, { claim: IHostedMcpClaim; task: Promise<IHostSession> }>();
    private readonly idleTimer: ReturnType<typeof setInterval>;
    /** AD-4: ЕДИНЫЙ кэш connect-lookup и per-op re-check: ключ — каноническая сессия, TTL ≤60s. */
    private readonly authzCache = new Map<string, number>();

    constructor(
        private readonly catalogUrl: string,
        private readonly internalToken: string,
        private readonly limits: IMcpHostLimits = parseMcpHostLimits(),
    ) {
        this.idleTimer = setInterval(() => {
            this.reap();
        }, 60 * 1000);
        this.idleTimer.unref();
    }
    private hostKey(claim: IHostedMcpClaim): string {
        return JSON.stringify([
            claim.artifactSha256,
            claim.session?.projectId,
            claim.session?.deviceId,
            claim.session?.manifest,
            claim.researchSessionId,
            claim.operationSessionId,
        ]);
    }

    /** AD-4: квоты пула считаются по активным хостам (hosts) и запускающимся (starting). */
    private poolCounts(): { total: number; projects: Map<string, number>; devices: Map<string, number> } {
        const projects = new Map<string, number>();
        const devices = new Map<string, number>();
        const count = (claim: IHostedMcpClaim) => {
            const session = claim.session;
            if (!session) return;
            projects.set(session.projectId, (projects.get(session.projectId) ?? 0) + 1);
            devices.set(session.deviceId, (devices.get(session.deviceId) ?? 0) + 1);
        };
        for (const session of this.hosts.values()) count(session.claim);
        for (const inflight of this.starting.values()) count(inflight.claim);
        return { total: this.hosts.size + this.starting.size, projects, devices };
    }

    /** AD-4: получение хоста с проверкой квот пула (глобальный/per-project/per-device) и cap каналов. */
    async adopt(claim: IHostedMcpClaim, signal?: AbortSignal): Promise<IHostSession> {
        const key = this.hostKey(claim);
        let session = this.hosts.get(key);
        if (!session) {
            const starting = this.starting.get(key);
            if (starting) {
                session = await starting.task;
            } else {
                this.reap();
                const counts = this.poolCounts();
                if (counts.total >= this.limits.maxHosts) {
                    throw httpError(503, 'Лимит хостов MCP площадки исчерпан. Вернитесь позже.');
                }
                if (claim.session) {
                    if ((counts.projects.get(claim.session.projectId) ?? 0) >= this.limits.maxPerProject) {
                        throw httpError(503, 'Лимит хостов MCP проекта исчерпан. Закройте лишние каналы и повторите.');
                    }
                    if ((counts.devices.get(claim.session.deviceId) ?? 0) >= this.limits.maxPerDevice) {
                        throw httpError(
                            503,
                            'Лимит хостов MCP этого компьютера исчерпан. Закройте лишние каналы и повторите.',
                        );
                    }
                }
                const task = this.spawn(
                    claim,
                    claim.operationSessionId || claim.researchSessionId ? signal : undefined,
                ).finally(() => this.starting.delete(key));
                this.starting.set(key, { claim, task });
                session = await task;
                this.hosts.set(key, session);
            }
        }
        if (
            session.claim.entrypoint !== claim.entrypoint ||
            session.claim.executable !== claim.executable ||
            JSON.stringify(session.claim.operationRemote) !== JSON.stringify(claim.operationRemote) ||
            JSON.stringify(session.claim.operationArgs) !== JSON.stringify(claim.operationArgs)
        ) {
            throw httpError(503, 'Комплект хоста конфликтует. Повторите подключение.');
        }
        // AD-4: cap активных каналов на hostKey — общий child не принимает канал сверх лимита.
        if (session.listeners >= this.limits.maxChannelsPerHost) {
            throw httpError(503, 'Лимит каналов на этот MCP исчерпан. Закройте лишние окна и повторите.');
        }
        session.lastUsed = Date.now();
        session.listeners += 1;
        return session;
    }

    /** AD-4: освобождение канала (slot cap'а hostKey); сам хост живёт до idle-reap. */
    release(_claim: IHostedMcpClaim, session: IHostSession): void {
        session.listeners = Math.max(0, session.listeners - 1);
        session.lastUsed = Date.now();
    }

    /** Server research uses the same approved Gateway artifact, with cancellation on each actual MCP operation. */
    async researchTools(claim: IHostedMcpClaim, signal: AbortSignal) {
        signal.throwIfAborted();
        const session = await this.adopt(claim, signal);
        try {
            signal.throwIfAborted();
            return await session.client.listTools(undefined, { signal, timeout: 15000 });
        } finally {
            this.release(claim, session);
        }
    }

    async researchCall(claim: IHostedMcpClaim, name: string, args: Record<string, unknown>, signal: AbortSignal) {
        signal.throwIfAborted();
        const session = await this.adopt(claim, signal);
        try {
            signal.throwIfAborted();
            return await session.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 30000 });
        } finally {
            this.release(claim, session);
        }
    }
    /** Role operations reuse this same host and child; a browser survives navigation followed by snapshot. */
    async operationTools(claim: IHostedMcpClaim, signal: AbortSignal) {
        signal.throwIfAborted();
        const session = await this.adopt(claim, signal);
        try {
            const tools: unknown[] = [],
                seen = new Set<string>();
            let cursor: string | undefined;
            for (let page = 0; page < 8; page++) {
                signal.throwIfAborted();
                const result = await session.client.listTools(cursor ? { cursor } : undefined, {
                    signal,
                    timeout: 15000,
                });
                tools.push(...result.tools);
                if (tools.length > 128) throw httpError(502, 'MCP объявил слишком много инструментов.');
                cursor = result.nextCursor;
                if (!cursor) return { tools };
                if (seen.has(cursor)) throw httpError(502, 'MCP повторил страницу инструментов.');
                seen.add(cursor);
            }
            throw httpError(502, 'MCP превысил предел страниц инструментов.');
        } finally {
            this.release(claim, session);
        }
    }
    async operationCall(claim: IHostedMcpClaim, name: string, args: Record<string, unknown>, signal: AbortSignal) {
        return this.researchCall(claim, name, args, signal);
    }
    async closeOperationSession(claim: IHostedMcpClaim): Promise<void> {
        if (!claim.operationSessionId) return;
        const key = this.hostKey(claim),
            starting = this.starting.get(key);
        if (starting) await starting.task.catch(() => undefined);
        const session = this.hosts.get(key);
        this.hosts.delete(key);
        if (session) {
            if (session.deadline) clearTimeout(session.deadline);
            await session.client.close();
        }
    }
    /** Only a request's own research child is closed; public project sessions and shared artifact bytes stay intact. */
    async closeResearchSession(claim: IHostedMcpClaim): Promise<void> {
        if (!claim.researchSessionId) return;
        const key = this.hostKey(claim),
            session = this.hosts.get(key);
        this.hosts.delete(key);
        if (session) await session.client.close();
    }

    private async spawn(claim: IHostedMcpClaim, signal?: AbortSignal): Promise<IHostSession> {
        const root = claim.operationRemote
            ? undefined
            : await materializeArtifact(claim, this.catalogUrl, this.internalToken);
        signal?.throwIfAborted();
        const entry = root ? entryPath(root, claim.entrypoint) : undefined;
        let started: IHostSession | undefined;
        const transport = claim.operationRemote
            ? operationRemoteTransport(claim.operationRemote)
            : new OwnedHostedStdio(
                  claim.executable ? entry! : process.execPath,
                  [...(claim.executable ? [] : [entry!]), ...(claim.operationArgs ?? [])],
                  root!,
                  hostedMcpEnvironment(),
              );
        const client = new Client({ name: 'neurocenter-mcp-host', version: '1' }, { capabilities: {} });
        try {
            await withTimeout(
                client.connect(transport, { signal, timeout: START_TIMEOUT_MS }),
                START_TIMEOUT_MS,
                'Запуск сервера MCP на площадке превысил время ожидания.',
            );
            started = { claim, client, lastUsed: Date.now(), listeners: 0 };
            if (claim.operationSessionId) {
                const owned = started;
                owned.deadline = setTimeout(
                    () => {
                        const key = this.hostKey(claim);
                        if (this.hosts.get(key) === owned) this.hosts.delete(key);
                        void client.close().catch(() => undefined);
                    },
                    Math.max(1, Math.min(120000, claim.exp - Date.now())),
                );
                owned.deadline.unref();
            }
        } catch (error) {
            await transport.close().catch(() => undefined);
            throw httpError(502, (error as Error).message || 'Сервер MCP не запустился на площадке.');
        }
        const onclose = transport.onclose;
        transport.onclose = () => {
            // Preserve SDK rejection of pending calls and its request-timeout cleanup.
            try {
                onclose?.();
            } finally {
                const key = this.hostKey(claim),
                    current = this.hosts.get(key);
                if (current && current.client === client) {
                    if (current.deadline) clearTimeout(current.deadline);
                    this.hosts.delete(key);
                    void client.close().catch(() => undefined);
                }
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

    /** Shutdown waits for owned startup attempts, then closes every child and its stdio transport. */
    async onModuleDestroy(): Promise<void> {
        clearInterval(this.idleTimer);
        await Promise.allSettled([...this.starting.values()].map((inflight) => inflight.task));
        const sessions = [...this.hosts.values()];
        this.hosts.clear();
        for (const session of sessions) if (session.deadline) clearTimeout(session.deadline);
        await Promise.allSettled(sessions.map((session) => session.client.close()));
    }

    /** Безstate-канал: инструменты проксируются в общий процесс-сервер, транспорт живёт ровно время канала. */
    async handle(claim: IHostedMcpClaim, req: Request, res: Response): Promise<void> {
        let session: IHostSession;
        try {
            await this.authorizeSession(claim);
            session = await this.adopt(claim);
        } catch (error) {
            const e = error as { status?: number };
            if (!res.headersSent) {
                res.status(e.status || 502).json({
                    jsonrpc: '2.0',
                    error: { code: e.status === 503 ? -32000 : -32603, message: hostChannelMessage(error) },
                    id: null,
                });
            }
            return;
        }
        try {
            const listed = await withTimeout(
                session.client.listTools(),
                START_TIMEOUT_MS,
                'Список инструментов хоста не отвечал вовремя.',
            );
            const server = new Server(
                { name: claim.name || 'neurocenter-hosted-mcp', version: '1' },
                { capabilities: { tools: { listChanged: false } } },
            );
            server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
                await this.authorizeSession(claim, extra.signal);
                return { tools: listed.tools };
            });
            server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
                await this.authorizeSession(claim, extra.signal);
                const result = await session.client.callTool(
                    { name: request.params.name, arguments: request.params.arguments ?? {} },
                    undefined,
                    { signal: extra.signal, timeout: 30000 },
                );
                if (Buffer.byteLength(JSON.stringify(result.content ?? []), 'utf8') > TOOL_OUTPUT_LIMIT) {
                    return {
                        content: [{ type: 'text', text: 'Ответ инструмента превышает размер площадки.' }],
                        isError: true,
                    };
                }
                return result;
            });
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await server.connect(transport);
            await transport.handleRequest(
                req as unknown as IncomingMessage,
                res as unknown as ServerResponse,
                (req.body ?? {}) as Record<string, unknown>,
            );
            if (!res.writableEnded) {
                res.end();
            }
        } catch (error) {
            const e = error as { status?: number };
            if (!res.headersSent && !res.writableEnded) {
                res.status(e.status || 500).json({
                    jsonrpc: '2.0',
                    error: { code: -32603, message: hostChannelMessage(error) },
                    id: null,
                });
            } else if (!res.writableEnded) {
                try {
                    res.end();
                } catch {
                    /* Канал уже закрыт. */
                }
            }
        } finally {
            // Stateless-транспорт не вызывает onclose после обычного запроса: канал освобождается по завершении запроса.
            this.release(claim, session);
        }
    }

    /** AD-4: ключ канонической сессии — одна и та же запись кэша для connect-lookup и per-op re-check. */
    private authzKey(session: IHostedMcpSession, artifactSha256: string): string {
        return JSON.stringify([
            session.deviceId,
            session.projectId,
            session.assetId,
            session.version,
            session.manifest,
            artifactSha256,
        ]);
    }

    /** Ограниченный кэш: при записи чистим протухшее; при переполнении сбрасываем целиком (fail-closed не страдает). */
    private pruneAuthzCache(now: number): void {
        if (this.authzCache.size <= AUTHZ_CACHE_MAX_ENTRIES) {
            for (const [key, at] of this.authzCache) {
                if (now - at >= this.limits.authzCacheTtlMs) this.authzCache.delete(key);
            }
            return;
        }
        this.authzCache.clear();
    }

    /**
     * AD-4: re-check привязки device↔project через ЕДИНЫЙ кэш (connect-lookup + per-op ListTools/CallTool).
     * Кэш свежий (≤TTL) — без DB-транзакции в каталоге; lookup error/timeout — 503 fail-closed,
     * stale-while-error запрещён: протухший кэш не возвращает старый результат.
     */
    async authorizeSession(claim: IHostedMcpClaim, signal?: AbortSignal): Promise<void> {
        const session = claim.session;
        if (!validHostedMcpSession(session)) throw httpError(401, 'Соединение MCP нужно установить заново.');
        const key = this.authzKey(session, claim.artifactSha256);
        const now = Date.now();
        const cachedAt = this.authzCache.get(key);
        if (cachedAt !== undefined && now - cachedAt < this.limits.authzCacheTtlMs) return;
        try {
            const response = await fetch(this.catalogUrl.replace(/\/+$/, '') + '/internal/mcp-host/authorize-session', {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
                headers: { 'content-type': 'application/json', 'x-neurocenter-internal': this.internalToken },
                body: JSON.stringify({ ...session, artifactSha256: claim.artifactSha256 }),
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw httpError(
                    response.status === 403 || response.status === 401 ? 403 : 503,
                    'Доступ к MCP отозван или временно недоступен.',
                );
            }
            await response.body?.cancel();
            this.pruneAuthzCache(now);
            this.authzCache.set(key, now);
        } catch (error) {
            if ((error as { status?: number }).status) throw error;
            throw httpError(503, 'Не удалось подтвердить доступ к MCP.');
        }
    }
}

function entryPath(root: string, entrypoint: string): string {
    if (path.isAbsolute(entrypoint) || entrypoint.includes('..')) {
        throw httpError(500, 'Некорректная точка входа хоста.');
    }
    const absolute = path.resolve(root, entrypoint);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
        throw httpError(500, 'Некорректная точка входа хоста.');
    }
    return absolute;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(httpError(504, message)), ms);
        timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const HOST_DOMAIN_ERROR = Symbol('mcp-host-domain-error');

function httpError(status: number, message: string): Error & { status: number } {
    const error = new Error(message) as Error & { status: number } & { [HOST_DOMAIN_ERROR]?: boolean };
    error.status = status;
    // AD-19: доменная ошибка хоста — текст сформирован хостом (фиксированный), не транспортным exception.
    error[HOST_DOMAIN_ERROR] = true;
    return error;
}

/** AD-19: доменная ошибка хоста (квоты/авторизация — текст из кода хоста, user-safe). */
function isHostDomainError(error: unknown): error is Error & { status: number } {
    return error instanceof Error && (error as { [HOST_DOMAIN_ERROR]?: boolean })[HOST_DOMAIN_ERROR] === true;
}

/**
 * AD-19: jsonrpc-body несёт только user-safe текст: доменная ошибка хоста (allowlist —
 * текст сформирован хостом) или фиксированный fallback; детали transport-ошибок
 * (spawn/SDK) — только в server-лог.
 */
function hostChannelMessage(error: unknown): string {
    if (isHostDomainError(error)) return error.message;
    console.error(
        '[api-gateway] mcp-host channel error:',
        error instanceof Error ? error.message : String(error),
    );
    return 'Хост MCP недоступен.';
}

export { McpHostService };
