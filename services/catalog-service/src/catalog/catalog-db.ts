import {listAuditHistory} from './audit-history';
import {setupSecurityEvents} from '../access/security-events';
import {createPool} from '../database/pool';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';

import { Client, Pool } from 'pg';
import { PluginRepository } from '../publication/plugin-repository';
import { OperationRepository } from '../operations/operation-repository';
import type { IOperationCreate, IOperationReadScope, IOperationStatePatch } from '../operations/operation.types';
import {validateProjectSettings} from './project-validation';
import { ProjectSettingsRepository, type IProjectSettingsPatch } from './project-settings-repository';
import type { IProjectRow } from './project-row';
import {setupInstallPlans} from '../devices/install-plan-schema';
import { ProjectMemberRepository, projectMemberFromRow } from './project-member-repository';
import type { IProjectMemberRow } from './project-member-repository';
import { ProjectAssetRepository } from './project-asset-repository';
import { reserveSkillDependencies } from '../publication/skill-dependency-registry';
import { SkillAuditRepository } from '../publication/skill-audit-repository';
import { setupModelsSchema } from '../models/models.repository';

import { IAccessDecision, IAccessDecisionList, IAiPlugin, IAiPluginCreate, IAiPluginUpdate, IAiPluginVersion, IAccessUserRow, IAuditEvent, IBackupStatus, IOperation, IOperationDetail, IOperationPage, IPage, IProjectDetail, IProjectMember, IProjectAsset, IProjectSummary, IQuota, IStorageSummary } from './dto';


/**
 * SQL-обёртка над PostgreSQL для каталога проектов (БД `catalog`).
 * Идемпотентная схема (CREATE ... IF NOT EXISTS) + seed demo-проекта.
 */
export class CatalogDb {
    private readonly pool: Pool;
    private readonly plugins: PluginRepository;
    private readonly operations: OperationRepository;
    private readonly members: ProjectMemberRepository;
    private readonly projectAssets: ProjectAssetRepository;
    private readonly skillAudit: SkillAuditRepository;
    private readonly projectSettings: ProjectSettingsRepository;
    private setupDone: Promise<void> | null = null;

    constructor(url: string) {
        this.pool = createPool({ connectionString: url, max: 5 },'catalog');
        this.plugins = new PluginRepository(this.pool);
        this.operations = new OperationRepository(this.pool);
        this.members = new ProjectMemberRepository(this.pool);
        this.projectAssets = new ProjectAssetRepository(this.pool);
        this.skillAudit = new SkillAuditRepository(this.pool);
        this.projectSettings = new ProjectSettingsRepository(this.pool);
    }

    /** Проверяет рабочее подключение без изменения схемы или данных. */
    public async ready():Promise<void>{await this.pool.query('SELECT 1');}

    /**
     * Идемпотентная инициализация схемы (однократно).
     *
     * @returns {Promise<void>}
     */
    public setup(): Promise<void> {
        if (!this.setupDone) {
            this.setupDone = this.init();
        }
        return this.setupDone;
    }

    private async init(): Promise<void> {
        await setupSecurityEvents(this.pool);
        await this.skillAudit.setup();
        await this.pool.query(
            `CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                external_resource_id TEXT,
                fs_root_path TEXT,
                state TEXT NOT NULL DEFAULT 'ACTIVE',
                head_snapshot_id TEXT,
                head_snapshot_date TEXT,
                head_author TEXT,
                head_revision BIGINT NOT NULL DEFAULT 0,
                logical_bytes BIGINT NOT NULL DEFAULT 0,
                retained_bytes BIGINT NOT NULL DEFAULT 0,
                retention INTEGER NOT NULL DEFAULT 30,
                active_profile_id TEXT,
                active_profile_revision INTEGER NOT NULL DEFAULT 0,
                active_operations INTEGER NOT NULL DEFAULT 0,
                quota JSONB,
                rag_project_key TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
              );
               ALTER TABLE projects ADD COLUMN IF NOT EXISTS fs_root_path TEXT;`,
        );
        if(process.env.NODE_ENV!=='production'){
            await this.pool.query("INSERT INTO projects(id,name,external_resource_id,state,rag_project_key) VALUES('prj-example-project','example-project','example:example-project','ACTIVE','prj-example-project') ON CONFLICT(id) DO NOTHING");
        }
        await this.pool.query(
            `CREATE TABLE IF NOT EXISTS ai_plugins (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL DEFAULT 'mcp',
                description TEXT NOT NULL DEFAULT '',
                version INTEGER NOT NULL DEFAULT 1,
                compatibility TEXT,
                tags TEXT[] NOT NULL DEFAULT '{}',
                origin TEXT NOT NULL DEFAULT 'upload',
                revision TEXT,
                config JSONB,
                files JSONB NOT NULL DEFAULT '[]',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
              );`,
        );
        await this.pool.query(
            `CREATE TABLE IF NOT EXISTS ai_plugin_versions (
                ai_plugin_id TEXT NOT NULL,
                version INTEGER NOT NULL,
                files JSONB NOT NULL,
                config JSONB,
                author TEXT NOT NULL DEFAULT 'admin',
                note TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (ai_plugin_id, version)
              );`,
        );
        await this.plugins.setup();
        await setupInstallPlans(this.pool);
        await this.pool.query(
            `CREATE TABLE IF NOT EXISTS operations (
                operation_id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                project_id TEXT,
                resource_type TEXT NOT NULL,
                resource_id TEXT NOT NULL,
                actor TEXT NOT NULL,
                state TEXT NOT NULL,
                percent INTEGER NOT NULL DEFAULT 0,
                bytes_done BIGINT NOT NULL DEFAULT 0,
                bytes_total BIGINT NOT NULL DEFAULT 0,
                started_at TIMESTAMPTZ,
                finished_at TIMESTAMPTZ,
                error TEXT,
                log JSONB NOT NULL DEFAULT '[]'::jsonb,
                retries INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
              );
              CREATE TABLE IF NOT EXISTS backup_state (
                key TEXT NOT NULL PRIMARY KEY,
                value TIMESTAMPTZ
              );
              CREATE TABLE IF NOT EXISTS project_members (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL,
                principal_name TEXT NOT NULL,
                display_name TEXT NOT NULL,
                role TEXT NOT NULL,
                added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                 PRIMARY KEY (project_id, user_id)
               );
               CREATE TABLE IF NOT EXISTS project_assets (
                 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                 asset_id TEXT NOT NULL,
                 asset_kind TEXT NOT NULL,
                 added_by TEXT NOT NULL DEFAULT 'admin',
                 added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                 PRIMARY KEY (project_id, asset_id, asset_kind)
               );`
        );
        // Production-перезапуск не назначает проекту невыбранную серверную папку.
        if(process.env.NODE_ENV!=='production'){await this.seedFsRootPaths();}
        if(process.env.NODE_ENV!=='production'){await this.seedProjectMembers();}
        await this.migrateLegacyRoles();
        await setupModelsSchema(this.pool);
    }

    /**
     * Миграция legacy-ролей: «Администратор»→«Админ проекта», «Участник»→«Разработчик».
     * Идемпотентно (UPDATE по старым значениям; не влияет на уже перенесённые).
     *
     * @returns {Promise<void>}
     */
    private async migrateLegacyRoles(): Promise<void> {
        await this.pool.query("UPDATE project_members SET role = 'Админ проекта' WHERE role = 'Администратор'");
        await this.pool.query("UPDATE project_members SET role = 'Разработчик' WHERE role = 'Участник'");
    }

    /**
     * Проставляет `fs_root_path` проектам, у которых он ещё не задан, исходя
     * из базового каталога проектов `PROJECTS_ROOT` (env) и имени проекта:
     * `${PROJECTS_ROOT}/${name}`. Универсально для любой машины — путь не
     * зашивается в код. Если `PROJECTS_ROOT` не задан — ничего не трогает
     * (поле остаётся пустым до явной установки через updateProject).
     *
     * @returns {Promise<void>}
     */
    private async seedFsRootPaths(): Promise<void> {
        const root = process.env.PROJECTS_ROOT?.trim();
        if (!root) {
            return;
        }
        const rows = await this.pool.query<{ id: string; name: string }>(
            "SELECT id, name FROM projects WHERE fs_root_path IS NULL OR fs_root_path = ''",
        );
        for (const r of rows.rows) {
            await this.pool.query(
                'UPDATE projects SET fs_root_path = $1, updated_at = now() WHERE id = $2',
                [path.join(root, r.name), r.id],
            );
        }
    }

    /**
     * Список проектов с пагинацией и поиском.
     *
     * @param page - номер страницы (с 1).
     * @param size - размер страницы.
     * @param query - фильт по имени (ILIKE).
     * @returns {Promise<IPage<IProjectSummary>>}
     */
    public async listProjects(page: number, size: number, query: string, allowedIds?: string[]): Promise<IPage<IProjectSummary>> {
        const params: unknown[] = [];
        const where: string[] = [];
        if (query) { params.push(`%${query}%`); where.push(`name ILIKE $${params.length}`); }
        if (allowedIds !== undefined) { params.push(allowedIds); where.push(`id=ANY($${params.length}::text[])`); }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const [count,rows] = await Promise.all([
            this.pool.query(`SELECT count(*)::int AS n FROM projects ${clause}`,params),
            this.pool.query(`SELECT projects.*,(SELECT count(*)::int FROM operations o WHERE (o.project_id=projects.id OR (o.project_id=projects.name AND projects.name NOT LIKE 'prj-%')) AND o.state IN ('QUEUED','RUNNING')) AS active_operations FROM projects ${clause} ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,[...params,size,(page-1)*size]),
        ]);
        return {items:rows.rows.map(toSummary),page,size,total:Number(count.rows[0].n)};
    }

    /**
     * Карточка проекта по id ИЛИ имени.
     *
     * @param idOrName - id проекта или его имя.
     * @returns {Promise<IProjectDetail | null>}
     */
    public async getProject(idOrName: string): Promise<IProjectDetail | null> {
        const res = await this.pool.query("SELECT projects.*,(SELECT count(*)::int FROM operations o WHERE (o.project_id=projects.id OR (o.project_id=projects.name AND projects.name NOT LIKE 'prj-%')) AND o.state IN ('QUEUED','RUNNING')) AS active_operations FROM projects WHERE id=$1 OR (name=$1 AND $1 NOT LIKE 'prj-%') ORDER BY (id=$1) DESC LIMIT 1", [idOrName]);
        const row = res.rows[0] as IProjectRow | undefined;
        return row ? toDetail(row) : null;
    }

    /**
     * Создание проекта (id выводится из имени: `prj-<slug>`).
     *
     * @param body — `{ name, externalResourceId?, retention?, quotas? }`.
     * @returns {Promise<IProjectDetail>}
     */
    public async createProject(body: ICreateProjectBody): Promise<IProjectDetail> {
        validateProjectSettings(body);
        const name = body.name?.trim().normalize('NFC') ?? '';
        if (!name || name.length > 128 || /[\u0000-\u001f/\\]/.test(name)) {
            throw new BadRequestException('Укажите название проекта длиной до 128 символов.');
        }
        const id = `prj-${randomUUID()}`;
        const fsRoot = body.fsRootPath?.trim() || null;
        const inserted = await this.pool.query(
            `INSERT INTO projects (id, name, external_resource_id, state, retention, quota, rag_project_key, fs_root_path)
             VALUES ($1, $2, $3, 'ACTIVE', $4, $5, $1, $6)
             ON CONFLICT DO NOTHING RETURNING id`,
            [
                id,
                name,
                body.externalResourceId ?? null,
                body.retention ?? 30,
                body.quotas ? JSON.stringify(body.quotas) : null,
                fsRoot || null,
            ],
        );
        if (!inserted.rowCount) { throw new ConflictException('Проект с таким названием уже существует.'); }
        const detail = await this.getProject(name);
        if (!detail) {
            throw new Error(`project not created: ${name}`);
        }
        return detail;
    }

    /**
     * Обновление проекта (state/retention/quotas).
     *
     * @param idOrName - id или имя.
     * @param body — `{ state?, retention?, quotas? }`.
     * @returns {Promise<IProjectDetail | null>}
     */
    public async updateProject(idOrName: string, body: IProjectSettingsPatch, actor = 'system:administration'): Promise<IProjectDetail | null> {
        const saved = await this.projectSettings.update(idOrName, body, actor);
        return saved ? toDetail(saved) : null;
    }

    /**
     * Удаление проекта (по id ИЛИ имени).
     *
     * @param idOrName - id или имя проекта.
     * @returns {Promise<boolean>} — true, если проект был удалён.
     */
    public async deleteProject(idOrName: string): Promise<boolean> {
        const project=await this.getProject(idOrName);if(!project){return false;}
        const res = await this.pool.query('DELETE FROM projects WHERE id = $1', [project.id]);

        return (res.rowCount ?? 0) > 0;
    }

    /** Публикации обслуживает отдельный репозиторий с транзакциями. */
    public listAiPlugins(page: number, size: number, query: string, allowedIds?: string[]): Promise<IPage<IAiPlugin>> {
        return this.plugins.list(page, size, query, allowedIds);
    }

    public getAiPlugin(idOrName: string): Promise<IAiPlugin | null> { return this.plugins.get(idOrName); }
    public createAiPlugin(body: IAiPluginCreate, author = 'import'): Promise<IAiPlugin> { return this.plugins.create(body, author); }
    public updateAiPlugin(idOrName: string, body: IAiPluginUpdate, author = 'import'): Promise<IAiPlugin | null> { return this.plugins.update(idOrName, body, author); }

    /**
     * Активные ассеты проекта (глоб. бандлы/скиллы, добавленные админом проекта).
     *
     * @param {string} projectId - id проекта.
     * @returns {Promise<IProjectAsset[]>}
     */
    public async listProjectAssets(projectId: string): Promise<IProjectAsset[]> {
        const res = await this.pool.query(
            'SELECT asset_id AS "assetId", asset_kind AS "assetKind", added_by AS "addedBy", added_at AS "addedAt" '
            + 'FROM project_assets WHERE project_id = $1 ORDER BY added_at DESC',
            [projectId],
        );
        return (res.rows as unknown[]) as IProjectAsset[];
    }

    /** Файловый сервис закрепляет зависимости до публикации текущего файла или снимка. */
    public reserveSkillDependencies(raw: unknown): Promise<{ reserved: number }> {
        return reserveSkillDependencies(this.pool, raw);
    }

    /** Аудит файлового сервиса использует основной пул и его схему квитанций. */
    public recordSkillAuditEvents(raw: unknown): Promise<{ accepted: number }> {
        return this.skillAudit.record(raw);
    }

    /** Добавить актив из глобального каталога в проект (идемпотентно). */
    public addProjectAsset(projectId: string, assetId: string, assetKind: string, actor: string): Promise<void> {
        return this.projectAssets.add(projectId, assetId, assetKind, actor);
    }

    /**
     * Удалить актив из проектного каталога.
     *
     * @returns {Promise<boolean>} — true, если строка существовала.
     */
    public removeProjectAsset(projectId: string, assetId: string, assetKind: string, actor: string): Promise<boolean> {
        return this.projectAssets.remove(projectId, assetId, assetKind, actor);
    }

    /**
     * Есть ли актив (по имени) в проектном каталоге. asset_id = `ai-plug-<slug>`
     * (mcp/plugin) или `<slug>` (skill).
     */
    public async hasProjectAssetByName(projectId: string, assetKind: string, name: string): Promise<boolean> {
        const plugin = assetKind === 'skill' ? null : await this.plugins.get(name);
        const assetId = assetKind === 'skill' ? slugify(name) : plugin?.id ?? name;
        const res = await this.pool.query(
            'SELECT 1 FROM project_assets WHERE project_id = $1 AND asset_kind = $2 AND asset_id = $3',
            [projectId, assetKind, assetId],
        );
        return Number((res.rows as unknown[]).length) > 0;
    }

    public listAiPluginVersions(pluginId: string): Promise<IAiPluginVersion[]> { return this.plugins.versions(pluginId); }
    public getAiPluginVersion(pluginId: string, version: number): Promise<IAiPluginVersion | null> { return this.plugins.version(pluginId, version); }
    public activateAiPluginVersion(pluginId: string, version: number, author = 'import'): Promise<IAiPlugin | null> { return this.plugins.activate(pluginId, version, author); }
    public deleteAiPlugin(idOrName: string, actor: string): Promise<boolean> { return this.plugins.delete(idOrName, actor); }

    /** Список операций с ограничениями проектов, исполнителя и состояния. */
    public listOperations(page: number, size: number, projectIds?: string[], state?: string, scope?: IOperationReadScope): Promise<IOperationPage> {
        return this.operations.list(page, size, projectIds, state, scope);
    }

    public getOperation(operationId: string, scope?: IOperationReadScope): Promise<IOperationDetail | null> {
        return this.operations.get(operationId, scope);
    }

    public setOperationState(operationId: string, state: string, patch?: IOperationStatePatch): Promise<IOperationDetail | null> {
        return this.operations.setState(operationId, state, patch);
    }

    /**
     * История операций и транзакционных изменений доступа и обслуживания.
     *
     * @param page - страница (с 1).
     * @param size - размер страницы.
     * @returns {Promise<IPage<IAuditEvent>>}
     */
    public async listAuditEvents(page: number, size: number): Promise<IPage<IAuditEvent>> {
        return listAuditHistory(this.pool,page,size);
    }

    /**
     * Реальная сводка по хранилищу: фактические размеры БД (catalog + rag) через pg_database_size.
     *
     * @returns {Promise<IStorageSummary>}
     */
    public async getStorageSummary(): Promise<IStorageSummary> {
        // Размер собственной БД — по текущей базе (не хардкод имени).
        const res = await this.pool.query('SELECT pg_database_size(current_database())::float8 AS sz');
        const catalog = Number((res.rows[0] as { sz: number }).sz ?? 0);
        // rag-БД может лежать на другом сервере (RAG_PG_URL) — отдельное соединение.
        const rag = await this.remoteDbSize(process.env.RAG_PG_URL?.trim());
        const limit = Number(process.env.CATALOG_STORAGE_LIMIT || 0);
        return {
            totalBytesUsed: catalog + rag,
            totalBytesLimit: limit,
            buckets: [
                { name: 'catalog (PG)', bytesUsed: catalog },
                { name: 'rag (pgvector)', bytesUsed: rag },
            ],
            stagingBytesBudget: 0,
        };
    }

    /**
     * Размер БД по pg-URL через одноразовое соединение (0 при сбое).
     *
     * @param {string} url - строка соединения (опционально).
     * @returns {Promise<number>} размер в байтах.
     */
    private async remoteDbSize(url?: string): Promise<number> {
        if (!url) {
            return 0;
        }
        const client = new Client({ connectionString: url });

        try {
            await client.connect();
            const res = await client.query('SELECT pg_database_size(current_database())::float8 AS sz');
            return Number((res.rows[0] as { sz: number }).sz ?? 0);
        } catch {
            return 0;
        } finally {
            await client.end().catch(() => undefined);
        }
    }

    /**
     * Реальный статус бэкапа: время последнего бэкапа (backup_state) + lag.
     *
     * @returns {Promise<IBackupStatus>}
     */
    public async getBackupStatus(): Promise<IBackupStatus> {
        const last = await this.pool.query("SELECT value FROM backup_state WHERE key = 'last_backup_at'");
        const lastVal: string | null = (last.rows[0] as { value: string } | undefined)?.value ?? null;
        const backupLagSeconds = lastVal ? Math.max(0, Math.round((Date.now() - Date.parse(lastVal)) / 1000)) : 0;
        return { lastBackupAt: lastVal, backupLagSeconds, restoreDrills: [] };
    }

    /**
     * Помечает момент бэкапа (из POST maintenance/backup).
     * @returns {Promise<void>}
     */
    public async recordBackup(): Promise<void> {
        await this.pool.query("INSERT INTO backup_state (key, value) VALUES ('last_backup_at', now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
    }

    /**
     * Реальные решения прав по scope: на каждый реальный проект (state → набор действий).
     *
     * @param scope - project | collection | skill | package.
     * @returns {Promise<IAccessDecisionList>}
     */
    public async getDecisions(scope: string): Promise<IAccessDecisionList> {
        if (scope !== 'project') {
            return { decisions: [], externalServiceUrl: null };
        }
        const res = await this.pool.query('SELECT id, name, state FROM projects ORDER BY created_at DESC LIMIT 50');
        const rows = res.rows as { id: string; name: string; state: string }[];
        const decisions: IAccessDecision[] = rows.map((row) => {
            const actions = row.state === 'ACTIVE'
                ? [ 'read', 'create', 'update', 'delete', 'activate', 'rollback' ]
                : [ 'read' ];
            return { scope: 'project', scopeId: row.id, actions, decisionId: `dec-${row.id}`, policyRevision: 1, ttlSeconds: 3600 };
        });
        return { decisions, externalServiceUrl: null };
    }

    /**
     * Seed дефолтных сотрудников (один раз, при пустой таблице).
     *
     * @returns {Promise<void>}
     */
    private async seedProjectMembers(): Promise<void> {
        const count = await this.pool.query('SELECT COUNT(*)::int AS n FROM project_members');
        if ((count.rows[0] as { n: number }).n > 0) {
            return;
        }
        const seeds: Array<[string, string, string, string, string, string]> = [
            ['prj-example-project', 'u-dev-admin', 'dev-admin@example.test', 'Админ проекта', 'Админ проекта', '2026-04-01T00:00:00Z'],
            ['prj-example-project', 'u-dev-developer', 'dev-user@example.test', 'Разработчик', 'Разработчик', '2026-05-15T00:00:00Z'],
        ];
        for (const seed of seeds) {
            await this.pool.query(
                `INSERT INTO project_members (project_id, user_id, principal_name, display_name, role, added_at)
                 SELECT $1,$2,$3,$4,$5,$6::timestamptz FROM projects WHERE id = $1 ON CONFLICT DO NOTHING`,
                seed,
            );
        }
    }

    /**
     * Список сотрудников проекта.
     *
     * @param {string} projectId - id проекта
     * @returns {Promise<IProjectMember[]>}
     */
    public async listProjectMembers(projectId: string): Promise<IProjectMember[]> {
        const res = await this.pool.query<IProjectMemberRow>(
            'SELECT * FROM project_members WHERE project_id = $1 ORDER BY added_at',
            [ projectId ],
        );
        return res.rows.map(projectMemberFromRow);
    }

    /**
     * Добавить сотрудника в проект.
     *
     * @param {string} projectId - id проекта
     * @param {IProjectMember} member - сотрудник
     * @returns {Promise<IProjectMember>}
     */
    public addProjectMember(projectId: string, member: IProjectMember, actor = 'system:administration'): Promise<IProjectMember> {
        return this.members.add(projectId, member, actor);
    }

    /**
     * Обновить роль сотрудника в проекте.
     *
     * @param {string} projectId - id проекта
     * @param {string} userId - id сотрудника
     * @param {string} role - новая роль
     * @returns {Promise<IProjectMember | null>}
     */
    public updateProjectMemberRole(projectId: string, userId: string, role: string, expectedRole?: string, actor = 'system:administration'): Promise<IProjectMember | null> {
        return this.members.update(projectId, userId, role, expectedRole, actor);
    }

    /**
     * Удалить сотрудника из проекта.
     *
     * @param {string} projectId - id проекта
     * @param {string} userId - id сотрудника
     * @returns {Promise<boolean>}
     */
    public removeProjectMember(projectId: string, userId: string, expectedRole?: string, actor = 'system:administration'): Promise<boolean> {
        return this.members.remove(projectId, userId, expectedRole, actor);
    }

    /**
     * Агрегированный список пользователей → проекты, к которым у них доступ.
     *
     * @param {string | null} currentPrincipal - текущий пользователь (добавить, даже без доступов).
     * @returns {Promise<IAccessUserRow[]>}
     */
    public async listAccessUsers(currentPrincipal: string | null): Promise<IAccessUserRow[]> {
        const res = await this.pool.query<{
            principal_name: string;
            display_name: string;
            user_id: string;
            project_id: string;
            project_name: string;
            role: string;
        }>(
            `SELECT pm.principal_name, pm.display_name, pm.user_id, p.id AS project_id, p.name AS project_name, pm.role
              FROM project_members pm
              JOIN projects p ON p.id = pm.project_id
              ORDER BY pm.principal_name, p.name`,
        );
        const byUser = new Map<string, IAccessUserRow>();
        for (const row of res.rows) {
            let entry = byUser.get(row.principal_name);
            if (!entry) {
                entry = { principalName: row.principal_name, displayName: row.display_name, accesses: [] };
                byUser.set(row.principal_name, entry);
            }
            entry.accesses.push({ projectId: row.project_id, projectName: row.project_name, userId: row.user_id, role: row.role });
        }
        if (currentPrincipal && !byUser.has(currentPrincipal)) {
            byUser.set(currentPrincipal, {
                principalName: currentPrincipal,
                displayName: currentPrincipal,
                accesses: [],
            });
        }
        return Array.from(byUser.values());
    }

    /** Записывает реальную операцию в журнал. */
    public createOperation(input: IOperationCreate): Promise<IOperation> {
        return this.operations.create(input);
    }

    /** Закрывает общий пул каталога по завершении сервиса. */
    public async close(): Promise<void> {
        await this.pool.end();
    }
}

interface ICreateProjectBody {
    name?: string;
    externalResourceId?: string;
    retention?: number;
    quotas?: IQuota;
    fsRootPath?: string;
}


function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)+/g, '')
        .slice(0, 64)
        .concat(name.trim() === '' ? 'x' : '');
}



function parseQuota(v: IProjectRow['quota']): IQuota {
    if (v == null) {
        return {
            currentBytesLimit: 0,
            currentBytesUsed: 0,
            retentionBytesLimit: 0,
            retentionBytesUsed: 0,
            stagingBytesLimit: 0,
            stagingBytesUsed: 0,
        };
    }
    if (typeof v === 'string') {
        try {
            return JSON.parse(v) as IQuota;
        } catch {
            return parseQuota(null);
        }
    }
    return v as IQuota;
}

function toSummary(r: IProjectRow): IProjectSummary {
    return {
        id: r.id,
        name: r.name,
        externalResourceId: r.external_resource_id ?? '',
        fsRootPath: r.fs_root_path ?? '',
        state: r.state,
        head: r.head_snapshot_id
            ? {
                snapshotId: r.head_snapshot_id,
                snapshotDate: r.head_snapshot_date ?? '',
                author: r.head_author ?? '',
                headRevision: Number(r.head_revision || 0),
            }
            : null,
        logicalBytes: Number(r.logical_bytes || 0),
        retainedBytes: Number(r.retained_bytes || 0),
        retention: Number(r.retention || 0),
        activeProfileId: r.active_profile_id ?? null,
        activeProfileRevision: Number(r.active_profile_revision || 0),
        activeOperations: Number(r.active_operations || 0),
    };
}

function toDetail(r: IProjectRow): IProjectDetail {
    return {
        ...toSummary(r),
        createdAt: r.created_at,
        quota: parseQuota(r.quota),
    };
}
