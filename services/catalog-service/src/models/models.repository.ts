import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { securityEvent } from '../access/security-events';
import { builtinModels } from './builtin-models';
import { modelSupplySeeds } from './model-supply-seed';
import type { IModel, IModelDescriptor, IProjectModel } from './model.types';
import { validateModelCreate, validateModelDelete, validateModelUpdate } from './model-validation';

interface IModelRow { id: string; name: string; descriptor: IModelDescriptor; revision: number; created_at: string | Date; updated_at: string | Date }
interface IAssignmentRow { project_id: string; model_id: string; added_by: string; added_at: string | Date }
const iso = (value: string | Date): string => value instanceof Date ? value.toISOString() : value;
const model = (row: IModelRow): IModel => ({ id: row.id, name: row.name, ...row.descriptor,
    revision: Number(row.revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
const assignment = (row: IAssignmentRow): IProjectModel => ({ projectId: row.project_id, modelId: row.model_id, addedBy: row.added_by, addedAt: iso(row.added_at) });

/** Каталог и назначения живут в одной БД, поэтому удаление модели защищено внешним ключом. */
export async function setupModelsSchema(pool: Pool): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:model-catalog-schema',0))");
        await client.query(`CREATE TABLE IF NOT EXISTS model_catalog (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, descriptor JSONB NOT NULL CHECK(jsonb_typeof(descriptor)='object'),
            revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        ); CREATE UNIQUE INDEX IF NOT EXISTS model_catalog_name ON model_catalog(lower(name));
        CREATE TABLE IF NOT EXISTS project_models (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            model_id TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE RESTRICT,
            added_by TEXT NOT NULL, added_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(project_id,model_id)
        ); CREATE INDEX IF NOT EXISTS project_models_model ON project_models(model_id)`);
        // Соседний экземпляр сервиса не создаст одноимённую карточку между проверкой и INSERT.
        await client.query('LOCK TABLE model_catalog IN SHARE ROW EXCLUSIVE MODE');
        const current = await client.query<IModelRow>('SELECT id,name,descriptor FROM model_catalog');
        for (const item of modelSupplySeeds(builtinModels, current.rows)) {
            await client.query(`INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb)
                ON CONFLICT(id) DO UPDATE SET descriptor=EXCLUDED.descriptor || jsonb_build_object('description',model_catalog.descriptor->'description'),
                    revision=model_catalog.revision+1,updated_at=now()
                WHERE model_catalog.descriptor->>'model'=EXCLUDED.descriptor->>'model'
                    AND model_catalog.descriptor->>'capability'=EXCLUDED.descriptor->>'capability'
                    AND model_catalog.descriptor->'dimension'=EXCLUDED.descriptor->'dimension'
                    AND (model_catalog.descriptor->>'source' IS DISTINCT FROM 'builtin'
                        OR model_catalog.descriptor->>'manifestSha256' IS DISTINCT FROM EXCLUDED.descriptor->>'manifestSha256')`,
                [item.id, item.name, JSON.stringify(item.descriptor)]);
        }
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

    async list(allowedIds?: string[]): Promise<IModel[]> {
        const result = await this.pool.query<IModelRow>(`SELECT * FROM model_catalog${allowedIds !== undefined ? ' WHERE id=ANY($1::text[])' : ''} ORDER BY lower(name),id`, allowedIds !== undefined ? [allowedIds] : []);
        return result.rows.map(model);
    }

    async get(id: string): Promise<IModel | null> {
        const result = await this.pool.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1', [id]);
        return result.rows[0] ? model(result.rows[0]) : null;
    }

    async accessibleIds(projectIds: string[]): Promise<string[]> {
        const result = await this.pool.query<{ model_id: string }>('SELECT DISTINCT model_id FROM project_models WHERE project_id=ANY($1::text[]) ORDER BY model_id', [projectIds]);
        return result.rows.map(row => row.model_id);
    }

    async isAssigned(projectId: string, modelId: string): Promise<boolean> {
        const result = await this.pool.query('SELECT 1 FROM project_models WHERE project_id=$1 AND model_id=$2', [projectId, modelId]);
        return result.rows.length > 0;
    }

    create(raw: unknown, actor: string): Promise<IModel> {
        const body = validateModelCreate(raw);
        const { name, ...rest } = body;
        const descriptor: IModelDescriptor = { ...rest, runtime: 'ollama', manifestSha256: null, source: 'custom' };
        return this.transaction(async client => {
            await this.lockName(client, name);
            await this.assertNameAvailable(client, name);
            const result = await client.query<IModelRow>('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb) RETURNING *',
                [`model-${randomUUID()}`, name, JSON.stringify(descriptor)]);
            const saved = model(result.rows[0]);
            await securityEvent(client, { actor, action: 'model.create', resourceId: saved.id, before: null, after: saved });
            return saved;
        });
    }

    update(id: string, raw: unknown, actor: string): Promise<IModel> {
        const body = validateModelUpdate(raw);
        return this.transaction(async client => {
            const result = await client.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 FOR UPDATE', [id]);
            if (!result.rows[0]) { throw new NotFoundException('Модель уже удалена из каталога.'); }
            const current = model(result.rows[0]);
            this.assertRevision(current, body.expectedRevision);
            const name = body.name ?? current.name;
            const description = body.description ?? current.description;
            if (name === current.name && description === current.description) { return current; }
            await this.lockName(client, name);
            await this.assertNameAvailable(client, name, id);
            const descriptor = { ...result.rows[0].descriptor, description };
            const updated = await client.query<IModelRow>('UPDATE model_catalog SET name=$2,descriptor=$3::jsonb,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *', [id, name, JSON.stringify(descriptor)]);
            const saved = model(updated.rows[0]);
            await securityEvent(client, { actor, action: 'model.update', resourceId: id, before: current, after: saved });
            return saved;
        });
    }

    remove(id: string, raw: unknown, actor: string): Promise<void> {
        const revision = validateModelDelete(raw);
        return this.transaction(async client => {
            // Тот же ключ держит worker хостинга: удаление не пересекается с запуском или остановкой модели.
            const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended('neurocenter:model-hosting',0)) AS locked");
            if (!lock.rows[0]?.locked) { throw new ConflictException('Сейчас выполняется операция хостинга модели. Дождитесь её завершения.'); }
            const result = await client.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 FOR UPDATE', [id]);
            if (!result.rows[0]) { throw new NotFoundException('Модель уже удалена из каталога.'); }
            const current = model(result.rows[0]);
            this.assertRevision(current, revision);
            if (current.source === 'builtin') { throw new ConflictException('Встроенная модель остаётся в каталоге. При необходимости остановите её хостинг или исключите модель из проекта.'); }
            const references = await client.query('SELECT 1 FROM project_models WHERE model_id=$1 LIMIT 1', [id]);
            if (references.rows.length) { throw new ConflictException('Модель добавлена в проекты. Сначала исключите её из их каталогов.'); }
            await client.query('DELETE FROM model_catalog WHERE id=$1', [id]);
            await securityEvent(client, { actor, action: 'model.delete', resourceId: id, before: current, after: null });
        });
    }

    assign(projectId: string, modelId: string, actor: string): Promise<void> {
        return this.transaction(async client => {
            const project = await client.query('SELECT id FROM projects WHERE id=$1 FOR KEY SHARE', [projectId]);
            if (!project.rows.length) { throw new NotFoundException('Проект уже удалён.'); }
            const card = await client.query('SELECT id FROM model_catalog WHERE id=$1 FOR KEY SHARE', [modelId]);
            if (!card.rows.length) { throw new NotFoundException('Модель уже удалена из общего каталога. Обновите список.'); }
            const result = await client.query<IAssignmentRow>(`INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)
                ON CONFLICT(project_id,model_id) DO NOTHING RETURNING *`, [projectId, modelId, actor]);
            if (result.rows[0]) { await securityEvent(client, { actor, action: 'project.model.add', resourceId: `${projectId} · ${modelId}`, before: null, after: assignment(result.rows[0]) }); }
        });
    }

    unassign(projectId: string, modelId: string, actor: string): Promise<boolean> {
        return this.transaction(async client => {
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
