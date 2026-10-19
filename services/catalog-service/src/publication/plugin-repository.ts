import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

import type { IAiPlugin, IAiPluginCreate, IAiPluginUpdate, IAiPluginVersion, IPage } from '../catalog/dto';
import { object, publicationHash, validatePublication } from './publication-validation';
import { normalizeDependencyPins } from '../../../shared/dependency-pins.cjs';
import { securityEvent } from '../access/security-events';
import { assertPublicationDependencies, assertPublicationUnreferenced } from './publication-dependencies';
import { assertRemoteSkillUnreferenced, assertSkillReservationsUnreferenced, setupSkillDependencyReservations } from './skill-dependency-registry';

/** SQL публикаций отделён от каталога проектов; карточка и её версия меняются одной транзакцией. */
export class PluginRepository {
    constructor(private readonly pool: Pool, private readonly assertSkillUnreferenced: (id: string) => Promise<void> = assertRemoteSkillUnreferenced) {}

    async setup(): Promise<void> {
        await this.pool.query(`ALTER TABLE ai_plugins ADD COLUMN IF NOT EXISTS publication_key TEXT;
            ALTER TABLE ai_plugins ADD COLUMN IF NOT EXISTS publication_hash TEXT;
            CREATE UNIQUE INDEX IF NOT EXISTS ai_plugins_publication_key ON ai_plugins (publication_key);
            ALTER TABLE ai_plugin_versions ADD COLUMN IF NOT EXISTS metadata JSONB;
            ALTER TABLE ai_plugins ADD COLUMN IF NOT EXISTS dependencies JSONB NOT NULL DEFAULT '[]'::jsonb;`);
        await setupSkillDependencyReservations(this.pool);
    }

    async list(page: number, size: number, query: string, allowedIds?: string[]): Promise<IPage<IAiPlugin>> {
        const params: unknown[] = [];
        const where: string[] = [];
        if (query) { params.push(`%${query}%`); where.push(`name ILIKE $${params.length}`); }
        if (allowedIds !== undefined) { params.push(allowedIds); where.push(`id=ANY($${params.length}::text[])`); }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const [count, rows] = await Promise.all([
            this.pool.query(`SELECT count(*)::int AS n FROM ai_plugins ${clause}`, params),
            this.pool.query(`SELECT * FROM ai_plugins ${clause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, size, (page - 1) * size]),
        ]);
        return { items: rows.rows.map(toPlugin), page, size, total: Number(count.rows[0].n) };
    }

    async get(idOrName: string): Promise<IAiPlugin | null> {
        const result = await this.pool.query("SELECT * FROM ai_plugins WHERE id=$1 OR (name=$1 AND $1 NOT LIKE 'ai-plug-%') ORDER BY (id=$1) DESC LIMIT 1", [idOrName]);
        return result.rows[0] ? toPlugin(result.rows[0]) : null;
    }

    /** Переданный idle-клиент сохраняет сессию владельца; его освобождает вызывающая сторона. */
    async create(raw: IAiPluginCreate, author: string, afterCreate?: (client: PoolClient, plugin: IAiPlugin) => Promise<void>, borrowedClient?: PoolClient): Promise<IAiPlugin> {
        const body = validatePublication(raw);
        const fingerprint = publicationHash(body);
        return this.transaction(async client => {
            await assertPublicationDependencies(client, body.dependencies, { files: body.files });
            if (body.publicationKey) {
                await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`publication:${body.publicationKey}`]);
                const previous = await client.query('SELECT * FROM ai_plugins WHERE publication_key=$1', [body.publicationKey]);
                if (previous.rows[0]) {
                    if (previous.rows[0].publication_hash !== fingerprint) { throw new ConflictException('Этот запрос уже опубликован с другим содержимым. Начните новую публикацию.'); }
                    const plugin = toPlugin(previous.rows[0]);
                    await afterCreate?.(client, plugin);
                    return plugin;
                }
            }
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`name:${body.name.toLowerCase()}`]);
            const duplicate = await client.query('SELECT id FROM ai_plugins WHERE lower(name)=lower($1)', [body.name]);
            if (duplicate.rows.length) { throw new ConflictException('Инструмент с таким названием уже есть в общем магазине. Откройте его для создания новой версии.'); }
            const result = await client.query(
                `INSERT INTO ai_plugins (id,name,kind,description,version,compatibility,tags,origin,revision,config,files,publication_key,publication_hash,dependencies)
                 VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb) RETURNING *`,
                [`ai-plug-${randomUUID()}`, body.name, body.kind, body.description, body.compatibility ?? null, body.tags,
                    body.origin, body.revision, JSON.stringify(body.config), JSON.stringify(body.files), body.publicationKey ?? null, fingerprint, JSON.stringify(body.dependencies ?? [])],
            );
            const plugin = toPlugin(result.rows[0]);
            await this.insertVersion(client, plugin, author, 'Опубликован в общем магазине');
            await securityEvent(client, { actor: author, action: 'plugin.create', resourceId: plugin.id, before: null, after: auditSummary(plugin) });
            await afterCreate?.(client, plugin);
            return plugin;
        }, borrowedClient);
    }

    async update(idOrName: string, raw: IAiPluginUpdate, author: string): Promise<IAiPlugin | null> {
        const body = object(raw, 'Изменения');
        const allowed = ['kind', 'description', 'compatibility', 'tags', 'origin', 'revision', 'config', 'files', 'expectedVersion', 'dependencies'];
        if (Object.keys(body).some(key => !allowed.includes(key))) { throw new BadRequestException('В изменениях есть неподдерживаемые поля; название и тип сохраняются.'); }
        if (body.version !== undefined) { throw new BadRequestException('Номер новой версии назначает сервер. Передайте expectedVersion текущей карточки.'); }
        if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1)) { throw new BadRequestException('Некорректная ожидаемая версия.'); }
        return this.transaction(async client => {
            const found = await client.query("SELECT * FROM ai_plugins WHERE id=$1 OR (name=$1 AND $1 NOT LIKE 'ai-plug-%') ORDER BY (id=$1) DESC LIMIT 1 FOR UPDATE", [idOrName]);
            if (!found.rows[0]) { return null; }
            const current = toPlugin(found.rows[0]);
            if (body.expectedVersion !== undefined && current.version !== body.expectedVersion) { throw new ConflictException('Карточку уже изменили. Обновите её перед сохранением; введённый текст сохранён в форме.'); }
            if (body.kind !== undefined && body.kind !== current.kind) { throw new BadRequestException('Тип опубликованного инструмента менять нельзя. Создайте отдельный инструмент.'); }
            const { expectedVersion: _expected, ...changes } = body;
            const normalizedCurrent = { ...metadata(current), name: current.name, config: current.config, files: current.files, version: 1 };
            if (publicationHash({ ...normalizedCurrent, ...changes }) === publicationHash(normalizedCurrent)) { return current; }
            const next = validatePublication({ ...normalizedCurrent, ...changes });
            const { publicationKey: _key, ...comparable } = next;
            if (publicationHash({...comparable,compatibility:next.compatibility ?? null,revision:next.revision ?? null}) === publicationHash(normalizedCurrent)) { return current; }
            await assertPublicationDependencies(client, next.dependencies, { id: current.id, files: next.files });
            const saved = await this.saveVersion(client, { ...current, ...next, dependencies: next.dependencies,
                compatibility: next.compatibility ?? null, revision: next.revision ?? null }, author, 'Изменён в общем магазине');
            await securityEvent(client, { actor: author, action: 'plugin.update', resourceId: saved.id, before: auditSummary(current), after: auditSummary(saved) });
            return saved;
        });
    }

    async versions(id: string): Promise<IAiPluginVersion[]> {
        const result = await this.pool.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=$1 ORDER BY version DESC', [id]);
        return result.rows.map(toVersion);
    }

    async version(id: string, version: number): Promise<IAiPluginVersion | null> {
        const result = await this.pool.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=$1 AND version=$2', [id, version]);
        return result.rows[0] ? toVersion(result.rows[0]) : null;
    }

    /** Восстановление создаёт новую версию: старый номер никогда не используют повторно. */
    async activate(id: string, version: number, author: string): Promise<IAiPlugin | null> {
        if (!Number.isSafeInteger(version) || version < 1) { throw new BadRequestException('Некорректный номер версии.'); }
        return this.transaction(async client => {
            const current = await client.query('SELECT * FROM ai_plugins WHERE id=$1 FOR UPDATE', [id]);
            const previous = await client.query('SELECT * FROM ai_plugin_versions WHERE ai_plugin_id=$1 AND version=$2', [id, version]);
            if (!current.rows[0] || !previous.rows[0]) { return null; }
            const saved = toVersion(previous.rows[0]);
            const plugin = toPlugin(current.rows[0]);
            const candidate = { ...plugin, ...saved.metadata, files: saved.files, config: saved.config, dependencies: saved.metadata?.dependencies };
            validatePublication({ ...metadata(candidate), name: candidate.name, files: candidate.files, config: candidate.config, version: 1 });
            await assertPublicationDependencies(client, candidate.dependencies, { id: plugin.id, files: candidate.files });
            const restored = await this.saveVersion(client, candidate, author, `Восстановлено содержимое версии ${version}`);
            await securityEvent(client, { actor: author, action: 'plugin.activate', resourceId: restored.id, before: auditSummary(plugin), after: auditSummary(restored) });
            return restored;
        });
    }

    /** Удалённая версия и исполнитель остаются в аудите той же транзакции. */
    async delete(idOrName: string, actor: string): Promise<boolean> {
        return this.transaction(async client => {
            const found = await client.query("SELECT * FROM ai_plugins WHERE id=$1 OR (name=$1 AND $1 NOT LIKE 'ai-plug-%') ORDER BY (id=$1) DESC LIMIT 1 FOR UPDATE", [idOrName]);
            if (!found.rows[0]) { return false; }
            const plugin = toPlugin(found.rows[0]);
            const id = plugin.id;
            const used = await client.query('SELECT 1 FROM project_assets WHERE asset_id=$1 LIMIT 1', [id]);
            if (used.rows.length) { throw new ConflictException('Инструмент используется в проектных каталогах. Сначала уберите его из проектов.'); }
            await assertPublicationUnreferenced(client, id);
            await assertSkillReservationsUnreferenced(client, id);
            await this.assertSkillUnreferenced(id);
            await client.query('DELETE FROM ai_plugin_versions WHERE ai_plugin_id=$1', [id]);
            await client.query('DELETE FROM ai_plugins WHERE id=$1', [id]);
            await securityEvent(client, { actor, action: 'plugin.delete', resourceId: id, before: auditSummary(plugin), after: null });
            return true;
        });
    }

    private async saveVersion(client: PoolClient, plugin: IAiPlugin, author: string, note: string): Promise<IAiPlugin> {
        const number = await client.query('SELECT GREATEST(COALESCE(MAX(version),0),$2)+1 AS v FROM ai_plugin_versions WHERE ai_plugin_id=$1', [plugin.id, plugin.version]);
        const next = { ...plugin, version: Number(number.rows[0].v) };
        await this.insertVersion(client, next, author, note);
        const result = await client.query(
            `UPDATE ai_plugins SET description=$2,version=$3,compatibility=$4,tags=$5,origin=$6,revision=$7,config=$8::jsonb,files=$9::jsonb,dependencies=$10::jsonb,updated_at=now() WHERE id=$1 RETURNING *`,
            [next.id, next.description, next.version, next.compatibility, next.tags, next.origin, next.revision, JSON.stringify(next.config), JSON.stringify(next.files), JSON.stringify(next.dependencies ?? [])],
        );
        return toPlugin(result.rows[0]);
    }

    private async insertVersion(client: PoolClient, plugin: IAiPlugin, author: string, note: string): Promise<void> {
        await client.query(`INSERT INTO ai_plugin_versions (ai_plugin_id,version,files,config,author,note,metadata) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7::jsonb)`,
            [plugin.id, plugin.version, JSON.stringify(plugin.files), JSON.stringify(plugin.config), author, note, JSON.stringify(metadata(plugin))]);
    }

    private async transaction<T>(work: (client: PoolClient) => Promise<T>, borrowedClient?: PoolClient): Promise<T> {
        const client = borrowedClient ?? await this.pool.connect();
        try {
            await client.query('BEGIN');
            // Единый порядок блокировок исключает гонку publish/delete и взаимную блокировку A→B/B→A.
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['publication:dependency-graph']);
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        }
        catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { if (!borrowedClient) {client.release();} }
    }
}

/** В общий аудит попадает отпечаток версии, без исходников, окружения и локальных секретов. */
function auditSummary(plugin: IAiPlugin) {
    return { id: plugin.id, name: plugin.name, kind: plugin.kind, version: plugin.version, origin: plugin.origin, revision: plugin.revision,
        filesCount: plugin.files.length, contentHash: publicationHash({ ...metadata(plugin), config: plugin.config, files: plugin.files }) };
}

function metadata(plugin: IAiPlugin): NonNullable<IAiPluginVersion['metadata']> {
    return { kind: plugin.kind, description: plugin.description, compatibility: plugin.compatibility, tags: plugin.tags, origin: plugin.origin, revision: plugin.revision,
        ...(plugin.dependencies?.length ? { dependencies: plugin.dependencies } : {}) };
}

function toPlugin(row: Record<string, unknown>): IAiPlugin {
    const dependencies = normalizeDependencyPins(row.dependencies);
    return { id: String(row.id), name: String(row.name), kind: row.kind === 'plugin' ? 'plugin' : 'mcp', description: String(row.description),
        version: Number(row.version), compatibility: row.compatibility as string | null, tags: row.tags as string[], origin: String(row.origin), revision: row.revision as string | null,
        config: row.config as IAiPlugin['config'], files: row.files as IAiPlugin['files'], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
        ...(dependencies.length ? { dependencies } : {}) };
}

function toVersion(row: Record<string, unknown>): IAiPluginVersion {
    return { version: Number(row.version), files: row.files as IAiPluginVersion['files'], config: row.config as IAiPluginVersion['config'],
        author: String(row.author), note: String(row.note), createdAt: String(row.created_at), metadata: row.metadata as IAiPluginVersion['metadata'] };
}
