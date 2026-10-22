import { nativeCardHash } from '../publication/native-hash';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

import type { IAiPlugin, IAiPluginCreate, IAiPluginUpdate, IAiPluginVersion, IPage } from '../catalog/dto';
import { object, publicationHash, validatePublication } from './publication-validation';
import { normalizeDependencyPins } from '../../../shared/dependency-pins.cjs';
import { securityEvent } from '../access/security-events';
import { assertPublicationDependencies } from './publication-dependencies';

/** Only pre-effect target discovery may retry after a positively confirmed owned rollback. */
class PublicationLockTargetChanged extends ConflictException {
    constructor(){super('Публикация появилась параллельно. Повторите тот же запрос — сохранённая версия не изменена.');}
}

/** SQL публикаций отделён от каталога проектов; карточка и её версия меняются одной транзакцией. */
export class PluginRepository {
    constructor(private readonly pool: Pool,private readonly discardBorrowed?:(client:PoolClient)=>void,private readonly configureOwnedTransaction?:(client:PoolClient)=>Promise<void>) {}

    async list(page: number, size: number, query: string, allowedIds?: string[]): Promise<IPage<IAiPlugin>> {
        const params: unknown[] = [];
        const where: string[] = allowedIds===undefined?['archived_at IS NULL']:[];
        if (query) { params.push(`%${query}%`); where.push(`name ILIKE $${params.length}`); }
        if (allowedIds !== undefined) { params.push(allowedIds); where.push(`id=ANY($${params.length}::text[])`); }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const [count, rows] = await Promise.all([
            this.pool.query(`SELECT count(*)::int AS n FROM ai_plugins ${clause}`, params),
            this.pool.query(`SELECT * FROM ai_plugins ${clause} ORDER BY created_at DESC,id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, size, (page - 1) * size]),
        ]);
        return { items: rows.rows.map(toPlugin), page, size, total: Number(count.rows[0].n) };
    }

    async get(idOrName: string): Promise<IAiPlugin | null> {
        const result = await this.pool.query("SELECT * FROM ai_plugins WHERE id=$1 OR (name=$1 AND $1 NOT LIKE 'ai-plug-%') ORDER BY (id=$1) DESC LIMIT 1", [idOrName]);
        return result.rows[0] ? toPlugin(result.rows[0]) : null;
    }

    /** Переданный idle-клиент сохраняет сессию владельца; его освобождает вызывающая сторона. */
    async create(raw: IAiPluginCreate, author: string, afterCreate?: (client: PoolClient, plugin: IAiPlugin) => Promise<void>, borrowedClient?: PoolClient, alreadyInTransaction = false, plannedId?: string): Promise<IAiPlugin> {
        // Предварительный импорт закрепляет ID на сервере; публичное тело публикации такого поля не принимает.
        if (plannedId !== undefined && !/^ai-plug-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(plannedId)) {
            throw new BadRequestException('Некорректный серверный ID плана публикации.');
        }
        const body = validatePublication(raw);
        const fingerprint = publicationHash(body);
        const freshId=plannedId??`ai-plug-${randomUUID()}`;
        for(let attempt=0;;attempt++){
        let lockedId=freshId,rolledBack=false;
        try{return await this.transaction(async client => {
            await assertPublicationDependencies(client, body.dependencies, { files: body.files });
            if (body.publicationKey) {
                await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`publication:${body.publicationKey}`]);
                const previous = await client.query('SELECT * FROM ai_plugins WHERE publication_key=$1', [body.publicationKey]);
                if (previous.rows[0]) {
                    if (previous.rows[0].publication_hash !== fingerprint) { throw new ConflictException('Этот запрос уже опубликован с другим содержимым. Начните новую публикацию.'); }
                    const plugin = toPlugin(previous.rows[0]);
                    if (plannedId && plugin.id !== plannedId) { throw new ConflictException('План публикации уже связан с другой карточкой. Обновите предварительный просмотр.'); }
                    if(plugin.id!==lockedId)throw new PublicationLockTargetChanged();
                    await afterCreate?.(client, plugin);
                    return plugin;
                }
            }
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`name:${body.name.toLowerCase()}`]);
            const duplicate = await client.query('SELECT id FROM ai_plugins WHERE lower(name)=lower($1)', [body.name]);
            if (duplicate.rows.length) { throw new ConflictException('Инструмент с таким названием уже есть в общем магазине. Откройте его для создания новой версии.'); }
            if (plannedId && (await client.query('SELECT id FROM ai_plugins WHERE id=$1',[plannedId])).rows.length) {
                throw new ConflictException('ID плана уже занят другой карточкой. Обновите предварительный просмотр.');
            }
            const result = await client.query(
                `INSERT INTO ai_plugins (id,name,kind,description,version,compatibility,tags,origin,revision,config,files,publication_key,publication_hash,dependencies)
                 VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb) RETURNING *`,
                [freshId, body.name, body.kind, body.description, body.compatibility ?? null, body.tags,
                    body.origin, body.revision, JSON.stringify(body.config), JSON.stringify(body.files), body.publicationKey ?? null, fingerprint, JSON.stringify(body.dependencies ?? [])],
            );
            const plugin = toPlugin(result.rows[0]);
            await this.insertVersion(client, plugin, author, 'Опубликован в общем магазине');
            await securityEvent(client, { actor: author, action: 'plugin.create', resourceId: plugin.id, before: null, after: auditSummary(plugin) });
            await afterCreate?.(client, plugin);
            return plugin;
        }, borrowedClient, alreadyInTransaction,{beforeGraph:async client=>{
            const previous=body.publicationKey?(await client.query<{id:string;kind:string}>('SELECT id,kind FROM ai_plugins WHERE publication_key=$1',[body.publicationKey])).rows[0]:undefined;
            if(previous&&plannedId&&previous.id!==plannedId)throw new ConflictException('План публикации уже связан с другой карточкой. Обновите предварительный просмотр.');
            lockedId=previous?.id??freshId;
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:'+(previous?.kind??body.kind)+':'+lockedId]);
        },rolledBack:()=>{rolledBack=true;}});
        }catch(error){if(error instanceof PublicationLockTargetChanged&&rolledBack&&!alreadyInTransaction&&attempt===0)continue;throw error;}
        }
    }

    async update(idOrName: string, raw: IAiPluginUpdate, author: string, afterUpdate?: (client: PoolClient, plugin: IAiPlugin) => Promise<void>, borrowedClient?: PoolClient, alreadyInTransaction = false): Promise<IAiPlugin | null> {
        const body = object(raw, 'Изменения');
        const allowed = ['kind', 'description', 'compatibility', 'tags', 'origin', 'revision', 'config', 'files', 'expectedVersion', 'dependencies'];
        if (Object.keys(body).some(key => !allowed.includes(key))) { throw new BadRequestException('В изменениях есть неподдерживаемые поля; название и тип сохраняются.'); }
        if (body.version !== undefined) { throw new BadRequestException('Номер новой версии назначает сервер. Передайте expectedVersion текущей карточки.'); }
        if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1)) { throw new BadRequestException('Некорректная ожидаемая версия.'); }
        return this.transaction(async client => {
            const found = await client.query("SELECT * FROM ai_plugins WHERE id=$1 OR (name=$1 AND $1 NOT LIKE 'ai-plug-%') ORDER BY (id=$1) DESC LIMIT 1 FOR UPDATE", [idOrName]);
            if (!found.rows[0]) { return null; }
            if(found.rows[0].archived_at){throw new ConflictException('Карточка находится в архиве. Сначала верните её в каталог.');}
            const current = toPlugin(found.rows[0]);
            const complete = async (plugin: IAiPlugin): Promise<IAiPlugin> => { await afterUpdate?.(client, plugin); return plugin; };
            if (body.expectedVersion !== undefined && current.version !== body.expectedVersion) { throw new ConflictException('Карточку уже изменили. Обновите её перед сохранением; введённый текст сохранён в форме.'); }
            if (body.kind !== undefined && body.kind !== current.kind) { throw new BadRequestException('Тип опубликованного инструмента менять нельзя. Создайте отдельный инструмент.'); }
            const { expectedVersion: _expected, ...changes } = body;
            const normalizedCurrent = { ...metadata(current), name: current.name, config: current.config, files: current.files, version: 1 };
            if (publicationHash({ ...normalizedCurrent, ...changes }) === publicationHash(normalizedCurrent)) { return complete(current); }
            const next = validatePublication({ ...normalizedCurrent, ...changes });
            const { publicationKey: _key, ...comparable } = next;
            if (publicationHash({...comparable,compatibility:next.compatibility ?? null,revision:next.revision ?? null}) === publicationHash(normalizedCurrent)) { return complete(current); }
            await assertPublicationDependencies(client, next.dependencies, { id: current.id, files: next.files });
            const saved = await this.saveVersion(client, { ...current, ...next, dependencies: next.dependencies,
                compatibility: next.compatibility ?? null, revision: next.revision ?? null }, author, 'Изменён в общем магазине');
            await securityEvent(client, { actor: author, action: 'plugin.update', resourceId: saved.id, before: auditSummary(current), after: auditSummary(saved) });
            return complete(saved);
        }, borrowedClient, alreadyInTransaction);
    }

    /** Исторический source pin получает новую ordinal-версию без изменения действующего head. */
    async snapshot(id: string, raw: IAiPluginCreate, actor: string, plannedVersion: number, expectedHeadHash: string,
        client: PoolClient, committed: (card: IAiPlugin) => Promise<void>): Promise<void> {
        const body=validatePublication(raw);
        await this.transaction(async lease=>{
            const found=await lease.query('SELECT * FROM ai_plugins WHERE id=$1 FOR UPDATE',[id]);
            const current=found.rows[0]?toPlugin(found.rows[0]):null;
            if(!current||nativeCardHash(current)!==expectedHeadHash||current.kind!==body.kind||current.name!==body.name){
                throw new ConflictException('Текущая карточка изменилась перед сохранением исторической зависимости.');
            }
            await assertPublicationDependencies(lease,body.dependencies,{id,files:body.files});
            const number=await lease.query('SELECT GREATEST(COALESCE(MAX(version),0),$2)+1 AS v FROM ai_plugin_versions WHERE ai_plugin_id=$1',[id,current.version]);
            if(Number(number.rows[0]?.v)!==plannedVersion){throw new ConflictException('История карточки изменилась после предварительного просмотра.');}
            const snapshot={...current,...body,id,version:plannedVersion,compatibility:body.compatibility??null,revision:body.revision??null};
            await this.insertVersion(lease,snapshot,actor,'Историческая зависимость ассета; действующий head сохранён');
            await securityEvent(lease,{actor,action:'plugin.snapshot',resourceId:id,before:{head:current.version},after:{head:current.version,snapshot:plannedVersion}});
            await committed(snapshot);
        },client,true);
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

    /** Старый HTTP DELETE использует тот же архив и не обходит проверку project refs. */
    async delete(idOrName:string,actor:string):Promise<boolean> {
        return this.transaction(async client=>{
            const found=await client.query("SELECT * FROM ai_plugins WHERE id=$1 OR (name=$1 AND $1 NOT LIKE 'ai-plug-%') ORDER BY (id=$1) DESC LIMIT 1 FOR UPDATE",[idOrName]);
            if(!found.rows[0]){return false;}
            await this.archive(client,toPlugin(found.rows[0]).id,actor,{requireUnassigned:true});return true;
        });
    }

    /** История/пакеты/immutable pins сохраняются; project refs снимаются только после отдельного impact CAS. */
    async archive(client:PoolClient,id:string,actor:string,options:{expectedHash?:string;removeProjectRefs?:boolean;requireUnassigned?:boolean;restore?:boolean}={}):Promise<void> {
        const found=await client.query('SELECT * FROM ai_plugins WHERE id=$1 FOR UPDATE',[id]);
        if(!found.rows[0]){throw new ConflictException('Карточка больше не доступна.');}
        const row=found.rows[0],plugin=toPlugin(row);
        if(options.expectedHash&&nativeCardHash(plugin)!==options.expectedHash){throw new ConflictException('Карточка изменилась после проверки последствий.');}
        if(options.requireUnassigned&&(await client.query('SELECT 1 FROM project_assets WHERE asset_id=$1 LIMIT 1',[id])).rows.length){
            throw new ConflictException('Инструмент используется в проектах. Откройте проверку последствий архивирования.');
        }
        if(options.removeProjectRefs){await client.query('DELETE FROM project_assets WHERE asset_id=$1 AND asset_kind=$2',[id,plugin.kind]);}
        if(!!row.archived_at===!options.restore){return;}
        // Старые инсталляции могут читать этот head по точному ID; видимость меняет только archived_at.
        await client.query('UPDATE ai_plugins SET archived_at=$2,updated_at=now() WHERE id=$1',[id,options.restore?null:new Date().toISOString()]);
        await securityEvent(client,{actor,action:options.restore?'plugin.restore':'plugin.archive',resourceId:id,before:auditSummary(plugin),
            after:{...auditSummary(plugin),archived:!options.restore,removedProjectRefs:!!options.removeProjectRefs}});
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

    private async transaction<T>(work: (client: PoolClient) => Promise<T>, borrowedClient?: PoolClient, alreadyInTransaction = false,control?:{beforeGraph:(client:PoolClient)=>Promise<void>;rolledBack:()=>void}): Promise<T> {
        if (alreadyInTransaction && !borrowedClient) { throw new Error('Внешней транзакции нужен её клиент.'); }
        const client = borrowedClient ?? await this.pool.connect();
        let tainted=false;
        try {
            if (!alreadyInTransaction) { await client.query('BEGIN'); await this.configureOwnedTransaction?.(client); }
            await control?.beforeGraph(client);
            // Единый порядок блокировок исключает гонку publish/delete и взаимную блокировку A→B/B→A.
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['publication:dependency-graph']);
            const result = await work(client);
            if (!alreadyInTransaction) { await client.query('COMMIT'); }
            return result;
        }
        catch (error) { if (!alreadyInTransaction) { try{await client.query('ROLLBACK');control?.rolledBack();}catch{tainted=true;if(borrowedClient){if(this.discardBorrowed)this.discardBorrowed(client);else client.release(true);}} } throw error; }
        finally { if (!borrowedClient) {if(tainted)client.release(true);else client.release();} }
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

export function toPlugin(row: Record<string, unknown>): IAiPlugin {
    const dependencies = normalizeDependencyPins(row.dependencies);
    return { id: String(row.id), name: String(row.name), kind: row.kind === 'plugin' ? 'plugin' : 'mcp', description: String(row.description),
        version: Number(row.version), compatibility: row.compatibility as string | null, tags: row.tags as string[], origin: String(row.origin), revision: row.revision as string | null,
        config: row.config as IAiPlugin['config'], files: row.files as IAiPlugin['files'], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
        ...(dependencies.length ? { dependencies } : {}),...(row.archived_at?{archivedAt:String(row.archived_at)}:{}) };
}

function toVersion(row: Record<string, unknown>): IAiPluginVersion {
    return { version: Number(row.version), files: row.files as IAiPluginVersion['files'], config: row.config as IAiPluginVersion['config'],
        author: String(row.author), note: String(row.note), createdAt: String(row.created_at), metadata: row.metadata as IAiPluginVersion['metadata'] };
}
