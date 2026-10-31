import { BadRequestException, Body, Controller, Delete, Get, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import { SkillsService } from './skills.service';
import type {
    IDirectoryCreateRequest,
    ISkillCreateRequest,
    ISkillFile,
    ISkillListSummary,
    ISkillTreeNode,
    ISkillUpdateRequest,
    ISkillsListQuery,
    ISkillsSyncRequest,
    ISkillsSyncResult,
} from './skills.model';

/**
 * Microservice скиллов на файловом хранилище (CephFS-паттерн).
 * Каталог скиллов = дерево `.md`-файлов; CRUD + дерево + папки.
 */
@Controller('api/skills')
export class SkillsController {
    public constructor(private readonly skills: SkillsService) {}

    /**
     * Дерево каталога скиллов.
     *
     * @returns {Promise<ISkillTreeNode[]>}
     */
    @Get('tree')
    public getTree(): Promise<ISkillTreeNode[]> {
        return this.skills.getTree();
    }

    /**
     * Список скиллов (по каталогу / всему дереву, с фильтрами).
     *
     * @param {ISkillsListQuery} query - параметры списка
     * @returns {Promise<ISkillListSummary[]>}
     */
    @Get()
    public listSkills(@Query() query: ISkillsListQuery): Promise<ISkillListSummary[]> {
        return this.skills.listSkills(query);
    }

    /**
     * Создание папки в каталоге.
     *
     * @param {IDirectoryCreateRequest} body - данные папки
     * @returns {Promise<{ ok: true, path: string }>}
     */
    @Post('directory')
    public createDirectory(
        @Body() body: IDirectoryCreateRequest,
        @Req() req?: Request,
    ): Promise<{ ok: true; path: string }> {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new BadRequestException('Передайте путь папки скиллов.');
        }
        return this.skills.createDirectory(body.path ?? '', this.auditActor(req));
    }

    /**
     * Создание скилла.
     *
     * @param body - данные скилла
     * @param req - запрос (автор из заголовка сессии)
     * @returns {Promise<ISkillFile>}
     */
    @Post()
    public createSkill(@Body() body: ISkillCreateRequest, @Req() req: Request): Promise<ISkillFile> {
        return this.skills.createSkill(body, this.author(req), this.auditActor(req));
    }

    /**
     * Синхронизация скиллов проекта (ingest, idempotent) — вызывается MCP-тулом `sync_skills`.
     *
     * @param body - projectKey + список карточек скиллов
     * @returns {Promise<ISkillsSyncResult>}
     */
    @Post('sync')
    public syncSkills(@Body() body: ISkillsSyncRequest, @Req() req?: Request): Promise<ISkillsSyncResult> {
        if (
            !body ||
            typeof body.projectKey !== 'string' ||
            body.projectKey.length === 0 ||
            !Array.isArray(body.skills)
        ) {
            throw new BadRequestException('Не заданы projectKey и/или skills');
        }

        return this.skills.syncSkills(body.projectKey, body.skills, this.auditActor(req));
    }

    /**
     * Чтение скилла (путь = остаток URL после /api/skills/, напр. common/jest-test).
     *
     * @param req - запрос (путь в req.params[0])
     * @returns {Promise<ISkillFile>}
     */
    /** Отдельный контракт пакета не позволяет старому сервису незаметно отбросить ресурсы. */
    @Get('_package/*skillPath')
    public getPackage(@Req() req: Request, @Query('version') version?: string): Promise<ISkillFile> {
        if (version === undefined) {
            throw new BadRequestException('Укажите точную версию установочного пакета.');
        }
        return this.getSkill(req, version);
    }

    @Get('*skillPath')
    public getSkill(@Req() req: Request, @Query('version') version?: string): Promise<ISkillFile> {
        const parsed = version === undefined ? undefined : Number(version);
        if (
            version !== undefined &&
            (typeof version !== 'string' || !/^[1-9][0-9]*$/.test(version) || !Number.isSafeInteger(parsed))
        ) {
            throw new BadRequestException('Версия должна быть положительным целым числом.');
        }
        return this.skills.getSkill(this.skillPathOf(req), parsed);
    }

    /**
     * Обновление скилла (путь = остаток URL).
     *
     * @param req - запрос (путь в req.params[0], автор в заголовке сессии)
     * @param body - данные обновления
     * @returns {Promise<ISkillFile>}
     */
    @Put('*skillPath')
    public updateSkill(@Req() req: Request, @Body() body: ISkillUpdateRequest): Promise<ISkillFile> {
        return this.skills.updateSkill(this.skillPathOf(req), body, this.author(req), this.auditActor(req));
    }

    /**
     * Удаление скилла (путь = остаток URL).
     *
     * @param req - запрос (путь в req.params[0])
     * @returns {Promise<{ ok: true, path: string }>}
     */
    @Delete('*skillPath')
    public deleteSkill(@Req() req: Request): Promise<{ ok: true; path: string }> {
        return this.skills.deleteSkill(this.skillPathOf(req), this.auditActor(req));
    }

    private skillPathOf(req: Request): string {
        const rest: unknown = req.params.skillPath;

        return Array.isArray(rest) ? rest.join('/') : typeof rest === 'string' ? rest.replace(/^\//, '') : '';
    }

    /** Заголовок исполнителя добавляет только авторизованный шлюз; тело запроса его не подменяет. */
    private auditActor(req?: Request): string {
        const header = req?.headers['x-bridge-actor'];
        try {
            const actor =
                typeof header === 'string'
                    ? (JSON.parse(decodeURIComponent(header)) as { email?: unknown })
                    : undefined;
            const email = typeof actor?.email === 'string' ? actor.email.toLowerCase() : '';
            return email.length <= 254 && /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+$/.test(email)
                ? email
                : 'skills-service';
        } catch {
            return 'skills-service';
        }
    }

    private author(req: Request): string {
        const header = req.headers['x-bridge-user-id'];

        return typeof header === 'string' && header.length > 0 ? header : 'dev';
    }
}
