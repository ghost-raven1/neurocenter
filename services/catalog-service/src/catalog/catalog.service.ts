import {
    BadRequestException,
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
    NotFoundException,
} from '@nestjs/common';

import { CatalogDb } from './catalog-db';
import {
    IAccessDecisionList,
    IAiPlugin,
    IAiPluginCreate,
    IAiPluginFile,
    IAiPluginUpdate,
    IAiPluginVersion,
    IAccessUserRow,
    IAuditEvent,
    IBackupStatus,
    ILocalProjectsImportResult,
    IOperationDetail,
    IOperationPage,
    IPage,
    IProjectDetail,
    IProjectMember,
    IProjectAsset,
    IProjectSummary,
    IQuota,
    IStorageSummary,
} from './dto';
import { measureProjectDataSize } from './fs-metrics';
import { fetchProjectRetainedSize } from './project-retained-size';
import { validateProjectSettings } from './project-validation';
import { buildPackage, type IPackage } from './bundle-package';
import { runAllBackups, stopBackups, IBackupRunResult } from './backup';
import { backupPolicy } from '../backups/backup-policy';
import { scanLocalAssets } from './local-assets';
import { isMainAdmin, roleLevel } from './rbac';
import { assertProjectCatalogAsset } from '../devices/project-skill';
import { normalizeDependencyPins } from '../../../shared/dependency-pins.cjs';
import type { IOperationReadScope } from '../operations/operation.types';
import type { IAccessActor } from '../access/access.model';

/**
 * Сервис каталога: PG-backed проекты (реальные) + идемпотентная схема при старте.
 */
@Injectable()
export class CatalogService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger('CatalogService');
    private readonly db: CatalogDb;

    /**
     * Инициализация: строит CatalogDb из env.
     */
    private readonly ragBaseUrl: string = process.env.RAG_SERVICE_URL?.trim() ?? '';

    constructor() {
        backupPolicy();
        this.db = new CatalogDb(process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog');
    }

    public ready(): Promise<void> {
        return this.db.ready();
    }
    /** Зависимые очереди ждут ту же идемпотентную инициализацию, что lifecycle каталога. */
    public ensureSchema(): Promise<void> {
        return this.db.setup();
    }

    /** Резервирование ссылок подтверждается до любой файловой публикации скилла. */
    public reserveSkillDependencies(raw: unknown): Promise<{ reserved: number }> {
        return this.db.reserveSkillDependencies(raw);
    }

    /** Подтверждение означает, что квитанция и безопасная сводка аудита уже зафиксированы в PostgreSQL. */
    public recordSkillAuditEvents(raw: unknown): Promise<{ accepted: number }> {
        return this.db.recordSkillAuditEvents(raw);
    }

    /**
     * По запуску: идемпотентная инициализация схемы (table + seed).
     *
     * @returns {Promise<void>}
     */
    async onModuleInit(): Promise<void> {
        try {
            await this.db.setup();
            this.logger.log('калалог projects схема готова');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.error(`не удалось инициализировать postgres (catalog): ${msg}`);
            throw e;
        }
    }

    /**
     * По завершении: закрываем пул.
     *
     * @returns {Promise<void>}
     */
    async onModuleDestroy(): Promise<void> {
        await stopBackups();
        await this.db.close();
    }

    /**
     * Список проектов.
     *
     * @param page - страница.
     * @param size - размер страницы.
     * @param q - фильт по имени.
     * @returns {Promise<IPage<IProjectSummary>>}
     */
    /**
     * Живые размеры для краткой карточки проекта:
     * логический — данные панели проекта (`.opencode`), резервная копия — develop-индекс в PG.
     *
     * @param {IProjectSummary} item - краткая карточка (мутабельно).
     * @returns {Promise<IProjectSummary>}
     */
    private async applyLiveSizes(item: IProjectSummary): Promise<void> {
        const [usedBytes, retainedBytes] = await Promise.all([
            measureProjectDataSize(item.fsRootPath),
            fetchProjectRetainedSize(this.ragBaseUrl, item.id, process.env.NEUROCENTER_INTERNAL_TOKEN || ''),
        ]);
        item.logicalBytes = usedBytes;
        item.retainedBytes = retainedBytes.bytes;
        if (usedBytes === null) {
            item.logicalSizeError = item.fsRootPath?.trim()
                ? 'Не удалось измерить данные проекта: каталог недоступен или превышен лимит обхода.'
                : 'Папка проекта не настроена на сервере.';
        } else delete item.logicalSizeError;
        if (retainedBytes.error) item.retainedSizeError = retainedBytes.error;
        else delete item.retainedSizeError;
    }

    /**
     * Список проектов (с живыми размерами).
     *
     * @param page - страница.
     * @param size - размер страницы.
     * @param q - фильт по имени.
     * @returns {Promise<IPage<IProjectSummary>>}
     */
    async listProjects(page: number, size: number, q: string, allowedIds?: string[]): Promise<IPage<IProjectSummary>> {
        const result = await this.db.listProjects(page, size, q, allowedIds);
        await Promise.all(result.items.map((item) => this.applyLiveSizes(item)));
        return result;
    }

    /**
     * Создать в каталоге проекты для локальных каталогов (~/projects/*), которых ещё нет.
     * Если задан список имён — только для них. Идемпотентно.
     *
     * @param {string[] | undefined} names - выбранные имена локальных проектов.
     * @returns {Promise<ILocalProjectsImportResult>} итоги.
     */
    async importLocalProjects(names?: string[]): Promise<ILocalProjectsImportResult> {
        const scan = await scanLocalAssets(undefined, undefined);
        const only = names === undefined ? null : new Set(names);
        let created: number = 0;
        let existing: number = 0;
        const createdNames: string[] = [];
        const total: number = scan.projects.filter((entry) => only === null || only.has(entry.project)).length;

        for (const entry of scan.projects) {
            if (only !== null && !only.has(entry.project)) {
                continue;
            }
            const found = await this.db.getProject(entry.project);
            if (found) {
                existing += 1;
                continue;
            }
            await this.db.createProject({
                name: entry.project,
                externalResourceId: `local:${entry.project}`,
                retention: 30,
                fsRootPath: entry.path,
            });
            created += 1;
            createdNames.push(entry.project);
        }

        this.logger.log(`импорт локальных проектов: +${created} уже ${existing} из ${total}`);

        return { created, existing, total, createdNames };
    }

    /**
     * Карточка проекта (404 при отсутствии).
     * Живые показатели на каждый запрос:
     *  - логический размер / «текущие данные» (использовано) — данные панели
     *    проекта (`.opencode`: rag-индекс, скиллы, плагины, MCP-конфиг, по fs_root_path);
     *  - «резервная копия» (использовано) — оценка размера develop-индекса в PG.
     *
     * @param {string} idOrName - id или имя проекта.
     * @returns {Promise<IProjectDetail>}
     */
    /** Internal identity reads may use stored sizes; the public detail endpoint requests live measurements by default. */
    async getProject(idOrName: string, options: { includeLiveSizes?: boolean } = {}): Promise<IProjectDetail> {
        const found = await this.db.getProject(idOrName);
        if (!found) {
            throw new NotFoundException(`project not found: ${idOrName}`);
        }
        // Internal identity/ACL reads do not depend on optional RAG or filesystem measurements.
        if (options.includeLiveSizes !== false) await this.applyLiveSizes(found);
        found.quota.currentBytesUsed = found.logicalBytes;
        found.quota.retentionBytesUsed = found.retainedBytes;
        return found;
    }

    /**
     * Создать проект.
     *
     * @param body — payload создания.
     * @returns {Promise<IProjectDetail>}
     */
    createProject(body: {
        name?: string;
        externalResourceId?: string;
        retention?: number;
        quotas?: unknown;
        fsRootPath?: string;
    }): Promise<IProjectDetail> {
        return this.db.createProject({
            name: body.name,
            externalResourceId: body.externalResourceId,
            retention: body.retention,
            quotas: body.quotas as IProjectDetail['quota'] | undefined,
            fsRootPath: body.fsRootPath,
        });
    }

    /**
     * Обновить проект.
     *
     * @param idOrName - id или имя.
     * @param body — payload обновления.
     * @returns {Promise<IProjectDetail>}
     */
    async updateProject(
        idOrName: string,
        body: { state?: string; retention?: number; quotas?: unknown; fsRootPath?: string },
        actor?: string,
    ): Promise<IProjectDetail> {
        validateProjectSettings(body);
        const updated = await this.db.updateProject(
            idOrName,
            {
                state: body.state as IProjectDetail['state'],
                retention: body.retention,
                quotas: body.quotas as IProjectDetail['quota'] | undefined,
                fsRootPath: body.fsRootPath,
            },
            actor,
        );
        if (!updated) {
            throw new NotFoundException(`project not found: ${idOrName}`);
        }
        return updated;
    }

    /**
     * Обновить квоты хранилища проекта (сохранение в PG + запись в журнал операций).
     *
     * @param {string} idOrName - id или имя проекта.
     * @param {IQuota} quotas - новые значения лимитов.
     * @returns {Promise<IQuota>} актуальный срез квот после сохранения.
     */
    async updateQuotas(idOrName: string, quotas: IQuota, actor?: string): Promise<IQuota> {
        return (await this.updateProject(idOrName, { quotas }, actor)).quota;
    }

    /**
     * Удалить проект (404 при отсутствии).
     *
     * @param {string} idOrName - id или имя проекта.
     * @param {string} actor - исполнитель (principal), если известен.
     * @returns {Promise<{ ok: true; id: string }>}
     */
    async deleteProject(idOrName: string, actor?: string): Promise<{ ok: true; id: string }> {
        const found = await this.db.getProject(idOrName);

        if (!found) {
            throw new NotFoundException(`project not found: ${idOrName}`);
        }
        const deleted = await this.db.deleteProject(found.id, actor);

        if (!deleted) {
            throw new NotFoundException(`project not found: ${idOrName}`);
        }

        return { ok: true, id: found.id };
    }

    /**
     * Активные ассеты проекта (глоб. бандлы/скиллы в проектном каталоге).
     */
    listProjectAssets(projectId: string): Promise<IProjectAsset[]> {
        return this.db.listProjectAssets(projectId);
    }

    /**
     * Добавить глобальную ассету в проект (админ проекта).
     */
    async addProjectAsset(projectId: string, assetId: string, assetKind: string, actor: string): Promise<void> {
        assertProjectCatalogAsset(assetKind, assetId, projectId);
        if (assetKind === 'skill' && !assetId.includes('/'))
            throw new BadRequestException('Выберите скилл по полному пути каталога.');
        return this.db.addProjectAsset(projectId, assetId, assetKind, actor);
    }

    projectCatalog(projectId: string) {
        return this.db.projectCatalog(projectId);
    }

    pinProjectAsset(projectId: string, id: string, kind: string, actor: string, input: unknown) {
        assertProjectCatalogAsset(kind, id, projectId);
        return this.db.pinProjectAsset(projectId, id, kind, actor, input);
    }

    removeProjectAsset(projectId: string, assetId: string, assetKind: string, actor: string): Promise<boolean> {
        return this.db.removeProjectAsset(projectId, assetId, assetKind, actor);
    }

    /**
     * Уровень роли principal в проекте: 4 — Главный админ, 3 — Админ проекта,
     * 2 — Разработчик, 1 — Наблюдатель, 0 — не участник.
     */
    async projectRoleLevel(principal: string | null, projectIdOrName: string): Promise<number> {
        if (isMainAdmin(principal)) {
            return 4;
        }
        const project = await this.db.getProject(projectIdOrName);
        if (!project) {
            return 0;
        }
        const role = (await this.db.listProjectMembers(project.id)).find((m) => m.principalName === principal)?.role;
        return role ? roleLevel(role) : 0;
    }

    /**
     * Реальный журнал аудита (таблица operations).
     */
    listAudit(page: number, size: number): Promise<IPage<IAuditEvent>> {
        return this.db.listAuditEvents(page, size);
    }

    /**
     * Реальная сводка по хранилищу (размеры БД catalog + rag).
     */
    getStorage(): Promise<IStorageSummary> {
        return this.db.getStorageSummary();
    }

    /**
     * Реальный статус бэкапа (backup_state).
     */
    getBackup(): Promise<IBackupStatus> {
        return this.db.getBackupStatus();
    }

    /**
     * Реальный бэкап: pg_dump БД каталога в BACKUP_DIR (деф. data/backups от cwd)
     * + prune старых (5) + метка времени и запись в журнал операций.
     * Rag-БД (pgvector, гигабайты) включается только явно:
     * BACKUP_INCLUDE_RAG=true + RAG_PG_URL (иначе — только каталог).
     *
     * @returns {Promise<IBackupRunResult>} сводка дампов.
     */
    async executeBackup(): Promise<IBackupRunResult> {
        const catalogUrl = process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog';
        const labels: Record<string, string> = { lancedb: catalogUrl };
        const ragUrl = process.env.RAG_PG_URL?.trim();

        if (ragUrl && process.env.BACKUP_INCLUDE_RAG === 'true') {
            labels.rag = ragUrl;
        }

        const result = await runAllBackups(labels, process.env.BACKUP_DIR, { confirm: () => this.db.recordBackup() });
        const fileSummary = result.files.map((f) => `${f.label}: ${f.file} (${f.sizeBytes} Б, ${f.method})`).join('; ');
        const warnSummary = result.warnings?.length ? `; предупреждения: ${result.warnings.join('; ')}` : '';

        this.logger.log(`Бэкап: ${fileSummary}${warnSummary}`);
        void this.db
            .createOperation({
                type: 'CATALOG',
                projectId: null,
                resourceType: 'backup',
                resourceId: 'lancedb',
                state: 'SUCCEEDED',
                message: `Бэкап: ${fileSummary}${warnSummary} → ${result.directory}`,
            })
            .catch(() => undefined);

        return result;
    }

    /**
     * Реальные решения прав по scope (project_members).
     */
    getDecisions(scope: string): Promise<IAccessDecisionList> {
        return this.db.getDecisions(scope);
    }

    /**
     * Сотрудники проекта (PG).
     */
    listProjectMembers(projectId: string): Promise<IProjectMember[]> {
        return this.db.listProjectMembers(projectId);
    }

    /**
     * Добавить сотрудника в проект (PG).
     */
    addProjectMember(projectId: string, member: IProjectMember, actor: IAccessActor): Promise<IProjectMember> {
        return this.db.addProjectMember(projectId, member, actor);
    }

    /**
     * Изменить роль сотрудника в проекте (PG).
     */
    updateProjectMemberRole(
        projectId: string,
        userId: string,
        role: string,
        expectedRole: string | undefined,
        actor: IAccessActor,
    ): Promise<IProjectMember | null> {
        return this.db.updateProjectMemberRole(projectId, userId, role, expectedRole, actor);
    }

    /**
     * Удалить сотрудника из проекта (PG).
     */
    removeProjectMember(
        projectId: string,
        userId: string,
        expectedRole: string | undefined,
        actor: IAccessActor,
    ): Promise<boolean> {
        return this.db.removeProjectMember(projectId, userId, expectedRole, actor);
    }

    /**
     * Пользователи → их доступы к проектам (PG).
     */
    listAccessUsers(currentPrincipal: string | null): Promise<IAccessUserRow[]> {
        return this.db.listAccessUsers(currentPrincipal);
    }

    /**
     * Список MCP/плагинов.
     *
     * @param page - страница.
     * @param size - размер страницы.
     * @param q - фильтр по имени.
     * @returns {Promise<IPage<IAiPlugin>>}
     */
    listAiPlugins(page: number, size: number, q: string, allowedIds?: string[]): Promise<IPage<IAiPlugin>> {
        return this.db.listAiPlugins(page, size, q, allowedIds);
    }

    /**
     * Карточка MCP/плагина (404 при отсутствии).
     *
     * @param idOrName - id или имя.
     * @returns {Promise<IAiPlugin>}
     */
    async getAiPlugin(idOrName: string): Promise<IAiPlugin> {
        const found = await this.db.getAiPlugin(idOrName);

        if (!found) {
            throw new NotFoundException(`ai_plugin not found: ${idOrName}`);
        }

        return found;
    }

    /**
     * Self-verified delivery-пакет бандла (head или версия): per-file sha256 + manifest.sha256.
     * Потребитель (панель/CII) пересчитывает хэши перед установкой — проверка целостности доставки.
     *
     * @param idOrName - id или имя плагина.
     * @param version - опц., номер версии (иначе head).
     * @returns {Promise<IPackage>}
     */
    async getAiPluginPackage(idOrName: string, version?: number): Promise<IPackage> {
        const plugin = await this.getAiPlugin(idOrName);
        let files: IAiPluginFile[];
        let config = plugin.config;
        let kind = plugin.kind;
        let dependencies = normalizeDependencyPins(plugin.dependencies);
        if (version != null) {
            const v = await this.db.getAiPluginVersion(plugin.id, version);
            if (!v) {
                throw new NotFoundException(`ai_plugin version not found: ${version}`);
            }
            files = v.files;
            config = v.config;
            kind = v.metadata?.kind ?? kind;
            // Историческая версия без pins не наследует зависимости текущей карточки.
            dependencies = normalizeDependencyPins(v.metadata?.dependencies);
        } else {
            files = plugin.files;
        }
        if (dependencies.length) {
            config = { ...config, extra: { ...config?.extra, requirements: { mcp: [], plugins: [], dependencies } } };
        }
        return buildPackage(
            { id: plugin.id, name: plugin.name, kind, version: version ?? plugin.version },
            files.map((f) => ({ path: f.path, content: f.content ?? '' })),
            new Date().toISOString(),
            config,
        );
    }

    /**
     * Создать MCP/плагин.
     *
     * @param body — payload создания.
     * @returns {Promise<IAiPlugin>}
     */
    createAiPlugin(body: IAiPluginCreate, author = 'import'): Promise<IAiPlugin> {
        return this.db.createAiPlugin(body, author);
    }

    /**
     * Обновить MCP/плагин (404 при отсутствии).
     *
     * @param idOrName - id или имя.
     * @param body — payload обновления.
     * @returns {Promise<IAiPlugin>}
     */
    async updateAiPlugin(idOrName: string, body: IAiPluginUpdate, author = 'import'): Promise<IAiPlugin> {
        const updated = await this.db.updateAiPlugin(idOrName, body, author);

        if (!updated) {
            throw new NotFoundException(`ai_plugin not found: ${idOrName}`);
        }

        return updated;
    }

    /**
     * Список версий бандла (по убыванию).
     *
     * @param idOrName - id или имя плагина.
     * @returns {Promise<IAiPluginVersion[]>}
     */
    async listAiPluginVersions(idOrName: string): Promise<IAiPluginVersion[]> {
        const plugin = await this.getAiPlugin(idOrName);
        return this.db.listAiPluginVersions(plugin.id);
    }

    /**
     * Файл бандла (текст): текущая (head) версия или конкретная `version`.
     *
     * @param idOrName - id или имя плагина.
     * @param filePath - относительный путь файла в бандле.
     * @param version - опционально, номер версии (иначе head).
     * @returns {Promise<IAiPluginFile>} файл с `content`.
     */
    async getAiPluginFile(idOrName: string, filePath: string, version?: number): Promise<IAiPluginFile> {
        const plugin = await this.getAiPlugin(idOrName);
        const db = this.db;
        let files = plugin.files;
        if (version != null) {
            const v = await db.getAiPluginVersion(plugin.id, version);
            files = v === null ? [] : v.files;
        }
        const file = files.find((f) => f.path === filePath);
        if (!file) {
            throw new NotFoundException(`file not found: ${filePath}`);
        }
        return file;
    }

    /**
     * Активировать (откатыть к) версию бандла в head.
     *
     * @param idOrName - id или имя плагина.
     * @param version - номер версии.
     * @returns {Promise<IAiPlugin>}
     */
    async activateAiPluginVersion(idOrName: string, version: number, author = 'import'): Promise<IAiPlugin> {
        const plugin = await this.getAiPlugin(idOrName);
        const updated = await this.db.activateAiPluginVersion(plugin.id, version, author);
        if (!updated) {
            throw new NotFoundException(`ai_plugin version not found: ${version}`);
        }
        return updated;
    }

    /**
     * Удалить MCP/плагин (404 при отсутствии).
     *
     * @param idOrName - id или имя.
     * @returns {Promise<{ ok: true; id: string }>}
     */
    async deleteAiPlugin(idOrName: string, actor: string): Promise<{ ok: true; id: string }> {
        const deleted = await this.db.deleteAiPlugin(idOrName, actor);

        if (!deleted) {
            throw new NotFoundException(`ai_plugin not found: ${idOrName}`);
        }

        return { ok: true, id: idOrName };
    }

    /**
     * Список операций (реальные, PG).
     *
     * @param page - страница.
     * @param size - размер страницы.
     * @param project - фильтр по проекту (id или имя; сопоставляется и с id, и с именем).
     * @param state - фильтр по состоянию.
     * @returns {Promise<IPage<IOperation>>}
     */
    async listOperations(
        page: number,
        size: number,
        project?: string,
        state?: string,
        scope?: IOperationReadScope,
    ): Promise<IOperationPage> {
        // Нормализуем фильтр: исторически project_id могло записываться и как id,
        // и как имя проекта — сопоставляем с обеими формами.
        let projectIds: string[] | undefined;
        if (project) {
            const found = await this.db.getProject(project);
            projectIds = found
                ? Array.from(new Set([found.id, ...(!found.name.startsWith('prj-') ? [found.name] : [])]))
                : [project];
        }
        return this.db.listOperations(page, size, projectIds, state, scope);
    }

    /**
     * Подробности операции (404 при отсутствии).
     *
     * @param operationId - id операции.
     * @returns {Promise<IOperationDetail>}
     */
    async getOperation(operationId: string, scope?: IOperationReadScope): Promise<IOperationDetail> {
        const found = await this.db.getOperation(operationId, scope);

        if (!found) {
            throw new NotFoundException(`operation not found: ${operationId}`);
        }

        return found;
    }
}
