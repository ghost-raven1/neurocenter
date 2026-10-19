import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';

import { SKILLS_STORAGE } from '../storage/skills-storage.interface';
import type { ISkillsStorage } from '../storage/skills-storage.interface';
import { skillPath as validatePath, validateSkillCreate, skillDependencyPins } from './skill-validation';
import { randomUUID } from 'node:crypto';
import { validateResources } from './skill-resources';
import {syncProjectSkills} from './skill-sync';
import type {
    ISkillAuditReceipt,
    ISkillCreateRequest,
    ISkillFile,
    ISkillListSummary,
    ISkillMeta,
    ISkillTreeNode,
    ISkillUpdateRequest,
    ISkillsListQuery,
    ISkillsSyncItem,
    ISkillsSyncResult,
    TScope,
} from './skills.model';

const joinRel = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

const sanitizeRelPath = validatePath;

/**
 * Бизнес-логика скиллов: дерево каталога, списки, CRUD и создание папок поверх `ISkillsStorage`.
 */
@Injectable()
export class SkillsService implements OnApplicationBootstrap {
    private readonly changes = new Map<string, Promise<void>>();
    public constructor(
        @Inject(SKILLS_STORAGE) private readonly storage: ISkillsStorage,
    ) {}

    /**
     * Первый запуск: создаёт базовый каталог и seed-скиллы, если пусто.
     *
     * @returns {Promise<void>}
     */
    public onApplicationBootstrap(): Promise<void> {
        return this.storage.init();
    }

    /**
     * Дерево каталога скиллов (папки + `.md`-файлы) для сайдбар-навигации.
     *
     * @returns {Promise<ISkillTreeNode[]>}
     */
    public async getTree(): Promise<ISkillTreeNode[]> {
        return this.buildTree('');
    }

    /**
     * Список скиллов: по каталогу (`path`) либо по всему дереву, с фильтрами по поиску/mcp/plugin.
     *
     * @param {ISkillsListQuery} query - параметры списка
     * @returns {Promise<ISkillListSummary[]>}
     */
    public async listSkills(query: ISkillsListQuery): Promise<ISkillListSummary[]> {
        const toSingleString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
        const pathArg = toSingleString(query.path);
        const projectKey = toSingleString(query.projectKey);
        const needle = (toSingleString(query.query) ?? '').trim().toLowerCase();
        const mcpFilter = toSingleString(query.mcp);
        const pluginFilter = toSingleString(query.plugin);
        const source: ISkillListSummary[] = projectKey
            ? await this.listInDir(`project-${sanitizeRelPath(projectKey)}`)
            : pathArg
                ? await this.listInDir(sanitizeRelPath(pathArg))
                : await this.walk('');

        return source.filter(file => {
            const matchesQuery = needle === '' || file.meta.slug.toLowerCase().includes(needle) || file.meta.name.toLowerCase().includes(needle);
            const matchesMcp = mcpFilter === undefined || file.meta.mcp.includes(mcpFilter);
            const matchesPlugin = pluginFilter === undefined || file.meta.plugins.includes(pluginFilter);

            return matchesQuery && matchesMcp && matchesPlugin;
        }).map(file => ({ path: file.path, meta: file.meta }));
    }

    /**
     * Чтение скилла по относительному пути (без расширения).
     *
     * @param {string} skillPath - относительный путь
     * @returns {Promise<ISkillFile>}
     */
    public async getSkill(skillPath: string, version?: number): Promise<ISkillFile> {
        const path = sanitizeRelPath(skillPath);

        if (path.length === 0 || !(await this.storage.existsSkill(path))) {
            throw new NotFoundException(`Скилл не найден: ${skillPath}`);
        }

        try { return await this.storage.readSkill(path, version); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { throw new NotFoundException(`Скилл не найден: ${skillPath}`); }
            throw error;
        }
    }

    /**
     * Создание скилла (`.md`-файл).
     *
     * @param {ISkillCreateRequest} request - данные создания
     * @param {string} author - автор (логин из сессии)
     * @returns {Promise<ISkillFile>}
     */
    public async createSkill(request: ISkillCreateRequest, author: string, auditActor = 'skills-service'): Promise<ISkillFile> {
        const input = validateSkillCreate(request);
        const dir = input.path;
        const slug = input.slug;

        const skillPath = joinRel(dir, slug);
        return this.withWriteLock(skillPath,async()=>{
        if (await this.storage.existsSkill(skillPath)) {
            throw new ConflictException(`Скилл уже существует: ${skillPath}`);
        }

        const meta = this.buildMeta(input.name, slug, this.scopeFromPath(skillPath), input.meta, author);
        if (meta.scope === 'project') { meta.projectId = dir.split('/')[0].replace(/^project-/, ''); }
        if (!(await this.storage.createSkill(skillPath, meta, input.body, input.resources, {actor:auditActor,source:'editor'}))) {
            throw new ConflictException(`Скилл уже существует: ${skillPath}. Проверьте опубликованную карточку или выберите другой идентификатор.`);
        }

        return this.withAuditReceipt(await this.storage.readSkill(skillPath),skillPath);
        });
    }

    /**
     * Обновление скилла: тело и/или метаданные, с бампом версии и записью в историю.
     *
     * @param {string} skillPath - относительный путь
     * @param {ISkillUpdateRequest} request - данные обновления
     * @param {string} author - автор (логин из сессии)
     * @returns {Promise<ISkillFile>}
     */
    public async updateSkill(skillPath: string, request: ISkillUpdateRequest, author: string, auditActor = 'skills-service'): Promise<ISkillFile> {
        const path = sanitizeRelPath(skillPath);
        return this.withWriteLock(path, () => this.updateSkillLocked(path, request, author, auditActor));
    }

    private async updateSkillLocked(path: string, request: ISkillUpdateRequest, author: string, auditActor = 'skills-service'): Promise<ISkillFile> {
        if (!request || typeof request !== 'object' || Array.isArray(request)) { throw new BadRequestException('Передайте изменения скилла.'); }
        if(request.name!==undefined&&typeof request.name!=='string'||request.body!==undefined&&typeof request.body!=='string'||request.meta!==undefined&&(!request.meta||typeof request.meta!=='object'||Array.isArray(request.meta))||request.note!==undefined&&typeof request.note!=='string'){throw new BadRequestException('Название и инструкция должны быть строками, метаданные — объектом.');}

        if (path.length === 0 || !(await this.storage.existsSkill(path))) {
            throw new NotFoundException(`Скилл не найден: ${path}`);
        }

        const existing = await this.storage.readSkill(path);
        if (request.expectedVersion !== undefined && (!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion < 1)) { throw new BadRequestException('Некорректная ожидаемая версия.'); }
        if (request.expectedVersion !== undefined && request.expectedVersion !== existing.meta.version) { throw new ConflictException('Скилл уже изменили. Загрузите актуальную версию перед сохранением; ваш черновик сохранён в форме.'); }
        validateSkillCreate({path: path.slice(0, Math.max(0,path.lastIndexOf('/'))), slug: existing.meta.slug, name: request.name ?? existing.meta.name,
            body: request.body ?? existing.body, meta: { ...existing.meta, ...request.meta }});
        const now = new Date().toISOString();
        const bodyChanged = request.body !== undefined && request.body !== existing.body;
        const nextMeta: ISkillMeta = { ...existing.meta };
        const metaChanged = this.applyEditableMeta(nextMeta, request);
        const nameChanged = request.name !== undefined && request.name.trim() !== existing.meta.name;
        const resources = request.resources === undefined ? existing.resources ?? [] : validateResources(request.resources);
        const resourcesChanged = JSON.stringify(resources) !== JSON.stringify(existing.resources ?? []);
        const versionBumped = bodyChanged || metaChanged || nameChanged || resourcesChanged;

        if (!versionBumped) { return this.withAuditReceipt(existing,path); }

        if (request.name !== undefined && request.name.trim().length > 0) {
            nextMeta.name = request.name.trim();
        }

        if (versionBumped) {
            nextMeta.version = existing.meta.version + 1;
            nextMeta.updatedAt = now;
            nextMeta.history = [...existing.meta.history, { version: nextMeta.version, at: now, author, note: request.note }];
        }

        await this.storage.writeSkill(path, nextMeta, request.body ?? existing.body, resources, {actor:auditActor,source:'editor'});

        return this.withAuditReceipt(await this.storage.readSkill(path),path);
    }

    /**
     * Удаление скилла (`.md`-файла).
     *
     * @param {string} skillPath - относительный путь
     * @returns {Promise<{ ok: true, path: string }>}
     */
    public async deleteSkill(skillPath: string, auditActor = 'skills-service'): Promise<{ ok: true; path: string } & ISkillAuditReceipt> {
        const path = sanitizeRelPath(skillPath);
        return this.withWriteLock(path,async()=>{
            if(path.length===0||!(await this.storage.existsSkill(path))){throw new NotFoundException(`Скилл не найден: ${skillPath}`);}
            await this.storage.deleteSkill(path,{actor:auditActor,source:'editor'});return this.withAuditReceipt({ok:true as const,path},path);
        });
    }

    /**
     * Создание папки в каталоге скиллов.
     *
     * @param {string} relPath - относительный путь папки
     * @returns {Promise<{ ok: true, path: string }>}
     */
    public async createDirectory(relPath: string, auditActor = 'skills-service'): Promise<{ ok: true; path: string } & ISkillAuditReceipt> {
        const dir = sanitizeRelPath(relPath ?? '');

        if (dir.length === 0) {
            throw new BadRequestException('Не задан путь папки');
        }

        return this.withWriteLock(dir,async () => {
            await this.storage.makeDirectory(dir,{actor:auditActor,source:'editor'});
            return this.withAuditReceipt({ok:true as const,path:dir},dir);
        });
    }

    /**
     * Синхронизация скиллов проекта (ingest из MCP): каталог `project-<projectKey>`,
     * idempotent — переопределяет существующие по slug и удаляет отсутствующие.
     *
     * @param {string} projectKey - ключ проекта в панели
     * @param {ISkillsSyncItem[]} items - карточки скиллов, прочитанные в проекте
     * @returns {Promise<ISkillsSyncResult>}
     */
    public async syncSkills(projectKey: string, items: ISkillsSyncItem[], auditActor = 'skills-service'): Promise<ISkillsSyncResult> {
        const directory=`project-${sanitizeRelPath(projectKey)}`;
        return this.withWriteLock(directory,async()=>this.withAuditReceipt(await syncProjectSkills(this.storage,projectKey,items,{actor:auditActor,source:'sync'}),directory,true));
    }

    /** Неподтверждённый аудит не превращает уже выполненное сохранение в ошибку. */
    private async withAuditReceipt<T>(result:T,path:string,recursive=false):Promise<T & ISkillAuditReceipt> {
        return {...result,...(await this.storage.pendingAudit?.(path,recursive) ? {audit:{state:'pending' as const}} : {})};
    }

    private async buildTree(dir: string): Promise<ISkillTreeNode[]> {
        const entries = await this.storage.listDir(dir);

        const nodes: ISkillTreeNode[] = [];

        for (const entry of entries) {
            if (entry.isDir) {
                const childPath = joinRel(dir, entry.name);

                nodes.push({ name: entry.name, path: childPath, type: 'dir', children: await this.buildTree(childPath) });

                continue;
            }

            const skillPath = joinRel(dir, entry.name.replace(/\.md$/i, ''));
            const file = await this.readListedSkill(skillPath);
            if (!file) { continue; }

            nodes.push({ name: file.meta.slug, path: skillPath, type: 'file', meta: file.meta });
        }

        return nodes;
    }

    private async listInDir(dir: string): Promise<ISkillListSummary[]> {
        const entries = await this.storage.listDir(dir);
        const files: ISkillListSummary[] = [];

        for (const entry of entries) {
            if (!entry.isDir) {
                const file = await this.readListedSkill(joinRel(dir, entry.name.replace(/\.md$/i, '')));
                if (file) { files.push({path:file.path,meta:file.meta}); }
            }
        }

        return files;
    }

    private async walk(dir: string): Promise<ISkillListSummary[]> {
        const entries = await this.storage.listDir(dir);
        const collected: ISkillListSummary[] = [];

        for (const entry of entries) {
            const childPath = joinRel(dir, entry.name);

            if (entry.isDir) {
                collected.push(...(await this.walk(childPath)));
            } else {
                const file = await this.readListedSkill(childPath.replace(/\.md$/i, ''));
                if (file) { collected.push({path:file.path,meta:file.meta}); }
            }
        }

        return collected;
    }

    /** Файл мог исчезнуть после перечня; повреждения и отказы чтения не скрываем. */
    private async readListedSkill(path: string): Promise<ISkillFile | undefined> {
        try { return await this.storage.readSkill(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }
    }

    private scopeFromPath(skillPath: string): TScope {
        const top = skillPath.split('/')[0];

        return top === 'project' || top.startsWith('project-') ? 'project' : 'common';
    }

    private buildMeta(name: string, slug: string, scope: TScope, meta: Partial<Omit<ISkillMeta, 'version' | 'history' | 'updatedAt' | 'owner' | 'slug'>> | undefined, author: string): ISkillMeta {
        const now = new Date().toISOString();

        return {
            generation: randomUUID(),
            name,
            slug,
            scope,
            projectId: meta?.projectId,
            description: meta?.description,
            mcp: meta?.mcp ?? [],
            plugins: meta?.plugins ?? [],
            ...(meta?.dependencies?.length ? { dependencies: meta.dependencies } : {}),
            specialization: meta?.specialization,
            tags: meta?.tags ?? [],
            version: 1,
            owner: author,
            updatedAt: now,
            history: [{ version: 1, at: now, author, note: 'Создан' }],
        };
    }

    private applyEditableMeta(meta: ISkillMeta, request: ISkillUpdateRequest): boolean {
        const editable = request.meta;

        if (!editable) {
            return false;
        }

        let changed = false;

        const assign = <K extends keyof ISkillMeta>(key: K, value: ISkillMeta[K] | undefined): void => {
            if (value !== undefined && JSON.stringify(value) !== JSON.stringify(meta[key])) {
                meta[key] = value;
                changed = true;
            }
        };

        assign('projectId', editable.projectId);
        assign('description', editable.description);
        assign('mcp', editable.mcp);
        assign('plugins', editable.plugins);
        if (editable.dependencies !== undefined) {
            const dependencies = skillDependencyPins(editable.dependencies);
            if (JSON.stringify(dependencies) !== JSON.stringify(meta.dependencies ?? [])) {
                if (dependencies.length) { meta.dependencies = dependencies; }
                else { delete meta.dependencies; }
                changed = true;
            }
        }
        assign('specialization', editable.specialization);
        assign('tags', editable.tags);

        return changed;
    }

    /** Один процесс сервиса сериализует изменения коллекции; запись хранилища выполняется атомарно. */
    private async withWriteLock<T>(path: string, work: () => Promise<T>): Promise<T> {
        const key=path.split('/')[0];
        const previous = this.changes.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => { release = resolve; });
        this.changes.set(key, current);
        await previous;
        try { return await work(); }
        finally { release(); if (this.changes.get(key) === current) { this.changes.delete(key); } }
    }
}
