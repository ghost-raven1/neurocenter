import { ConflictException, HttpException, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import path from 'node:path';
import { CapacityError, reserveCapacity } from '../../../../shared/capacity.cjs';
import { ggufImportPolicy, type GgufImportPolicy } from '../../../../shared/gguf-import-policy.cjs';
import { ModelsService } from '../models.service';
import type { IModel } from '../model.types';
import { modelFromRow, type IModelRow } from '../model-history';
import { projectEmbeddingPin } from '../project-embedding.validation';
import { GgufImportService, type GgufImports } from '../gguf-import/gguf-import.service';
import { ggufImportId, type GgufUploadRow } from '../gguf-import/gguf-import.model';
import { requireFeaturesEnabled } from '../../features/require-feature-enabled';
import { localModelAlias } from '../local-model-alias';
import type { IModelProgress } from '../ollama-client';
import { GgufOllamaTransport } from './gguf-runtime.transport';
import { ggufRuntimeManifest } from './gguf-runtime.manifest';
import { RUNTIME_LIMIT_CEILINGS } from '../../../../shared/runtime-limits.cjs';
import { createPool } from '../../database/pool';

interface RuntimeIntent {
    model_id: string;
    upload_id: string;
    alias: string;
    file_sha256: string;
    bytes: string;
    state: 'RESERVED' | 'CREATE_SENT' | 'CREATED';
    manifest_sha256: string | null;
    limits: GgufImportPolicy;
}
type Database = Pick<Pool, 'query'>;
type Progress = (value: IModelProgress) => Promise<void>;
export interface GgufRuntimeProof {
    manifestSha256: string;
    alias: string;
}

/** The persisted CREATE_SENT state is an uncertainty fence: only matching manifest reconciliation can advance it. */
export class GgufModelRuntime {
    constructor(
        private readonly pool: Pool,
        private readonly imports: GgufImports,
        private readonly storage: string,
        private readonly provider = new GgufOllamaTransport(),
        private readonly flags = () => requireFeaturesEnabled(['model_hosting']),
        private readonly leasePool: Pool = pool,
    ) {}
    private async source(model: IModel): Promise<GgufUploadRow> {
        const file = model.fileImport;
        if (model.runtime !== 'ollama' || model.source !== 'custom' || !file || !ggufImportId(file.uploadId))
            throw new ConflictException('Модель не содержит принятого GGUF.');
        const row = (
            await this.pool.query<GgufUploadRow>('SELECT * FROM model_gguf_uploads WHERE model_id=$1', [model.id])
        ).rows[0];
        if (
            !row ||
            row.state !== 'ACCEPTED' ||
            row.id !== file.uploadId ||
            row.sha256 !== file.sha256 ||
            Number(row.bytes) !== file.bytes ||
            row.file_name !== file.fileName ||
            row.metadata?.architecture !== file.architecture ||
            row.metadata.version !== file.version
        )
            throw new ConflictException('Квитанция GGUF не соответствует модели. Прежний источник сохранён.');
        return { ...row, limits: ggufImportPolicy(row.limits) };
    }
    async limits(model: IModel) {
        return (await this.source(model)).limits;
    }
    private async authorize(actor: string, model: IModel, db: Database = this.pool, lock = false) {
        await this.imports.authorize({ email: actor, activeRole: 'Главный админ' }, undefined, db, lock);
        const row = (
            await db.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1' + (lock ? ' FOR SHARE' : ''), [
                model.id,
            ])
        ).rows[0];
        if (
            !row ||
            row.archived_at ||
            projectEmbeddingPin(modelFromRow(row)) !== projectEmbeddingPin(model) ||
            Number(row.revision) !== model.revision
        )
            throw new ConflictException('Карточка GGUF изменилась. Обновите каталог перед повтором.');
    }
    private async transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN');
            const result = await work(db);
            await db.query('COMMIT');
            return result;
        } catch (error) {
            await db.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            db.release();
        }
    }
    private async intent(id: string, db: Database = this.pool) {
        return (await db.query<RuntimeIntent>('SELECT * FROM model_gguf_runtime_intents WHERE model_id=$1', [id]))
            .rows[0];
    }
    private identity(intent: RuntimeIntent, source: GgufUploadRow, alias: string) {
        if (
            intent.upload_id !== source.id ||
            intent.alias !== alias ||
            intent.file_sha256 !== source.sha256 ||
            Number(intent.bytes) !== Number(source.bytes)
        )
            throw new ConflictException('Сохранённое намерение runtime относится к другому GGUF.');
    }
    private async proof(
        model: IModel,
        source: GgufUploadRow,
        intent: RuntimeIntent,
        actor: string,
        signal: AbortSignal,
    ): Promise<GgufRuntimeProof> {
        signal.throwIfAborted();
        const before = await this.provider.tag(intent.alias, intent.limits, signal);
        if (!before)
            throw new ConflictException(
                'Создание GGUF ещё не подтверждено. Повторите проверку сохранённой операции; повторное создание не отправлялось.',
            );
        let digest: string;
        try {
            digest = await ggufRuntimeManifest(
                this.storage,
                intent.alias,
                intent.file_sha256,
                Number(intent.bytes),
                intent.limits,
            );
        } catch (error) {
            if (error instanceof HttpException) throw error;
            throw new ConflictException(
                'Manifest GGUF не подтверждён. Проверьте MODEL_STORAGE_PATH и состояние Ollama, затем повторите проверку.',
            );
        }
        const after = await this.provider.tag(intent.alias, intent.limits, signal);
        if (
            before !== digest ||
            after !== digest ||
            (intent.manifest_sha256 && intent.manifest_sha256 !== digest) ||
            (model.manifestSha256 && model.manifestSha256 !== digest)
        )
            throw new ConflictException(
                'Manifest или alias GGUF изменён другим процессом. Сохранённая версия не заменена.',
            );
        await this.transaction(async (db) => {
            await this.authorize(actor, model, db, true);
            signal.throwIfAborted();
            const current = await this.intent(model.id, db);
            if (!current || current.state === 'RESERVED')
                throw new ConflictException('Создание runtime не было подтверждено владельцем операции.');
            this.identity(current, source, intent.alias);
            if (current.manifest_sha256 && current.manifest_sha256 !== digest)
                throw new ConflictException('Закреплённый manifest runtime изменился.');
            await db.query(
                "UPDATE model_gguf_runtime_intents SET state='CREATED',manifest_sha256=$2,updated_at=now() WHERE model_id=$1",
                [model.id, digest],
            );
        });
        return { manifestSha256: digest, alias: intent.alias };
    }
    private async capacity(source: GgufUploadRow, bytes: number) {
        try {
            return await reserveCapacity({
                resource: 'runtime-artifacts',
                bytes: bytes + source.limits.diskReserveBytes,
                path: this.storage,
            });
        } catch (error) {
            if (error instanceof CapacityError) throw new HttpException(error.message, error.statusCode);
            throw error;
        }
    }
    async prepare(
        model: IModel,
        actor: string,
        progress: Progress,
        signal: AbortSignal,
        allowCreate = true,
    ): Promise<GgufRuntimeProof> {
        const source = await this.source(model),
            alias = localModelAlias(model),
            lease = await this.leasePool.connect();
        let locked = false,
            discard = false;
        const parent = signal,
            controller = new AbortController(),
            aborted = () => controller.abort(parent.reason);
        parent.addEventListener('abort', aborted, { once: true });
        if (parent.aborted) aborted();
        signal = controller.signal;
        const disconnected = () => {
            discard = true;
            controller.abort(new ConflictException('Аренда runtime потеряна. Проверьте сохранённую операцию.'));
        };
        lease.on('error', disconnected);
        const check = async () => {
            signal.throwIfAborted();
            if (discard)
                throw new ConflictException('Аренда runtime потеряна. Сначала проверьте сохранённую операцию.');
            await this.authorize(actor, model);
        };
        try {
            locked = !!(
                await lease.query<{ locked: boolean }>(
                    "SELECT pg_try_advisory_lock(hashtextextended('neurocenter:gguf-runtime:'||$1,0)) AS locked",
                    [model.id],
                )
            ).rows[0]?.locked;
            if (!locked) throw new ConflictException('Подготовка этого GGUF уже выполняется. Проверьте состояние.');
            await check();
            await this.provider.version(source.limits, signal);
            let intent = await this.intent(model.id);
            const existing = await this.provider.tag(alias, source.limits, signal);
            if (!intent) {
                if (existing)
                    throw new ConflictException(
                        'Имя GGUF уже занято в Ollama без нашей квитанции. Чужая модель сохранена.',
                    );
                if (!allowCreate)
                    throw new ConflictException('GGUF ещё не подготовлен в Ollama. Запустите хостинг модели.');
                await this.flags();
                await this.imports.files.digest(
                    source.id,
                    Number(source.bytes),
                    source.sha256,
                    check,
                    source.limits.checkIntervalMs,
                );
                await check();
                intent = await this.transaction(async (db) => {
                    await this.authorize(actor, model, db, true);
                    signal.throwIfAborted();
                    await this.flags();
                    return (
                        await db.query<RuntimeIntent>(
                            `INSERT INTO model_gguf_runtime_intents(model_id,upload_id,alias,file_sha256,bytes,state,limits) VALUES($1,$2,$3,$4,$5,'RESERVED',$6::jsonb) RETURNING *`,
                            [model.id, source.id, alias, source.sha256, source.bytes, JSON.stringify(source.limits)],
                        )
                    ).rows[0];
                });
            }
            this.identity(intent, source, alias);
            intent = { ...intent, limits: ggufImportPolicy(intent.limits) };
            if (intent.state !== 'RESERVED') return await this.proof(model, source, intent, actor, signal);
            if (existing) throw new ConflictException('Alias появился до отправки CREATE. Чужая модель не заменена.');
            if (!allowCreate)
                throw new ConflictException('GGUF пока не создан. Для новой попытки нажмите запуск хостинга.');
            await this.flags();
            await check();
            const exists = await this.provider.blobExists(intent.file_sha256, intent.limits, signal),
                release = await this.capacity(source, exists ? 0 : Number(source.bytes));
            try {
                if (!exists) {
                    await progress({
                        stage: 'gguf-blob',
                        message: 'Передаём проверенный GGUF в локальный Ollama.',
                        progress: 20,
                    });
                    await this.provider.upload(
                        this.imports.files.filename(source.id),
                        Number(source.bytes),
                        intent.file_sha256,
                        intent.limits,
                        signal,
                        check,
                    );
                }
                await check();
                await this.flags();
                if (await this.provider.tag(alias, intent.limits, signal))
                    throw new ConflictException('Имя GGUF занято другой моделью. Перезапись не выполнялась.');
                await this.transaction(async (db) => {
                    await this.authorize(actor, model, db, true);
                    signal.throwIfAborted();
                    await this.flags();
                    const current = await this.intent(model.id, db);
                    if (current?.state !== 'RESERVED') throw new ConflictException('Намерение создания изменилось.');
                    this.identity(current, source, alias);
                    await db.query(
                        "UPDATE model_gguf_runtime_intents SET state='CREATE_SENT',updated_at=now() WHERE model_id=$1",
                        [model.id],
                    );
                });
                await progress({
                    stage: 'gguf-create',
                    message: 'Создаём модель из принятого файла; квитанция намерения сохранена.',
                    progress: 60,
                });
                try {
                    await this.provider.create(alias, intent.file_sha256, intent.limits, signal);
                } catch {
                    if (signal.aborted) throw signal.reason;
                }
                await check();
                return await this.proof(model, source, { ...intent, state: 'CREATE_SENT' }, actor, signal);
            } finally {
                release();
            }
        } finally {
            parent.removeEventListener('abort', aborted);
            if (locked && !discard)
                try {
                    await lease.query(
                        "SELECT pg_advisory_unlock(hashtextextended('neurocenter:gguf-runtime:'||$1,0))",
                        [model.id],
                    );
                } catch {
                    discard = true;
                }
            lease.off('error', disconnected);
            lease.release(discard);
        }
    }
}

@Injectable()
export class GgufRuntimeService extends GgufModelRuntime implements OnApplicationShutdown {
    private readonly leases: Pool;
    constructor(models: ModelsService, imports: GgufImportService) {
        const leases = createPool(
            {
                connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog',
                max: RUNTIME_LIMIT_CEILINGS.ggufImport.activeUploads,
            },
            'gguf-runtime-leases',
        );
        super(
            models.pool,
            imports,
            process.env.MODEL_STORAGE_PATH || path.resolve(__dirname, '../../../../../data/embedding'),
            undefined,
            undefined,
            leases,
        );
        this.leases = leases;
    }
    /** Hosting's beforeApplicationShutdown has settled provider work before this pool is closed. */
    async onApplicationShutdown() {
        await this.leases.end();
    }
}
