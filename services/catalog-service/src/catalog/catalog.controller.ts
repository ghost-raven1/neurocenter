import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, GoneException, NotFoundException, Param, Patch, Post, Query, Req } from '@nestjs/common';


import {
    IAccessDecisionList,
    IAccessUsersList,
    IBackupStatus,
    IPage,
    IAiPluginCreate,
    IAiPluginUpdate,
    IProjectDetail,
    IProjectAsset,
    IProjectProfile,
    IQuota,
    ISkill,
    ISkillCollection,
    ISkillDetail,
    IStorageSummary,
    IPackage,
    IPackageDetail,
    IProjectSummary,
    IAuditEvent,
    IImageVersion,
    IProjectMember,
    IProjectMemberAdd,
    ISnapshotManifest,
} from './dto';
import { resolveFsRootPath, ILocalAssetInstall, ILocalAssetInstallResult } from './local-assets';
import { IBackupRunResult } from './backup';
import {
    MANIFEST,
    PACKAGE_COLLECTIONS,
    PACKAGE_DETAILS,
    PACKAGES,
    PROFILES,
    SKILLS,
    SKILL_COLLECTIONS,
    SKILL_DETAILS,
    VERSIONS,
    toPage,
} from './data';
import { CatalogService } from './catalog.service';
import {pagination} from './pagination';
import {validateProjectRetention,validateProjectSettings} from './project-validation';
import { AccessDb } from '../access/access-db';
import { canReadCommon, IAccessActor, normalizeEmail, projectLevel } from '../access/access.model';
import { MEMBER_ROLE_OPTIONS, T_DEFAULT_MEMBER_ROLE, roleCan } from './rbac';
import type { IOperationReadScope } from '../operations/operation.types';

/**
 * Ключи-маршруты каталога проектов/версий/скиллов/пакетов/операций/аудит/maintenance.
 * Projects — PG-backed (БД `catalog`); остальное — mock-данные (dev).
 */
/** Минимальная форма HTTP-запроса (заголовки, инжектированные gateway). */
interface IHttpRequest {
    headers: Record<string, unknown>;
}

@Controller('api')
export class CatalogController {
    constructor(private readonly catalog: CatalogService, private readonly access: AccessDb) {
    }
    /**
     * Список проектов.
     *
     * @param {Record<string, string>} query - page/size/query
     * @returns {IPage<IProjectSummary>}
     */
    @Get('projects')
    public async listProjects(@Query() query: Record<string, string>, @Req() req: IHttpRequest): Promise<IPage<IProjectSummary>> {
        const {page,size}=pagination(query);

        const claims = await this.access.claims(this.actor(req).email);
        return this.catalog.listProjects(page, size, query.q ?? query.query ?? '', this.isMain(req) ? undefined : claims.projects.map(item=>item.projectId));
    }

    /**
     * Детальная карточка проекта (по id ИЛИ имени).
     *
     * @param {string} id - id или имя проекта
     * @returns {Promise<IProjectDetail>}
     */
    @Get('projects/:id')
    public getProject(@Param('id') id: string): Promise<IProjectDetail> {
        return this.catalog.getProject(id);
    }

    /**
     * Создание проекта (PG).
     *
     * @param {object} body - { name, externalResourceId?, retention?, quotas? }
     * @returns {Promise<IProjectDetail>}
     */
    /**
     * Создать проекты для всех локальных каталогов (~/projects/*), которых нет в каталоге.
     *
     * @returns {Promise<unknown>}
     */
    @Post('projects/import-local')
    public importLocalProjects(@Body() body: { names?: string[] }) {
        return this.catalog.importLocalProjects(body?.names);
    }

    @Post('projects')
    public createProject(@Body() body: { name?: string; externalResourceId?: string; retention?: number; quotas?: unknown; fsRootPath?: string }): Promise<IProjectDetail> {
        return this.catalog.createProject({ ...body, fsRootPath: this.assertFsRootPath(body?.fsRootPath) });
    }

    /**
     * Обновление проекта (state/retention/quota, PG).
     *
     * @param {string} id - id или имя проекта
     * @param {object} body - { state?, retention?, quotas? }
     * @returns {Promise<IProjectDetail>}
     */
    @Patch('projects/:id')
    public async updateProject(@Param('id') id: string, @Body() body: { state?: string; retention?: number; quotas?: unknown; fsRootPath?: string }, @Req() req: IHttpRequest): Promise<IProjectDetail> {
        validateProjectSettings(body);
        const normalized = { ...body, fsRootPath: this.assertFsRootPath(body.fsRootPath) };
        const actor = await this.projectSettingsActor(id, req);
        return this.catalog.updateProject(id, normalized, actor);
    }

    /**
     * Удаление проекта (PG-backed).
     *
     * @param {string} id - id или имя проекта
     * @returns {Promise<{ ok: true; id: string }>}
     */
    @Delete('projects/:id')
    public async deleteProject(@Param('id') id: string, @Req() req: IHttpRequest): Promise<{ ok: true; id: string }> {
        const members = await this.catalog.listProjectMembers(id);
        const principal = this.bridgePrincipal(req);
        const myRole = this.isMain(req) ? 'Главный админ' : (members.find(m => m.principalName.toLowerCase() === principal?.toLowerCase())?.role ?? 'Наблюдатель');
        if (!roleCan(myRole, 'delete')) {
            throw new ForbiddenException('Недостаточно прав: требуется роль «Админ проекта»');
        }
        return this.catalog.deleteProject(id, principal ?? undefined);
    }

    /**
     * Квоты проекта (PATCH).
     *
     * @param {string} id - id проекта
     * @param {IQuota} body - новые квоты
     * @returns {IQuota}
     */
    @Patch('projects/:id/quotas')
    public async updateQuotas(@Param('id') id: string, @Body() body: IQuota, @Req() req: IHttpRequest): Promise<IQuota> {
        validateProjectSettings({quotas: body});
        return this.catalog.updateQuotas(id, body, await this.projectSettingsActor(id, req));
    }

    /**
     * Ретеншн проекта (PATCH).
     *
     * @param {string} id - id проекта
     * @param {{ retention: number }} body - новое значение
     * @returns {{ retention: number }}
     */
    @Patch('projects/:id/retention')
    public async updateRetention(@Param('id') id: string, @Body() body: unknown, @Req() req: IHttpRequest): Promise<{ retention: number }> {
        const retention = validateProjectRetention(body);
        const saved = await this.catalog.updateProject(id, { retention }, await this.projectSettingsActor(id, req));
        return { retention: saved.retention };
    }

    /** Свежие назначения и активная роль определяют права одинаково для ID и имени проекта. */
    private async projectSettingsActor(id: string, req: IHttpRequest): Promise<string> {
        const actor = this.actor(req);
        const claims = await this.access.claims(actor.email);
        if (projectLevel(claims, actor.activeRole, id) < 3) {
            throw new ForbiddenException('Недостаточно прав: требуется активная роль «Админ проекта».');
        }
        return claims.email;
    }

    /**
     * Список сотрудников проекта.
     *
     * @param {string} id - id проекта
     * @returns {IProjectMember[]}
     */
    @Get('projects/:id/members')
    public listProjectMembers(@Param('id') id: string): Promise<IProjectMember[]> {
        return this.catalog.listProjectMembers(id);
    }

    /**
     * Добавить сотрудника в проект.
     *
     * @param {string} id - id проекта
     * @param {IProjectMemberAdd} body - { principalName, displayName?, role? }
     * @returns {IProjectMember}
     */
    @Post('projects/:id/members')
    public async addProjectMember(@Param('id') id: string, @Body() body: IProjectMemberAdd, @Req() req: IHttpRequest): Promise<IProjectMember> {
        if (!body?.principalName || !body.principalName.trim()) {
            throw new ConflictException('Укажите логин сотрудника');
        }
        const principal = this.bridgePrincipal(req);
        const membersForRole = await this.catalog.listProjectMembers(id);
        const myRole = this.isMain(req) ? 'Главный админ' : (membersForRole.find(m => m.principalName.toLowerCase() === principal?.toLowerCase())?.role ?? 'Наблюдатель');
        if (!roleCan(myRole, 'member')) {
            throw new ForbiddenException('Недостаточно прав: требуется роль «Админ проекта»');
        }
        let principalName: string;
        try { principalName=normalizeEmail(body.principalName); } catch { throw new BadRequestException('Укажите корректную электронную почту сотрудника.'); }
        this.assertMemberRole(body.role ?? T_DEFAULT_MEMBER_ROLE, myRole);
        const list = await this.catalog.listProjectMembers(id);
        if (list.some(m => m.principalName.toLowerCase() === principalName.toLowerCase())) {
            throw new ConflictException(`Сотрудник ${principalName} уже в проекте`);
        }
        const member: IProjectMember = {
            userId: `u-${principalName}`,
            principalName,
            displayName: (body.displayName || principalName).trim(),
            role: body.role || T_DEFAULT_MEMBER_ROLE,
            addedAt: new Date().toISOString(),
        };
        const actor = this.actor(req).email;
        await this.access.save({email:principalName,displayName:body.displayName}, actor);
        return this.catalog.addProjectMember(id, member, actor);
    }

    /**
     * Изменить роль сотрудника в проекте.
     *
     * @param {string} id - id проекта
     * @param {string} userId - id сотрудника
     * @param {{ role: string }} body - новая роль
     * @returns {IProjectMember}
     */
    @Patch('projects/:id/members/:userId')
    public async updateProjectMember(@Param('id') id: string, @Param('userId') userId: string, @Body() body: { role?: string; expectedRole?: string }, @Req() req: IHttpRequest): Promise<IProjectMember> {
        const members = await this.catalog.listProjectMembers(id);
        const principal = this.bridgePrincipal(req);
        const myRole = this.isMain(req) ? 'Главный админ' : (members.find(m => m.principalName.toLowerCase() === principal?.toLowerCase())?.role ?? 'Наблюдатель');
        if (!roleCan(myRole, 'member')) { throw new ForbiddenException('Недостаточно прав: требуется роль «Админ проекта»'); }
        this.assertMemberRole(body?.role, myRole);
        const target = members.find(m => m.userId === userId);
        if (!target) {
            throw new NotFoundException(`Сотрудник ${userId} не найден в проекте`);
        }
        if (body.expectedRole!==undefined && target.role!==body.expectedRole) { throw new ConflictException('Роль сотрудника уже изменена. Обновите назначения перед сохранением.'); }
        if (target.role==='Админ проекта' && !this.isMain(req)) { throw new ForbiddenException('Роль администратора проекта меняет Главный админ.'); }
        const member = await this.catalog.updateProjectMemberRole(id, userId, body?.role as string, target.role, this.actor(req).email);

        if (!member) {
            throw new ConflictException('Назначение изменено или удалено другим администратором. Обновите список.');
        }

        return member;
    }

    /**
     * Удалить сотрудника из проекта.
     *
     * @param {string} id - id проекта
     * @param {string} userId - id сотрудника
     * @returns {{ ok: true; userId: string }}
     */
    @Delete('projects/:id/members/:userId')
    public async removeProjectMember(@Param('id') id: string, @Param('userId') userId: string, @Req() req: IHttpRequest, @Query('expectedRole') expectedRole?: string): Promise<{ ok: true; userId: string }> {
        const members = await this.catalog.listProjectMembers(id);
        const principal = this.bridgePrincipal(req);
        const myRole = this.isMain(req) ? 'Главный админ' : (members.find(m => m.principalName.toLowerCase() === principal?.toLowerCase())?.role ?? 'Наблюдатель');
        if (!roleCan(myRole, 'member')) {
            throw new ForbiddenException('Недостаточно прав: требуется роль «Админ проекта»');
        }
        const target = members.find(m => m.userId === userId);
        if (!target) {
            throw new NotFoundException(`Сотрудник ${userId} не найден в проекте`);
        }
        if (expectedRole!==undefined && target.role!==expectedRole) { throw new ConflictException('Роль сотрудника уже изменена. Обновите назначения перед удалением.'); }
        if (target.role === 'Админ проекта' && !this.isMain(req)) {
            throw new ForbiddenException('Администратора проекта удаляет Главный админ.');
        }
        const removed = await this.catalog.removeProjectMember(id, userId, target.role, this.actor(req).email);

        if (!removed) {
            throw new ConflictException('Назначение изменено или удалено другим администратором. Обновите список.');
        }

        return { ok: true, userId };
    }

    /**
     * Проектный каталог: активы (глоб. бандлы/скиллы), добавленные сюда админом.
     *
     * @param {string} id - id проекта.
     * @returns {Promise<IProjectAsset[]>}
     */
    @Get('projects/:id/assets')
    public async listProjectAssets(@Param('id') id: string): Promise<IProjectAsset[]> {
        const project = await this.catalog.getProject(id);
        return this.catalog.listProjectAssets(project.id);
    }

    /**
     * Добавить глобальную ассету в проект. Только админ проекта (level ≥ 3).
     */
    @Post('projects/:id/assets')
    public async addProjectAsset(@Param('id') id: string, @Body() body: { assetId?: string; assetKind?: string }, @Req() req: IHttpRequest): Promise<{ ok: boolean }> {
        if ((projectLevel(await this.access.claims(this.actor(req).email), this.actor(req).activeRole, id)) < 3) {
            throw new ForbiddenException('В проектном каталоге может менять только админ проекта');
        }
        if (!body || !body.assetId || !body.assetKind) {
            throw new BadRequestException('assetId и assetKind обязательны');
        }
        const project = await this.catalog.getProject(id);
        await this.catalog.addProjectAsset(project.id, body.assetId, body.assetKind as IProjectAsset['assetKind'], this.actor(req).email);
        return { ok: true };
    }

    /**
     * Удалить актив из проектного каталога. Только админ проекта (level ≥ 3).
     */
    @Delete('projects/:id/assets')
    public async removeProjectAsset(@Param('id') id: string, @Body() body: { assetId?: string; assetKind?: string }, @Req() req: IHttpRequest): Promise<{ ok: boolean }> {
        if ((projectLevel(await this.access.claims(this.actor(req).email), this.actor(req).activeRole, id)) < 3) {
            throw new ForbiddenException('Удаление из проектного каталога — только для админа проекта');
        }
        if (!body || !body.assetId || !body.assetKind) {
            throw new BadRequestException('assetId и assetKind обязательны');
        }
        const project = await this.catalog.getProject(id);
        return { ok: await this.catalog.removeProjectAsset(project.id, body.assetId, body.assetKind, this.actor(req).email) };
    }

    /**
     * Уровень роли principal в проекте (межсервисная RBAC-проверка, напр. rag-sync).
     * 4 — Главный админ, 3 — Админ проекта, 2 — Разработчик, 1 — Наблюдатель, 0 — нет.
     */
    @Get('projects/:idOrName/role-level')
    public async getProjectRoleLevel(@Param('idOrName') idOrName: string, @Req() req: IHttpRequest): Promise<{ level: number }> {
        const actor=this.actor(req);
        const level = projectLevel(await this.access.claims(actor.email),actor.activeRole,idOrName);
        return { level };
    }

    /**
     * Пользователи → их доступы к проектам (включая текущего, даже без доступов).
     *
     * @param {IHttpRequest} req - для текущего principal (x-bridge-principal).
     * @returns {Promise<IAccessUsersList>}
     */
    @Get('access/users')
    public async listAccessUsers(@Req() req: IHttpRequest): Promise<IAccessUsersList> {
        const principal = this.bridgePrincipal(req);
        const users = await this.catalog.listAccessUsers(principal);
        return { users };
    }

    /**
     * Текущий Jira-логин из заголовков, инжектированных gateway.
     *
     * @param {IHttpRequest} req - входящий
     * @returns {string | null}
     */
    private bridgePrincipal(req: IHttpRequest): string | null {
        const headers = req.headers;
        const principal = headers['x-bridge-principal'];
        const userId = headers['x-bridge-user-id'];
        const value = (Array.isArray(principal) ? principal[0] : principal) ?? (Array.isArray(userId) ? userId[0] : userId);
        return typeof value === 'string' && value.length > 0 ? value : null;
    }

    /**
     * Запрет записи в глобальный каталог бандлов для не-«Главных админов» (403).
     *
     * Политика: в глобальный каталог `ai-plugins` (create/update/activate/import/delete)
     * пишет только «Главный админ» из `ADMIN_USERS`; остальные роли — только чтение.
     *
     * @param {IHttpRequest} req - запрос (заголовок `x-bridge-principal`).
     */
    private assertMainAdmin(req: IHttpRequest): void {
        if (!this.isMain(req)) { throw new ForbiddenException('Нужна активная роль «Главный админ».'); }
    }

    /** Получает идентичность только из заголовка, установленного gateway. */
    private actor(req: IHttpRequest): IAccessActor {
        return JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] || '{}'))) as IAccessActor;
    }
    private isMain(req: IHttpRequest): boolean { return this.actor(req).activeRole === 'Главный админ'; }

    /** Проверяет свежую роль; личный actor не даёт доступ к журналу отозванного проекта. */
    private async operationReadScope(req: IHttpRequest): Promise<IOperationReadScope | undefined> {
        const actor = this.actor(req);
        const claims = await this.access.claims(actor.email);
        if (!claims.userRoles.includes(actor.activeRole)) { throw new ForbiddenException('Назначение активной роли отозвано.'); }
        if (actor.activeRole === 'Главный админ') { return undefined; }
        const projects = claims.projects.filter(item => projectLevel(claims, actor.activeRole, item.projectId) > 0);
        return { actor: claims.email, projectIds: projects.flatMap(item => [item.projectId, ...(!item.projectName.startsWith('prj-') ? [item.projectName] : [])]) };
    }

    /**
     * Валидация `fsRootPath` (400 при выходе за пределы ~/projects).
     *
     * @param {string | undefined} value - путь из тела запроса
     * @returns {string | undefined} нормализованный путь или undefined (не задан)
     */
    private assertFsRootPath(value: string | undefined): string | undefined {
        if(value!==undefined&&typeof value!=='string'){throw new BadRequestException('Путь проекта должен быть строкой.');}
        if (value === undefined || value.trim().length === 0) {
            return undefined;
        }
        try {
            return resolveFsRootPath(value);
        } catch {
            throw new BadRequestException('fsRootPath должен быть абсолютным путём под ~/projects');
        }
    }

    /**
     * Валидация назначения роли участника: допустимые роли — MEMBER_ROLE_OPTIONS;
     * роль «Админ проекта» может назначить только «Главный админ» (isMainAdmin).
     *
     * @param {string | undefined} role - роль из тела запроса.
     * @param {string} actorRole - эффективная роль исполнителя.
     * @returns {void}
     */
    private assertMemberRole(role: string | undefined, actorRole: string): void {
        if (!role) {
            throw new BadRequestException('Укажите роль');
        }
        if (!(MEMBER_ROLE_OPTIONS as string[]).includes(role)) {
            throw new BadRequestException(`Роль должна быть одной из: ${MEMBER_ROLE_OPTIONS.join(', ')}`);
        }
        if (role === 'Админ проекта' && !roleCan(actorRole, 'assign_admin')) {
            throw new ForbiddenException('Роль «Админ проекта» может назначить только Главный админ');
        }
    }

    /**
     * Версии (snapshots) проекта.
     *
     * @param {string} id - id проекта
     * @returns {IImageVersion[]}
     */
    @Get('projects/:id/versions')
    public listVersions(@Param('id') id: string): IImageVersion[] {
        return VERSIONS[id] ?? [];
    }

    /**
     * Манифест снимка.
     *
     * @param {string} id - id проекта
     * @param {string} sid - snapshotId
     * @returns {ISnapshotManifest}
     */
    @Get('projects/:id/versions/:sid/manifest')
    public getManifest(@Param('id') id: string, @Param('sid') sid: string): ISnapshotManifest {
        void id;

        return { ...MANIFEST, snapshotId: sid };
    }

    /**
     * Профили проекта.
     *
     * @param {string} id - id проекта
     * @returns {IProjectProfile[]}
     */
    @Get('projects/:id/profiles')
    public listProfiles(@Param('id') id: string): IProjectProfile[] {
        return PROFILES[id] ?? [];
    }

    /**
     * Коллекции скиллов.
     *
     * @returns {ISkillCollection[]}
     */
    @Get('skills/collections')
    public listSkillCollections(): ISkillCollection[] {
        return SKILL_COLLECTIONS;
    }

    /**
     * Список скиллов.
     *
     * @returns {ISkill[]}
     */
    @Get('skills')
    public listSkills(): ISkill[] {
        return SKILLS;
    }

    /**
     * Подробности скилла (с версиями).
     *
     * @param {string} skillId - id скилла
     * @returns {ISkillDetail}
     */
    @Get('skills/:skillId')
    public getSkill(@Param('skillId') skillId: string): ISkillDetail {
        return SKILL_DETAILS[skillId] ?? { skill: SKILLS[0], versions: [] };
    }

    /**
     * Публикация версии скилла.
     *
     * @returns {{ versionId: string }}
     */
    @Post('skills/publish')
    public publishSkill(@Req() req: IHttpRequest): { versionId: string } {
        this.assertMainAdmin(req);
        return { versionId: 'skv-new' };
    }

    /**
     * Перевод head коллекции скиллов.
     *
     * @param {string} collectionId - id коллекции
     * @returns {{ headVersionId: string }}
     */
    @Post('skills/collections/:collectionId/head')
    public moveSkillCollectionHead(@Param('collectionId') collectionId: string): { headVersionId: string } {
        void collectionId;

        return { headVersionId: 'skv-head' };
    }

    /**
     * Ссылка на скачивание скилла.
     *
     * @param {string} skillId - id скилла
     * @returns {{ downloadUrl: string, expiresAt: string }}
     */
    @Get('skills/:skillId/download')
    public downloadSkill(@Param('skillId') skillId: string): { downloadUrl: string; expiresAt: string } {
        return {
            downloadUrl: `https://storage.internal/skills/${skillId}/current.tar.gz?token=mock`,
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
        };
    }

    /**
     * Список операций.
     *
     * @param {Record<string, string>} query - page/size
     * @returns {IPage<IOperation>}
     */
    @Get('operations')
    public async listOperations(@Query() query: Record<string, string>, @Req() req: IHttpRequest) {
        // Фронт (OperationListParams) шлёт `projectId`; `project` — legacy.
        const project = query.projectId ?? query.project;
        const {page,size}=pagination(query);
        return this.catalog.listOperations(page,size, project, query.state, await this.operationReadScope(req));
    }

    /**
     * Подробности операции (реальные, PG).
     *
     * @param {string} operationId - id операции
     * @returns {Promise<unknown>}
     */
    @Get('operations/:operationId')
    public async getOperation(@Param('operationId') operationId: string, @Req() req: IHttpRequest) {
        return this.catalog.getOperation(operationId, await this.operationReadScope(req));
    }

    /**
     * Повтор операции (реальный, PG: → RUNNING, retries+1).
     *
     * @param {string} operationId - id операции
     * @returns {Promise<unknown>}
     */
    @Post('operations/:operationId/retry')
    public retryOperation(@Param('operationId') operationId: string) {
        return this.catalog.retryOperation(operationId);
    }

    /**
     * Отмена операции (реальный, PG: → CANCELLED).
     *
     * @param {string} operationId - id операции
     * @returns {Promise<unknown>}
     */
    @Post('operations/:operationId/cancel')
    public cancelOperation(@Param('operationId') operationId: string) {
        return this.catalog.cancelOperation(operationId);
    }

    /**
     * Список событий аудита.
     *
     * @param {Record<string, string>} query - page/size
     * @returns {IPage<IAuditEvent>}
     */
    @Get('audit')
    public listAudit(@Query() query: Record<string, string>): Promise<IPage<IAuditEvent>> {
        const {page,size}=pagination(query);
        return this.catalog.listAudit(page,size);
    }

    /**
     * Сводка по хранилищу.
     *
     * @returns {IStorageSummary}
     */
    @Get('maintenance/storage')
    public getStorage(): Promise<IStorageSummary> {
        return this.catalog.getStorage();
    }

    /**
     * Статус бэкапа.
     *
     * @returns {IBackupStatus}
     */
    @Get('maintenance/backup')
    public getBackup(): Promise<IBackupStatus> {
        return this.catalog.getBackup();
    }

    @Post('maintenance/backup')
    public backupNow(): Promise<IBackupRunResult> {
        return this.catalog.executeBackup();
    }

    /**
     * Восстановление из checkpoint.
     *
     * @param {{ checkpointId: string }} body
     * @returns {{ operationId: string }}
     */
    @Post('maintenance/restore')
    public restore(@Body() body: { checkpointId: string }): Promise<{ operationId: string }> {
        void body;

        return this.catalog.restore();
    }

    /**
     * Список MCP/плагинов (реальные, PG; универсальная сущность, без демон-seed).
     *
     * @param page - страница.
     * @param size - размер страницы.
     * @param q - фильтр по имени.
     * @returns {Promise<unknown>}
     */
    @Get('ai-plugins')
    public async listAiPlugins(@Req() req: IHttpRequest, @Query('page') page?: string, @Query('size') size?: string, @Query('q') q?: string) {
        const actor=this.actor(req); const claims=await this.access.claims(actor.email);
        const paging=pagination({page,size},100);
        return this.catalog.listAiPlugins(paging.page,paging.size, q ?? '', canReadCommon(claims,actor.activeRole) ? undefined : claims.pluginIds);
    }

    /**
     * Карточка MCP/плагина.
     *
     * @param id - id.
     * @returns {Promise<unknown>}
     */
    @Get('ai-plugins/:id')
    public getAiPlugin(@Param('id') id: string) {
        return this.catalog.getAiPlugin(id);
    }

    /**
     * Список версий бандла MCP/плагина (по убыванию).
     *
     * @param id - id.
     * @returns {Promise<unknown>}
     */
    @Get('ai-plugins/:id/versions')
    public listAiPluginVersions(@Param('id') id: string) {
        return this.catalog.listAiPluginVersions(id);
    }

    /**
     * Файл бандла (текст) по пути: `?path=...&version=N` (version — опционально).
     *
     * @param id - id.
     * @param filePath - путь файла в бандле.
     * @param version - опциональный номер версии.
     * @returns {Promise<unknown>}
     */
    @Get('ai-plugins/:id/files')
    public getAiPluginFile(@Param('id') id: string, @Query('path') filePath: string, @Query('version') version?: string) {
        return this.catalog.getAiPluginFile(id, filePath, version === undefined ? undefined : Number(version));
    }

    /**
     * Активировать (откатыть к) версию бандла в head.
     *
     * @param id - id.
     * @param v - номер версии.
     * @returns {Promise<unknown>}
     */
    @Post('ai-plugins/:id/versions/:v/activate')
    public activateAiPluginVersion(@Param('id') id: string, @Param('v') v: string, @Req() req: IHttpRequest) {
        this.assertMainAdmin(req);
        return this.catalog.activateAiPluginVersion(id, Number(v), this.actor(req).email);
    }

    /**
     * Self-verified delivery-пакет бандла: per-file sha256 + manifest.sha256 (version — опц., иначе head).
     *
     * @param id - id.
     * @param version - опц., версия (?version=N).
     * @returns {Promise<unknown>}
     */
    @Get('ai-plugins/:id/package')
    public getAiPluginPackage(@Param('id') id: string, @Query('version') version?: string) {
        return this.catalog.getAiPluginPackage(id, version === undefined ? undefined : Number(version));
    }

    /**
     * Создать MCP/плагин.
     *
     * @param body — payload создания.
     * @returns {Promise<unknown>}
     */
    /**
     * Импорт локальных MCP/плагинов проекта в каталог (opencode.json + .opencode/plugins).
     *
     * @param body — `{ projectName }` имя локального проекта.
     * @returns {Promise<unknown>}
     */
    @Post('ai-plugins/import-local')
    public importLocalAiPlugins(@Body() body: { projectName?: string }, @Req() req: IHttpRequest) {
        this.assertMainAdmin(req);
        if (!body || !body.projectName) {
            throw new BadRequestException('projectName is required');
        }
        return this.catalog.importLocalAiPlugins(body.projectName);
    }

    @Post('ai-plugins')
    public createAiPlugin(@Body() body: IAiPluginCreate, @Req() req: IHttpRequest) {
        this.assertMainAdmin(req);
        return this.catalog.createAiPlugin(body, this.actor(req).email);
    }

    /**
     * Обновить MCP/плагин.
     *
     * @param id - id.
     * @param body — payload обновления.
     * @returns {Promise<unknown>}
     */
    @Patch('ai-plugins/:id')
    public updateAiPlugin(@Param('id') id: string, @Body() body: IAiPluginUpdate, @Req() req: IHttpRequest) {
        this.assertMainAdmin(req);
        if (!body || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
            throw new BadRequestException('Обновите карточку и передайте её expectedVersion.');
        }
        return this.catalog.updateAiPlugin(id, body, this.actor(req).email);
    }

    /**
     * Удалить MCP/плагин.
     *
     * @param id - id.
     * @returns {Promise<unknown>}
     */
    @Delete('ai-plugins/:id')
    public deleteAiPlugin(@Param('id') id: string, @Req() req: IHttpRequest) {
        this.assertMainAdmin(req);
        return this.catalog.deleteAiPlugin(id, this.actor(req).email);
    }

    /**
     * Скан локальных проектов (~/projects): что где установлено.
     *
     * @param root - базовый каталог (опционально).
     * @param q - фильтр по названию проекта.
     * @param maxProjects - максимум проектов.
     * @returns {Promise<unknown>}
     */
    @Get('local-assets/scan')
    public async scanLocalAssets(): Promise<never> {
        // Конфигурации серверных папок могут содержать секреты и не принадлежат браузерному пользователю.
        throw new GoneException('Серверный скан отключён. Подключите локальный MCP и выберите папку на своём компьютере.');
    }

    /**
     * Установить/удалить актив в локальный проект (~/.projects/<projectName>).
     *
     * @param body — параметры установки/удаления.
     * @returns {Promise<unknown>}
     */
    @Post('local-assets/install')
    public async installLocalAsset(@Body() body: ILocalAssetInstall, @Req() req: IHttpRequest): Promise<ILocalAssetInstallResult> {
        const principal = this.bridgePrincipal(req);
        if (!this.isMain(req)) {
            if (!body.projectName) {
                throw new BadRequestException('projectName is required');
            }
            const level = projectLevel(await this.access.claims(this.actor(req).email), this.actor(req).activeRole, body.projectName);
            if (level < 2) {
                throw new ForbiddenException('Установка активов доступна для роли «Разработчик» и выше');
            }
            if (!body.name || !(await this.catalog.isAssetInProject(body.projectName, body.kind, body.name))) {
                throw new ForbiddenException(`Актив «${body.name}» отсутствует в проектном каталоге «${body.projectName}»`);
            }
        }
        void principal;
        throw new ConflictException('Установка в пользовательскую папку выполняется локальным мостом. Серверная запись файлов отключена; файлы не изменены.');
    }

    /**
     * Коллекции пакетов.
     *
     * @returns {{ id: string, title: string }[]}
     */
    @Get('packages/collections')
    public listPackageCollections(): { id: string; title: string }[] {
        return PACKAGE_COLLECTIONS;
    }

    /**
     * Список пакетов.
     *
     * @param {Record<string, string>} query - page/size
     * @returns {IPage<IPackage>}
     */
    @Get('packages')
    public listPackages(@Query() query: Record<string, string>): IPage<IPackage> {
        return toPage(PACKAGES, Number(query.page) || 1, Number(query.size) || 20);
    }

    /**
     * Подробности пакета.
     *
     * @param {string} id - id пакета
     * @returns {IPackageDetail}
     */
    @Get('packages/:id')
    public getPackage(@Param('id') id: string): IPackageDetail {
        return PACKAGE_DETAILS[id] ?? PACKAGE_DETAILS['pk-1'];
    }

    /**
     * Текущие решения ролевой модели Нейроцентра.
     *
     * @returns {IAccessDecisionList}
     */
    @Get('me/decisions')
    public async getDecisions(@Req() req: IHttpRequest): Promise<IAccessDecisionList> {
        const actor=this.actor(req); const claims=await this.access.claims(actor.email);
        const decisions=claims.projects.map(grant=>{
            const level=projectLevel(claims,actor.activeRole,grant.projectId);
            return {scope:'project',scopeId:grant.projectId,actions:level>=3 ? ['project.read','project.manage','package.install'] : level>=2 ? ['project.read','package.install'] : ['project.read'],decisionId:`role:${grant.projectId}:${actor.activeRole}`,policyRevision:1,ttlSeconds:0};
        });
        if (this.isMain(req)) { decisions.unshift({scope:'platform',scopeId:'all',actions:['platform.admin'],decisionId:'role:platform:main',policyRevision:1,ttlSeconds:0}); }
        return {decisions,externalServiceUrl:null};
    }
}
