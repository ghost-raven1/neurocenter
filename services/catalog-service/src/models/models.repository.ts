import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { securityEvent } from '../access/security-events';
import type { IModel, IModelDescriptor, IModelVerification, IProjectModel } from './model.types';
import { validateModelCreate, validateModelDelete, validateModelUpdate } from './model-validation';
import { modelFromRow as model, nextModelRevision, readPinnedModel, saveModelVersion, backfillModelHistory, type IModelRow } from './model-history';
import { archiveModelWithClient } from './model-archive';

interface IAssignmentRow { project_id: string; model_id: string; added_by: string; added_at: string | Date }
const iso = (value: string | Date): string => value instanceof Date ? value.toISOString() : value;
const assignment = (row: IAssignmentRow): IProjectModel => ({ projectId: row.project_id, modelId: row.model_id, addedBy: row.added_by, addedAt: iso(row.added_at) });

/** Каталог и назначения живут в одной БД, поэтому удаление модели защищено внешним ключом. */
export async function backfillModelCatalog(pool: Pool): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:model-catalog-schema',0))");
        await backfillModelHistory(client);
        await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
}

/** Изменение карточки, назначения и аудита завершается одной транзакцией. */
export class ModelsRepository {
    constructor(private readonly pool: Pool) {}

    private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            if ((error as { code?: string }).code === '23505') { throw new ConflictException('Модель с таким названием уже есть в каталоге.'); }
            throw error;
        } finally { client.release(); }
    }

    async list(allowedIds?: string[], assignedIds: string[] = []): Promise<IModel[]> {
        const result = await this.pool.query<IModelRow>(`SELECT * FROM model_catalog WHERE (archived_at IS NULL OR id=ANY($1::text[]))${allowedIds !== undefined ? ' AND id=ANY($2::text[])' : ''} ORDER BY lower(name),id`,
            allowedIds !== undefined ? [assignedIds, allowedIds] : [assignedIds]);
        return result.rows.map(model);
    }

    async get(id: string): Promise<IModel | null> {
        const result = await this.pool.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1', [id]);
        return result.rows[0] ? model(result.rows[0]) : null;
    }

    getPinned(id: string, pin: string): Promise<IModel | null> { return readPinnedModel(this.pool, id, pin); }

    async accessibleIds(projectIds: string[]): Promise<string[]> {
        const result = await this.pool.query<{ model_id: string }>('SELECT DISTINCT model_id FROM project_models WHERE project_id=ANY($1::text[]) ORDER BY model_id', [projectIds]);
        return result.rows.map(row => row.model_id);
    }

    async isAssigned(projectId: string, modelId: string): Promise<boolean> {
        const result = await this.pool.query('SELECT 1 FROM project_models WHERE project_id=$1 AND model_id=$2', [projectId, modelId]);
        return result.rows.length > 0;
    }

    create(raw: unknown, actor: string, requestKey?: string): Promise<IModel> {
        const body = validateModelCreate(raw);
        const { name, ...rest } = body;
        const descriptor: IModelDescriptor = { ...rest, manifestSha256: null, source: 'custom',
            ...(body.runtime === 'ollama' ? {} : { verificationSha256: null }) };
        return this.transaction(async client => {
            const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
            if (requestKey) {
                await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:model-create:'||$1||':'||$2,0))", [actor, requestKey]);
                const previous = (await client.query<{ request_hash: string; model_id: string }>('SELECT request_hash,model_id FROM model_creation_requests WHERE actor=$1 AND request_key=$2', [actor, requestKey])).rows[0];
                if (previous) {
                    if (previous.request_hash !== requestHash) throw new ConflictException('Этот ключ создания уже использован для других параметров модели.');
                    const existing = (await client.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1', [previous.model_id])).rows[0];
                    if (!existing) throw new ConflictException('Созданная модель недоступна. Обновите каталог.');
                    return model(existing);
                }
            }
            await this.lockName(client, name);
            await this.assertNameAvailable(client, name);
            const result = await client.query<IModelRow>('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb) RETURNING *',
                [`model-${randomUUID()}`, name, JSON.stringify(descriptor)]);
            const saved = model(result.rows[0]);
            await saveModelVersion(client, result.rows[0]);
            await securityEvent(client, { actor, action: 'model.create', resourceId: saved.id, before: null, after: saved });
            if (requestKey) await client.query('INSERT INTO model_creation_requests(actor,request_key,request_hash,model_id) VALUES($1,$2,$3,$4)', [actor, requestKey, requestHash, saved.id]);
            return saved;
        });
    }

    update(id: string, raw: unknown, actor: string): Promise<IModel> {
        const body = validateModelUpdate(raw);
        return this.transaction(async client => {
            const result = await client.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 FOR UPDATE', [id]);
            if (!result.rows[0]) { throw new NotFoundException('Модель уже удалена из каталога.'); }
            const current = model(result.rows[0]);
            if (current.archivedAt) { throw new ConflictException('Модель убрана из общего каталога. Существующие версии сохранены.'); }
            this.assertRevision(current, body.expectedRevision);
            const name = body.name ?? current.name;
            const description = body.description ?? current.description;
            const technical = body.model !== undefined || body.modelVersion !== undefined || body.dimension !== undefined;
            if (technical && current.runtime === 'ollama') throw new ConflictException('Для другой версии управляемой модели импортируйте новый ассет.');
            const next = technical ? validateModelCreate({ name, description, runtime: current.runtime, capability: current.capability,
                model: body.model ?? current.model, modelVersion: body.modelVersion ?? current.modelVersion, dimension: body.dimension === undefined ? current.dimension : body.dimension }) : null;
            const identityChanged = !!next && (next.model !== current.model || next.modelVersion !== current.modelVersion || next.dimension !== current.dimension);
            if (name === current.name && description === current.description && !identityChanged) { return current; }
            await this.lockName(client, name);
            await this.assertNameAvailable(client, name, id);
            const descriptor = { ...result.rows[0].descriptor, description, ...(identityChanged ? { model: next!.model, modelVersion: next!.modelVersion,
                dimension: next!.dimension, verificationSha256: null } : {}) };
            const revision=await nextModelRevision(client,id,current.revision);
            const updated = await client.query<IModelRow>('UPDATE model_catalog SET name=$2,descriptor=$3::jsonb,revision=$4,updated_at=now() WHERE id=$1 RETURNING *', [id, name, JSON.stringify(descriptor),revision]);
            const saved = model(updated.rows[0]);
            await saveModelVersion(client, updated.rows[0]);
            await securityEvent(client, { actor, action: 'model.update', resourceId: id, before: current, after: saved });
            return saved;
        });
    }

    /** Первый успешный probe закрепляет custom-модель; существующий pin не заменяется. */
    async pinVerified(expected: IModel, verified: IModelVerification, actor: string, authorize: () => Promise<void>): Promise<IModel> {
        if (!verified || !/^[a-f0-9]{64}$/.test(verified.manifestSha256)
            || (expected.capability === 'embedding'
                ? !Number.isSafeInteger(verified.dimension) || Number(verified.dimension) < 1 || Number(verified.dimension) > 16384
                : verified.dimension !== null)) {
            throw new ConflictException('Runtime не подтвердил SHA и размерность модели. Повторите проверку хостинга.');
        }
        return this.transaction(async client => {
            const result = await client.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 FOR UPDATE', [expected.id]);
            if (!result.rows[0]) { throw new NotFoundException('Модель удалена во время проверки.'); }
            await authorize();
            const current = model(result.rows[0]);
            if (current.archivedAt) { throw new ConflictException('Модель убрана из общего каталога. Проверка новой версии недоступна.'); }
            this.assertRevision(current, expected.revision);
            if ((['runtime', 'model', 'capability', 'dimension', 'manifestSha256', 'source'] as const).some(key => current[key] !== expected[key])) {
                throw new ConflictException('Карточка модели изменилась во время проверки. Обновите каталог.');
            }
            if (current.dimension !== null && current.dimension !== verified.dimension
                || current.manifestSha256 !== null && current.manifestSha256 !== verified.manifestSha256) {
                throw new ConflictException('Проверенная версия или размерность отличается от закреплённой модели. Существующий pin сохранён.');
            }
            if (current.manifestSha256 !== null && current.dimension === verified.dimension) { return current; }
            if (current.manifestSha256 === null && !current.fileImport) { throw new ConflictException('Модель не имеет SHA импортированной поставки. Сначала импортируйте проверенный ассет.'); }
            if(current.fileImport){
                const proof=(await client.query<{file_sha256:string;manifest_sha256:string;upload_id:string;state:string}>('SELECT file_sha256,manifest_sha256,upload_id,state FROM model_gguf_runtime_intents WHERE model_id=$1 FOR SHARE',[current.id])).rows[0];
                if(!proof||proof.state!=='CREATED'||proof.file_sha256!==current.fileImport.sha256||proof.upload_id!==current.fileImport.uploadId||proof.manifest_sha256!==verified.manifestSha256)throw new ConflictException('Runtime не подтвердил manifest со слоем принятого GGUF. Сначала проверьте сохранённую операцию.');
            }
            const descriptor = {...result.rows[0].descriptor, manifestSha256: verified.manifestSha256,
                dimension: current.capability === 'embedding' ? verified.dimension : null};
            const revision=await nextModelRevision(client,current.id,current.revision);
            const updated = await client.query<IModelRow>(`UPDATE model_catalog SET descriptor=$2::jsonb,revision=$3,updated_at=now() WHERE id=$1 RETURNING *`,
                [current.id, JSON.stringify(descriptor),revision]);
            const saved = model(updated.rows[0]);
            await saveModelVersion(client, updated.rows[0]);
            await securityEvent(client, {actor, action: 'model.pin', resourceId: current.id, before: current, after: saved});
            return saved;
        });
    }

    remove(id: string, raw: unknown, actor: string): Promise<void> {
        const revision = validateModelDelete(raw);
        return this.transaction(client => archiveModelWithClient(client, id, revision, actor, { requireUnassigned: true }));
    }

    assign(projectId: string, modelId: string, actor: string): Promise<void> {
        return this.transaction(async client => {
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended('asset-management:model:'||$1,0))", [modelId]);
            const project = await client.query('SELECT id FROM projects WHERE id=$1 FOR KEY SHARE', [projectId]);
            if (!project.rows.length) { throw new NotFoundException('Проект уже удалён.'); }
            const card = await client.query('SELECT id FROM model_catalog WHERE id=$1 AND archived_at IS NULL FOR SHARE', [modelId]);
            if (!card.rows.length) { throw new NotFoundException('Модель уже удалена из общего каталога. Обновите список.'); }
            const result = await client.query<IAssignmentRow>(`INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)
                ON CONFLICT(project_id,model_id) DO NOTHING RETURNING *`, [projectId, modelId, actor]);
            if (result.rows[0]) { await securityEvent(client, { actor, action: 'project.model.add', resourceId: `${projectId} · ${modelId}`, before: null, after: assignment(result.rows[0]) }); }
        });
    }

    unassign(projectId: string, modelId: string, actor: string): Promise<boolean> {
        return this.transaction(async client => {
            await client.query("SELECT pg_advisory_xact_lock(hashtextextended('asset-management:model:'||$1,0))", [modelId]);
            await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
            const selected = await client.query('SELECT model_id FROM project_embedding_settings WHERE project_id=$1 AND model_id=$2', [projectId, modelId]);
            if (selected.rows.length) throw new ConflictException('Модель используется текущим индексом проекта. Сначала выберите другую модель или отключите эмбеддинги в настройках проекта.');
            const result = await client.query<IAssignmentRow>('DELETE FROM project_models WHERE project_id=$1 AND model_id=$2 RETURNING *', [projectId, modelId]);
            if (!result.rows[0]) { return false; }
            await securityEvent(client, { actor, action: 'project.model.remove', resourceId: `${projectId} · ${modelId}`, before: assignment(result.rows[0]), after: null });
            return true;
        });
    }

    private async lockName(client: PoolClient, name: string): Promise<void> {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:model-name:'||lower($1),0))", [name]);
    }
    private async assertNameAvailable(client: PoolClient, name: string, exceptId = ''): Promise<void> {
        const duplicate = await client.query('SELECT id FROM model_catalog WHERE lower(name)=lower($1) AND id<>$2', [name, exceptId]);
        if (duplicate.rows.length) { throw new ConflictException('Модель с таким названием уже есть в каталоге.'); }
    }
    private assertRevision(current: IModel, expected: number): void {
        if (current.revision !== expected) { throw new ConflictException('Карточку модели уже изменили. Обновите её перед сохранением; введённый текст остаётся в форме.'); }
    }
}
