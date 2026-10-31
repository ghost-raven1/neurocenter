import { ForbiddenException } from '@nestjs/common';
import * as http from 'node:http';

import type { Request } from 'express';

/**
 * Роль, необходимая для записи. По умолчанию 'admin': oauth2-bridge выдаёт
 * userRoles ['admin', ...] и роли 'rag:write' в системе прав не существует —
 * gateway инжектит x-bridge-roles из этих userRoles.
 */
export const RAG_WRITE_ROLE: string = process.env.RAG_WRITE_ROLE || 'admin';

/**
 * DEV-обход role-gate (только dev!): true = не проверять роли.
 * В prod обязателен false.
 */
const AUTH_DISABLED: boolean = process.env.RAG_AUTH_DISABLED === 'true';

function extractRoles(req: Request): string[] {
    const h = req.headers['x-bridge-roles'];
    if (typeof h !== 'string') {
        return [];
    }
    return h
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Требует у вызывающего роль записи (x-bridge-roles). Отказ по умолчанию.
 *
 * @param req - запрос с заголовками identity от gateway.
 */
export function assertWrite(req: Request): void {
    if (AUTH_DISABLED) {
        return;
    }
    if (!extractRoles(req).includes(RAG_WRITE_ROLE)) {
        throw new ForbiddenException(`требуется роль: ${RAG_WRITE_ROLE}`);
    }
}

/**
 * principal из заголовка `x-bridge-principal` (инжектится gateway).
 */
function extractPrincipal(req: Request): string | null {
    const h = req.headers['x-bridge-principal'];
    const v = Array.isArray(h) ? h[0] : h;
    return typeof v === 'string' && v.length > 0 ? v : null;
}

const CATALOG_URL: string = (process.env.CATALOG_SERVICE_URL || 'http://localhost:4100').replace(/\/+$/, '');

/**
 * Уровень роли principal в проекте projectKey через каталог (GET .../role-level).
 * При недоступности каталога — 0 (fail-closed).
 */
function resolveRoleLevel(projectKey: string, principal: string | null, req: Request): Promise<number> {
    const url = `${CATALOG_URL}/api/projects/${encodeURIComponent(projectKey)}/role-level?principal=${encodeURIComponent(principal ?? '')}`;
    return new Promise<number>((resolve) => {
        let done = false;
        const settle = (v: number): void => {
            if (!done) {
                done = true;
                resolve(v);
            }
        };
        const rq = http.get(
            url,
            {
                headers: {
                    'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '',
                    'x-bridge-actor': String(req.headers['x-bridge-actor'] || ''),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => {
                    data += chunk.toString('utf8');
                });
                res.on('end', () => {
                    try {
                        const body = JSON.parse(data || '{}') as { level?: number };
                        settle(Number(body.level ?? 0));
                    } catch {
                        settle(0);
                    }
                });
            },
        );
        rq.on('error', () => settle(0));
        rq.setTimeout(8000, () => {
            rq.destroy(new Error('timeout'));
            settle(0);
        });
    });
}

/**
 * RBAC по 4-ролевой матрице через каталог: требует minLevel у роли principal
 * в проекте projectKey. 2 — Разработчик (скачать базу RAG), 3 — Админ проекта
 * (синхронизация develop-индекса). Fail-closed.
 */
export async function assertMinLevel(req: Request, projectKey: string, minLevel: number): Promise<void> {
    if (AUTH_DISABLED) {
        return;
    }
    const principal = extractPrincipal(req);
    const level = await resolveRoleLevel(projectKey, principal, req);
    if (level < minLevel) {
        throw new ForbiddenException(`требуется уровень роли >= ${minLevel} (получено: ${level})`);
    }
}
