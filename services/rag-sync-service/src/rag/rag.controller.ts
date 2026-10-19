import {
    BadRequestException,
    Body,
    Controller,
    Get,
    ConflictException,
    ForbiddenException,
    Post,
    Patch,
    Query,
    Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { type ISyncBody } from './dto';
import { assertMinLevel } from './role';
import { RagService } from './rag.service';
import {ragPagination} from './rag-validation';
import type {IRagQuotaUpdate} from './quota/rag-quota';

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
        const ids = await this.ragService.manifest(pk);
        return { projectKey: pk, count: Object.keys(ids).length, ids };
    }

    /**
     * GET /api/rag/summary?projectKey= — счётчики/последний sync/dim.
     *
     * @param projectKey - ключ проекта.
     * @returns {{ projectKey, rowCount, lastSyncedAt, dimension }}
     */
    @Get('database')
    public async database(@Query('projectKey') projectKey:string|undefined) { return this.ragService.databaseInfo(requireProjectKey(projectKey)); }

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
    ) {
        const pk = requireProjectKey(projectKey);
        const {limit:lim,offset:off}=ragPagination(limit,offset);
        const [rows, total] = await Promise.all([
            this.ragService.rowsPage(pk, lim, off),
            this.ragService.count(pk),
        ]);
        return {
            projectKey: pk,
            count: total,
            dimension: rows[0]?.embedding?.length ?? 0,
            offset: off,
            limit: lim,
            hasMore: off + rows.length < total,
            chunks: rows,
        };
    }

    /**
     * POST /api/rag/restore-local — обратная синхронизация (role-gated, как
     * /sync): запускает мост `neurocenter-asset-sync` (oneshot `--run
     * restore_rag_db`), который скачивает develop-индекс из pgvector и пишет
     * в локальную LanceDB-базу проекта на диске. Корень проекта (fsRootPath)
     * rag-sync сам берёт из каталога по projectKey.
     *
     * @param body - { projectKey }
     * @param req - запрос (identity-заголовки от gateway).
     * @returns {Promise<Record<string, unknown>>} сводка восстановления.
     */
    @Post('restore-local')
    public async restoreLocal(@Body() body: { projectKey?: string }, @Req() req: Request) {
        const pk = requireProjectKey(body?.projectKey);
        await assertMinLevel(req, pk, 2);
        throw new ConflictException('Скачивание в локальную папку выполняется агентом на вашем компьютере.');
    }

    /**
     * POST /api/rag/bootstrap — bootstrap-индексация (role ≥ 3): запускает
     * мост `--run sync_rag_db` (oneshot) с cwd = корень проекта, который
     * читает локальную LanceDB и загружает её в develop-индекс (pgvector).
     * Идемпотентно: первая загрузка = полный bootstrap, повторный вызов — дельта.
     *
     * @param body - { projectKey }
     * @param req - запрос (identity-заголовки от gateway).
     * @returns {Promise<Record<string, unknown>>} сводка синхронизации.
     */
    @Post('bootstrap')
    public async bootstrap(@Body() body: { projectKey?: string }, @Req() req: Request) {
        const pk = requireProjectKey(body?.projectKey);
        await assertMinLevel(req, pk, 3);
        throw new ConflictException('Отправку локальной базы выполняет агент на вашем компьютере.');
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

    /**
     * POST /api/rag/sync — dельта-apply (role-gated: x-bridge-roles → rag:write).
     *
     * @param body - { projectKey, chunks?, deletes? }
     * @param req - запрос (identity-заголовки от gateway).
     * @returns {{ projectKey, upserted, deleted }}
     */
    @Post('sync')
    public async sync(@Body() body: ISyncBody, @Req() req: Request) {
        if (!body || typeof body.projectKey !== 'string' || !body.projectKey.trim()) {
            throw new BadRequestException('projectKey is required');
        }
        const pk = body.projectKey.trim();
        await assertMinLevel(req, pk, 2);
        const chunks = body.chunks===undefined ? [] : body.chunks;
        const deletes = body.deletes===undefined ? [] : body.deletes;
        const result = await this.ragService.applyDelta(pk, chunks, deletes);
        return { projectKey: pk, ...result };
    }

    @Get('quota')
    async quota(@Query('projectKey') key:string,@Req() req:Request){
        if(typeof key!=='string'||!key.trim()){throw new BadRequestException('Выберите проект.');}
        await assertMinLevel(req,key.trim(),1);return this.ragService.quota(key.trim());
    }

    @Patch('quota')
    async updateQuota(@Body() body:IRagQuotaUpdate&{projectKey:string},@Req() req:Request){
        if(!body||typeof body.projectKey!=='string'||!body.projectKey.trim()){throw new BadRequestException('Выберите проект.');}
        const key=body.projectKey.trim();await assertMinLevel(req,key,3);
        let actor:string|undefined;
        try{const identity=JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor']||''))) as {email?:unknown};if(typeof identity.email==='string'&&identity.email.length<=254){actor=identity.email;}}catch{/* Нельзя заменить автора данными из тела запроса. */}
        if(!actor){throw new ForbiddenException('Не удалось подтвердить автора изменения лимита.');}
        return this.ragService.quota(key,body,actor);
    }
}
