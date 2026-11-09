/**
 * Per-project квота кэша MCP-артефактов (AD-D2).
 *
 * Лимит и фактические bytes проекта gateway читает из единой точки
 * accounting (catalog `GET /internal/projects/:id/quota-usage`, таблица
 * project_quota_usage, epic-data story 1) и туда же отправляет дельты
 * измерения `current`: кредит при сборке нового комплекта, дебет при LRU-
 * эвикции.
 *
 * Best-effort: ошибка квоты не ломает материализацию артефакта (кэш —
 * оптимизация, не источник истины); ошибки логируются как warn.
 */
import { randomUUID } from 'node:crypto';

/** Снимок измерения current для кэша: used-байты проекта и лимит (0 — безлимит по AD-D4). */
export interface IArtifactQuotaSnapshot {
    used: number;
    limit: number;
}

export type TArtifactQuotaFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface IArtifactQuotaOptions {
    catalogUrl?: string;
    internalToken?: string;
    fetchImpl?: TArtifactQuotaFetch;
    warn?: (message: string) => void;
}

const QUOTA_TIMEOUT_MS = 10000;

const quotaBase = (options: IArtifactQuotaOptions): string =>
    (options.catalogUrl ?? process.env.CATALOG_SERVICE_URL ?? 'http://localhost:4100').replace(/\/+$/, '');
const quotaToken = (options: IArtifactQuotaOptions): string =>
    options.internalToken ?? process.env.NEUROCENTER_INTERNAL_TOKEN ?? '';

/** Читает used/limit измерения current; при любой ошибке — null (без эвикции). */
export async function readProjectArtifactQuota(
    projectId: string,
    options: IArtifactQuotaOptions = {},
): Promise<IArtifactQuotaSnapshot | null> {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const warn = options.warn ?? ((message: string) => console.warn(message));
    try {
        const response = await fetchImpl(`${quotaBase(options)}/internal/projects/${encodeURIComponent(projectId)}/quota-usage`, {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
            headers: { 'x-neurocenter-internal': quotaToken(options) },
        });
        if (!response.ok) {
            await response.body?.cancel();
            warn(`[api-gateway] artifact quota read failed project=${projectId} status=${response.status}`);
            return null;
        }
        const data = (await response.json()) as { used?: unknown; limits?: unknown };
        const used = (data.used as Record<string, unknown> | undefined)?.current;
        const limit = (data.limits as Record<string, unknown> | undefined)?.current;
        if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0) return null;
        if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) return null;
        return { used, limit };
    } catch (error) {
        warn(`[api-gateway] artifact quota read failed project=${projectId} error=${String(error)}`);
        return null;
    }
}

/** Применяет дельту bytes к измерению current проекта; идемпотентно по requestKey. */
export async function recordArtifactQuotaDelta(
    projectId: string,
    deltaBytes: number,
    requestKey: string,
    options: IArtifactQuotaOptions = {},
): Promise<boolean> {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const warn = options.warn ?? ((message: string) => console.warn(message));
    try {
        const response = await fetchImpl(
            `${quotaBase(options)}/internal/projects/${encodeURIComponent(projectId)}/quota-usage`,
            {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
                headers: { 'content-type': 'application/json', 'x-neurocenter-internal': quotaToken(options) },
                body: JSON.stringify({ dimension: 'current', deltaBytes, request_key: requestKey }),
            },
        );
        if (!response.ok) {
            await response.body?.cancel();
            warn(
                `[api-gateway] artifact quota delta failed project=${projectId} delta=${deltaBytes} status=${response.status}`,
            );
            return false;
        }
        await response.body?.cancel();
        return true;
    } catch (error) {
        warn(`[api-gateway] artifact quota delta failed project=${projectId} delta=${deltaBytes} error=${String(error)}`);
        return false;
    }
}

/** Ключ идемпотентности кредита сборки: уникален на событие (повтор после эвикции — новая дельта). */
export const artifactQuotaBuildKey = (sha256: string, projectId: string): string =>
    `mcp-cache:build:${sha256}:${projectId}:${randomUUID()}`;

/** Ключ идемпотентности дебита эвикции: уникален на событие. */
export const artifactQuotaEvictKey = (sha256: string, projectId: string): string =>
    `mcp-cache:evict:${sha256}:${projectId}:${randomUUID()}`;
