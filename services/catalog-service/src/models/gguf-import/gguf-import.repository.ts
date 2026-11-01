import { ConflictException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { IGgufImportIntent } from '../../../../shared/gguf-import';
import type { IGgufImportPolicy } from '../../../../shared/gguf-import-policy.cjs';
import { securityEvent } from '../../access/security-events';
import { modelFromRow, saveModelVersion, type IModelRow } from '../model-history';
import type { TModelDescriptor, IValidatedModelCreate } from '../model.interfaces';
import type { IGgufUploadRow } from './gguf-import.model';

export const ggufFingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ggufRequestHash = (input: IGgufImportIntent) =>
    ggufFingerprint([input.fileName, input.bytes, input.expectedSha256 ?? null]);
export type TGgufDatabase = Pick<Pool, 'query'>;

/** One row lock settles cancellation, acceptance, and lost acknowledgements. */
export class GgufImportRepository {
    constructor(readonly pool: Pool) {}
    async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            if ((error as NodeJS.ErrnoException).code === '23505')
                throw new ConflictException('Такое имя модели или ключ импорта уже заняты.');
            throw error;
        } finally {
            client.release();
        }
    }
    async find(actor: string, key: string, db: TGgufDatabase = this.pool): Promise<IGgufUploadRow | undefined> {
        return (
            await db.query<IGgufUploadRow>('SELECT * FROM model_gguf_uploads WHERE actor=$1 AND request_key=$2', [
                actor,
                key,
            ])
        ).rows[0];
    }
    async get(actor: string, id: string, db: TGgufDatabase = this.pool, lock = false): Promise<IGgufUploadRow> {
        const row = (
            await db.query<IGgufUploadRow>(
                'SELECT * FROM model_gguf_uploads WHERE actor=$1 AND id=$2' + (lock ? ' FOR UPDATE' : ''),
                [actor, id],
            )
        ).rows[0];
        if (!row) throw new NotFoundException('Импорт GGUF не найден.');
        return row;
    }
    async quota(
        actor: string,
        limits: IGgufImportPolicy,
        db: TGgufDatabase,
        additionalBytes = 0,
        additionalPending = 0,
    ): Promise<void> {
        const row = (
            await db.query<{ bytes: string; pending: string }>(
                `SELECT COALESCE(SUM(bytes),0)::text AS bytes,COUNT(*) FILTER(WHERE state<>'ACCEPTED')::text AS pending FROM model_gguf_uploads WHERE actor=$1 AND state<>'CANCELLED' AND (state='ACCEPTED' OR expires_at>now())`,
                [actor],
            )
        ).rows[0];
        if (
            BigInt(row?.bytes ?? 0) + BigInt(additionalBytes) > BigInt(limits.storageQuotaBytes) ||
            Number(row?.pending ?? 0) + additionalPending > limits.maximumPendingImports
        )
            throw new ConflictException(
                'Лимит хранилища или незавершённых импортов исчерпан. Отмените ненужные загрузки или измените лимиты.',
            );
    }
    async create(
        actor: string,
        epoch: string,
        input: IGgufImportIntent,
        limits: IGgufImportPolicy,
        db: TGgufDatabase,
    ): Promise<IGgufUploadRow> {
        return (
            await db.query<IGgufUploadRow>(
                `INSERT INTO model_gguf_uploads(id,actor,request_key,request_hash,file_name,bytes,expected_sha256,state,auth_epoch,limits,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'WAITING',$8,$9::jsonb,$10) RETURNING *`,
                [
                    randomUUID(),
                    actor,
                    input.requestKey,
                    ggufRequestHash(input),
                    input.fileName,
                    input.bytes,
                    input.expectedSha256 ?? null,
                    epoch,
                    JSON.stringify(limits),
                    new Date(Date.now() + limits.retentionMs),
                ],
            )
        ).rows[0];
    }
    async accepted(row: IGgufUploadRow, db: TGgufDatabase) {
        const model = (await db.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1', [row.model_id])).rows[0];
        if (!model) throw new ConflictException('Принятая модель недоступна. Обновите каталог.');
        return modelFromRow(model);
    }
    async accept(row: IGgufUploadRow, input: IValidatedModelCreate, hash: string, db: PoolClient) {
        if (!row.sha256 || !row.metadata) throw new ConflictException('Сначала завершите проверку файла.');
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:model-name:'||lower($1),0))", [
            input.name,
        ]);
        if (
            (
                await db.query('SELECT id FROM model_catalog WHERE lower(name)=lower($1) AND archived_at IS NULL', [
                    input.name,
                ])
            ).rowCount
        )
            throw new ConflictException('Модель с таким названием уже есть в каталоге.');
        const { name, ...technical } = input,
            id = 'model-gguf-' + row.id;
        const descriptor: TModelDescriptor = {
            ...technical,
            manifestSha256: null,
            source: 'custom',
            fileImport: {
                format: 'gguf',
                uploadId: row.id,
                sha256: row.sha256,
                bytes: Number(row.bytes),
                fileName: row.file_name,
                architecture: row.metadata.architecture,
                version: row.metadata.version,
            },
        };
        const saved = (
            await db.query<IModelRow>(
                'INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb) RETURNING *',
                [id, name, JSON.stringify(descriptor)],
            )
        ).rows[0];
        await saveModelVersion(db, saved);
        await securityEvent(db, {
            actor: row.actor,
            action: 'model.gguf-import',
            resourceId: id,
            before: null,
            after: modelFromRow(saved),
        });
        await db.query(
            "UPDATE model_gguf_uploads SET state='ACCEPTED',model_id=$2,accept_hash=$3,updated_at=now() WHERE id=$1",
            [row.id, id, hash],
        );
        return modelFromRow(saved);
    }
}
