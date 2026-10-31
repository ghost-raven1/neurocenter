import { BadRequestException, Body, Controller, Get, ForbiddenException, Patch, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { assertMinLevel } from './role';
import { RagService } from './rag.service';
import { ragPagination } from './rag-validation';
import type { IRagQuotaUpdate } from './quota/rag-quota';

function requireProjectKey(v: string | undefined): string {
    const pk = typeof v === 'string' ? v.trim() : '';
    if (!pk) {
        throw new BadRequestException('projectKey is required');
    }
    return pk;
}

/**
 * REST RAG-дельта-синхронизации (разом через gateway, role-gated запись).
 */
@Controller('api/rag')
export class RagController {
    constructor(private readonly ragService: RagService) {}

    /**
     * GET /api/rag/manifest?projectKey= — снимок `{ id -> content_hash }`
     * (baseline для local diff).
     *
     * @param projectKey - ключ проекта.
     * @returns {{ projectKey, count, ids }}
     */
    @Get('manifest')
    public async manifest(@Query('projectKey') projectKey: string | undefined) {
        const pk = requireProjectKey(projectKey);
        const manifest = await this.ragService.manifest(pk);
        return { projectKey: pk, count: Object.keys(manifest.ids).length, ...manifest };
    }

    /**
     * GET /api/rag/summary?projectKey= — счётчики/последний sync/dim.
     *
     * @param projectKey - ключ проекта.
     * @returns {{ projectKey, rowCount, lastSyncedAt, dimension }}
     */
    @Get('database')
    public async database(@Query('projectKey') projectKey: string | undefined) {
        return this.ragService.databaseInfo(requireProjectKey(projectKey));
    }

    @Get('summary')
    public async summary(@Query('projectKey') projectKey: string | undefined) {
        const pk = requireProjectKey(projectKey);
        return { projectKey: pk, ...(await this.ragService.summary(pk)) };
    }

    /**
     * GET /api/rag/size?projectKey= — оценка размера develop-индекса проекта
     * в байтах (таблица+индексы, доля по числу строк).
     *
     * @param projectKey - ключ проекта.
     * @returns {{ projectKey, bytes }}
     */
    @Get('size')
    public async size(@Query('projectKey') projectKey: string | undefined) {
        const pk = requireProjectKey(projectKey);
        return { projectKey: pk, bytes: await this.ragService.retainedSizeBytes(pk) };
    }

    /**
     * GET /api/rag/chunks?projectKey=&limit=&offset= — страница полных строк
     * develop-индекса (включая эмбеддинги). Источник для обратной
     * синхронизации моста (pgvector → локальная LanceDB). Пагинация — защита
     * от OOM на больших индексах (не грузить весь индекс одним ответом).
     *
     * @param projectKey - ключ проекта.
     * @param limit - размер страницы (деф. 1000, макс 2000).
     * @param offset - смещение.
     * @returns {{ projectKey, count, dimension, offset, limit, hasMore, chunks }}
     */
    @Get('chunks')
    public async chunks(
        @Query('projectKey') projectKey: string | undefined,
        @Query('limit') limit: string | undefined,
        @Query('offset') offset: string | undefined,
        @Query('generation') generation?: string,
    ) {
        const pk = requireProjectKey(projectKey);
        const { limit: lim, offset: off } = ragPagination(limit, offset);
        const { chunks, ...summary } = await this.ragService.exportPage(pk, lim, off, generation);
        return {
            projectKey: pk,
            ...summary,
            count: summary.rowCount,
            offset: off,
            limit: lim,
            hasMore: off + chunks.length < summary.rowCount,
            chunks,
        };
    }

    /**
     * GET /api/rag/projects — список develop-индексов по всем projectKey
     * (админ-модуль RAG).
     *
     * @returns {Promise<{ projects: IRagProjectSummary[] }>}
     */
    @Get('projects')
    public async projects() {
        return { projects: await this.ragService.listProjects() };
    }

    @Get('quota')
    async quota(@Query('projectKey') key: string, @Req() req: Request) {
        if (typeof key !== 'string' || !key.trim()) {
            throw new BadRequestException('Выберите проект.');
        }
        await assertMinLevel(req, key.trim(), 1);
        return this.ragService.quota(key.trim());
    }

    @Patch('quota')
    async updateQuota(@Body() body: IRagQuotaUpdate & { projectKey: string }, @Req() req: Request) {
        if (!body || typeof body.projectKey !== 'string' || !body.projectKey.trim()) {
            throw new BadRequestException('Выберите проект.');
        }
        const key = body.projectKey.trim();
        await assertMinLevel(req, key, 3);
        let actor: string | undefined;
        try {
            const identity = JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] || ''))) as {
                email?: unknown;
            };
            if (typeof identity.email === 'string' && identity.email.length <= 254) {
                actor = identity.email;
            }
        } catch {
            /* Нельзя заменить автора данными из тела запроса. */
        }
        if (!actor) {
            throw new ForbiddenException('Не удалось подтвердить автора изменения лимита.');
        }
        return this.ragService.quota(key, body, actor);
    }
}
