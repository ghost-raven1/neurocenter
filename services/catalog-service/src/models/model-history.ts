import type { PoolClient } from 'pg';
import type { IModel, IModelDescriptor } from './model.types';
import { projectEmbeddingPin } from './project-embedding.validation';
import { ConflictException } from '@nestjs/common';

export interface IModelRow {
    id: string; name: string; descriptor: IModelDescriptor; revision: number;
    created_at: string | Date; updated_at: string | Date; archived_at?: string | Date | null;
}
type Queryable = Pick<PoolClient, 'query'>;
const iso = (value: string | Date): string => value instanceof Date ? value.toISOString() : value;
export const modelFromRow = (row: IModelRow): IModel => {
    const model: IModel = { id: row.id, name: row.name, ...row.descriptor,
    revision: Number(row.revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    ...(row.archived_at === undefined ? {} : { archivedAt: row.archived_at ? iso(row.archived_at) : null }) };
    return { ...model, modelPin: projectEmbeddingPin(model) };
};

/** Снимок сохраняется в той же транзакции, что карточка; служебные ключи в descriptor отсутствуют. */
export async function saveModelVersion(db: Queryable, row: IModelRow): Promise<void> {
    const result=await db.query(`INSERT INTO model_catalog_versions(model_id,revision,name,descriptor,model_pin,created_at,updated_at)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) ON CONFLICT(model_id,revision) DO UPDATE SET model_id=EXCLUDED.model_id
        WHERE model_catalog_versions.name=EXCLUDED.name AND model_catalog_versions.descriptor=EXCLUDED.descriptor
            AND model_catalog_versions.model_pin=EXCLUDED.model_pin RETURNING model_id`,
    [row.id, row.revision, row.name, JSON.stringify(row.descriptor), projectEmbeddingPin(modelFromRow(row)), row.created_at, row.updated_at]);
    if(result.rowCount===0)throw new ConflictException('Эта ревизия модели уже содержит другой immutable snapshot.');
}

/** Под блокировкой model head учитывает и imported snapshot-only версии; ordinal никогда не переиспользуется. */
export async function nextModelRevision(db:Queryable,id:string,headRevision:number):Promise<number>{
    const result=await db.query<{highest:number|string|null}>('SELECT MAX(revision) AS highest FROM model_catalog_versions WHERE model_id=$1',[id]);
    const next=Math.max(Number(result.rows[0]?.highest??0),headRevision)+1;
    if(!Number.isSafeInteger(next)||next>2147483647)throw new ConflictException('Ревизия модели превышает допустимый диапазон.');
    return next;
}

/** Отдельный snapshot позволяет старой RAG-generation использовать прежнюю модель после редактирования head. */
export async function readPinnedModel(db: Queryable, id: string, pin: string): Promise<IModel | null> {
    const result = await db.query<IModelRow>(`SELECT v.model_id AS id,v.name,v.descriptor,v.revision,v.created_at,v.updated_at,c.archived_at
        FROM model_catalog_versions v JOIN model_catalog c ON c.id=v.model_id
        WHERE v.model_id=$1 AND v.model_pin=$2 ORDER BY v.revision DESC LIMIT 1`, [id, pin]);
    return result.rows[0] ? modelFromRow(result.rows[0]) : null;
}

/** Schema init сохраняет существующие heads; никаких моделей из внешней поставки здесь не создаётся. */
export async function setupModelHistory(db: Queryable): Promise<void> {
    await db.query(`ALTER TABLE model_catalog ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
        CREATE TABLE IF NOT EXISTS model_catalog_versions (
            model_id TEXT NOT NULL REFERENCES model_catalog(id) ON DELETE RESTRICT, revision INTEGER NOT NULL CHECK(revision>0),
            name TEXT NOT NULL,descriptor JSONB NOT NULL CHECK(jsonb_typeof(descriptor)='object'),model_pin TEXT NOT NULL CHECK(model_pin ~ '^[a-f0-9]{64}$'),
            created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(model_id,revision));
        CREATE INDEX IF NOT EXISTS model_catalog_version_pin ON model_catalog_versions(model_id,model_pin)`);
    const previous = await db.query<IModelRow>(`SELECT c.* FROM model_catalog c WHERE NOT EXISTS (
        SELECT 1 FROM model_catalog_versions v WHERE v.model_id=c.id AND v.revision=c.revision)`);
    for (const row of previous.rows) { await saveModelVersion(db, row); }
}
