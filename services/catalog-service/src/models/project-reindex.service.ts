import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    Injectable,
    NotFoundException,
    type OnModuleInit,
    type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { ragRequestHash } from '../../../shared/rag-index-contract.cjs';
import { securityEvent } from '../access/security-events';
import { ModelsService } from './models.service';
import { ModelRuntime } from './model-runtime';
import { modelFromRow, readPinnedModel, type IModelRow } from './model-history';
import { assertProjectEmbeddingModel, projectEmbeddingPin } from './project-embedding.validation';
import { ProjectRagCoordinator } from './project-rag-coordinator';
import type { IReindexRow, IProjectReindexPlan, IGenerationReceipt } from './project-reindex.types';
import { DeviceJobs } from '../devices/device-jobs';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { withModelUsage } from '../model-usage/model-usage.context';

const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const map = (row: IReindexRow): IProjectReindexPlan => ({
    id: row.id,
    projectId: row.project_id,
    state: row.state,
    digest: row.digest,
    approved: row.approved,
    data: row.data,
    progress: Number(row.progress),
    message: row.message,
    createdAt: new Date(row.created_at).toISOString(),
});

/** Построение не меняет active head. Переключение модели и generation выполняет одна catalog transaction. */
@Injectable()
export class ProjectReindexService implements OnModuleInit, OnModuleDestroy {
    private timer: ReturnType<typeof setInterval> | undefined;
    private readonly running = new Set<string>();
    private readonly tasks = new Set<Promise<void>>();
    constructor(
        private readonly models: ModelsService,
        private readonly coordinator: ProjectRagCoordinator,
        private readonly runtime: ModelRuntime,
        private readonly jobs: DeviceJobs,
    ) {}
    async onModuleInit(): Promise<void> {
        await this.models.ready();
        this.timer = setInterval(() => {
            this.launch();
        }, 3000);
        this.timer.unref();
    }
    async onModuleDestroy(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        await Promise.allSettled([...this.tasks]);
    }
    private launch(): void {
        const task = this.recover().catch(() => undefined);
        this.tasks.add(task);
        void task.finally(() => this.tasks.delete(task));
    }
    private request(row: IReindexRow): Request {
        return {
            headers: {
                'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '',
                'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: row.actor, activeRole: row.active_role })),
            },
        } as unknown as Request;
    }
    private async owned(request: Request, projectId: string, id: string, level = 1): Promise<IReindexRow> {
        if (!uuid(id)) throw new BadRequestException('Некорректный план переиндексации.');
        const project = await this.models.resolveProject(request, projectId, level);
        const found = await this.models.pool.query<IReindexRow>(
            'SELECT * FROM project_reindex_plans WHERE id=$1 AND project_id=$2',
            [id, project.id],
        );
        if (!found.rows[0]) throw new NotFoundException('План переиндексации не найден.');
        return found.rows[0];
    }
    /** Accepted receipts need fresh read access; only a new plan revalidates write admission and its installation. */
    async create(request: Request, projectId: string, value: unknown): Promise<IProjectReindexPlan> {
        const input = value as Record<string, unknown>;
        if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.keys(input).some(
                (key) =>
                    !['expectedSelectionRevision', 'modelId', 'expectedModelPin', 'requestKey', 'connection'].includes(
                        key,
                    ),
            ) ||
            !Number.isSafeInteger(input.expectedSelectionRevision) ||
            Number(input.expectedSelectionRevision) < 0 ||
            typeof input.modelId !== 'string' ||
            !sha(input.expectedModelPin) ||
            !(sha(input.requestKey) || uuid(input.requestKey))
        )
            throw new BadRequestException('Передайте актуальную модель, pin, ревизию выбора и ключ повтора.');
        let connection: import('./project-reindex.types').IReindexConnectionTarget | undefined;
        if (input.connection !== undefined) {
            const value = input.connection as Record<string, unknown>;
            if (
                !value ||
                typeof value !== 'object' ||
                Array.isArray(value) ||
                Object.keys(value).sort().join(',') !==
                    'assetId,assetKind,deviceId,expectedBindingId,expectedInstanceId,expectedManifest,version' ||
                !uuid(value.deviceId) ||
                typeof value.assetId !== 'string' ||
                !['mcp', 'plugin'].includes(String(value.assetKind)) ||
                !Number.isSafeInteger(value.version) ||
                Number(value.version) < 1 ||
                !sha(value.expectedManifest) ||
                !sha(value.expectedBindingId) ||
                !uuid(value.expectedInstanceId)
            )
                throw new BadRequestException('Выберите точную установку OpenCodeRAG и текущую папку.');
            connection = value as unknown as typeof connection;
        }
        const project = await this.models.resolveProject(request, projectId, 1);
        const assertReplay = (plan: IReindexRow) => {
            if (
                plan.data.modelId !== input.modelId ||
                plan.data.modelPin !== input.expectedModelPin ||
                plan.data.context.revision !== input.expectedSelectionRevision ||
                ragRequestHash(plan.data.connection ?? null) !== ragRequestHash(connection ?? null)
            )
                throw new ConflictException('Ключ повтора уже закреплён за другим планом.');
        };
        const previous = await this.models.pool.query<IReindexRow>(
            'SELECT * FROM project_reindex_plans WHERE project_id=$1 AND request_key=$2',
            [project.id, input.requestKey],
        );
        if (previous.rows[0]) {
            await this.models.resolveProject(request, project.id, 1);
            assertReplay(previous.rows[0]);
            return this.format(previous.rows[0]);
        }
        const actor = await this.models.actor(request);
        await this.models.resolveProject(request, project.id, 3, actor);
        await requireFeaturesEnabled(['rag_sync']);
        if (connection) await this.jobs.validateReindexTarget(actor, project.id, connection);
        const db = await this.models.pool.connect();
        let plan: IReindexRow,
            created = false;
        try {
            await db.query('BEGIN');
            await db.query("SELECT pg_advisory_xact_lock(hashtextextended('asset-management:model:'||$1,0))", [
                input.modelId,
            ]);
            await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [project.id]);
            const previous = await db.query<IReindexRow>(
                'SELECT * FROM project_reindex_plans WHERE project_id=$1 AND request_key=$2',
                [project.id, input.requestKey],
            );
            if (previous.rows[0]) {
                plan = previous.rows[0];
                await this.models.resolveProject(request, project.id, 1);
                assertReplay(plan);
            } else {
                await this.models.resolveProject(request, project.id, 3);
                await requireFeaturesEnabled(['rag_sync']);
                await this.coordinator.requireIdle(db, project.id);
                const context = await this.coordinator.context(project.id, db);
                if (context.revision !== input.expectedSelectionRevision)
                    throw new ConflictException('Модель проекта уже изменена. Обновите сведения.');
                const model = await this.target(db, project.id, input.modelId, input.expectedModelPin);
                const profile = {
                    provider: 'openai' as const,
                    model: `neurocenter/${model.id}/sha256/${input.expectedModelPin}`,
                    dimension: model.dimension!,
                };
                const data = {
                    context,
                    ...(connection ? { connection } : {}),
                    modelId: model.id,
                    modelPin: input.expectedModelPin,
                    profile,
                    sourceSnapshot: null,
                    rowCount: 0,
                    requiredBytes: 0,
                };
                const result = await db.query<IReindexRow>(
                    `INSERT INTO project_reindex_plans(id,project_id,request_key,actor,active_role,state,digest,data,message)
                    VALUES($1,$2,$3,$4,$5,'preparing',$6,$7::jsonb,'Проверяем исходный индекс.') RETURNING *`,
                    [
                        randomUUID(),
                        project.id,
                        input.requestKey,
                        actor.email,
                        actor.activeRole,
                        ragRequestHash(data),
                        JSON.stringify(data),
                    ],
                );
                plan = result.rows[0];
                created = true;
            }
            await db.query('COMMIT');
        } catch (error) {
            await db.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            db.release();
        }
        if (!created) return this.get(request, project.id, plan.id);
        await this.models.pool.query(
            'UPDATE project_reindex_plans SET connection_request_key=id WHERE id=$1 AND connection_request_key IS NULL',
            [plan.id],
        );
        await this.prepare(plan);
        return this.get(request, project.id, plan.id);
    }
    private async target(db: Pick<PoolClient, 'query'>, projectId: string, id: string, pin: string) {
        const found = await db.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 FOR SHARE', [id]);
        if (!found.rows[0]) throw new NotFoundException('Модель удалена.');
        const model = modelFromRow(found.rows[0]);
        if (model.archivedAt || projectEmbeddingPin(model) !== pin)
            throw new ConflictException('Модель изменена или убрана из каталога. Подготовьте новый план.');
        if (!model.dimension || model.dimension > 16000)
            throw new ConflictException('Для проектной базы нужна embedding-модель размерности от 1 до 16000.');
        assertProjectEmbeddingModel(model, model.dimension);
        if (
            !(
                await db.query('SELECT 1 FROM project_models WHERE project_id=$1 AND model_id=$2 FOR KEY SHARE', [
                    projectId,
                    id,
                ])
            ).rows.length
        )
            throw new ConflictException('Модель не добавлена в каталог проекта.');
        return model;
    }
    private async prepare(row: IReindexRow): Promise<void> {
        if (this.running.has(row.id)) return;
        this.running.add(row.id);
        try {
            await this.models.resolveProject(this.request(row), row.project_id, 3);
            await requireFeaturesEnabled(['rag_sync']);
            const source = await this.coordinator.client.call<{
                hash: string;
                rows: number;
                bytes: number;
                availableBytes: number;
            }>('source', { projectId: row.project_id, generation: row.data.context.generation });
            if (
                !sha(source.hash) ||
                !Number.isSafeInteger(source.rows) ||
                source.rows < 0 ||
                !Number.isSafeInteger(source.bytes) ||
                source.bytes < 0
            )
                throw new ConflictException('Исходный снимок не прошёл проверку.');
            const data = {
                ...row.data,
                sourceSnapshot: source.hash,
                rowCount: source.rows,
                requiredBytes: source.bytes + source.rows * row.data.profile.dimension * 4,
            };
            if (!Number.isSafeInteger(data.requiredBytes))
                throw new ConflictException('Оценка размера превышает допустимый диапазон.');
            if (!Number.isSafeInteger(source.availableBytes) || source.availableBytes < data.requiredBytes)
                throw new HttpException(
                    {
                        code: 'RAG_QUOTA_EXCEEDED',
                        message:
                            'Недостаточно свободного лимита для нового поколения. Увеличьте лимит базы знаний и повторите подготовку.',
                    },
                    413,
                );
            const db = await this.models.pool.connect();
            try {
                await db.query('BEGIN');
                await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [row.project_id]);
                await this.coordinator.requireIdle(db, row.project_id);
                const current = await this.coordinator.context(row.project_id, db);
                if (ragRequestHash(current) !== ragRequestHash(row.data.context))
                    throw new ConflictException('Индекс изменился во время подготовки. Подготовьте новый план.');
                await db.query(
                    `UPDATE project_reindex_plans SET data=$2::jsonb,digest=$3,state=$4,approved=$5,message=$6,updated_at=now() WHERE id=$1 AND state='preparing'`,
                    [
                        row.id,
                        JSON.stringify(data),
                        ragRequestHash(data),
                        source.rows ? 'needs_input' : 'building',
                        !source.rows,
                        source.rows
                            ? `Нужно перестроить ${source.rows} фрагментов. Действующий индекс будет работать до переключения.`
                            : 'Готовим пустой индекс новой модели.',
                    ],
                );
                await db.query('COMMIT');
            } catch (error) {
                await db.query('ROLLBACK').catch(() => undefined);
                throw error;
            } finally {
                db.release();
            }
        } catch (error) {
            await this.fail(row.id, error);
        } finally {
            this.running.delete(row.id);
        }
    }
    async get(request: Request, projectId: string, id: string): Promise<IProjectReindexPlan> {
        return this.format(await this.owned(request, projectId, id));
    }
    async latest(request: Request, projectId: string): Promise<IProjectReindexPlan | null> {
        const project = await this.models.resolveProject(request, projectId, 1);
        const result = await this.models.pool.query<IReindexRow>(
            `SELECT * FROM project_reindex_plans WHERE project_id=$1
            ORDER BY (state IN ('preparing','needs_input','building','ready','cancelling')) DESC,created_at DESC LIMIT 1`,
            [project.id],
        );
        return result.rows[0] ? this.format(result.rows[0]) : null;
    }
    private async format(row: IReindexRow): Promise<IProjectReindexPlan> {
        const plan = map(row);
        if (!row.data.connection) return plan;
        const found = row.connection_job_id
            ? await this.models.pool.query<{ state: string; message: string; percent: number | null }>(
                  'SELECT state,message,percent FROM bridge_jobs WHERE id=$1 AND email=$2 AND project_id=$3',
                  [row.connection_job_id, row.actor, row.project_id],
              )
            : null;
        const job = found?.rows[0];
        return {
            ...plan,
            local: {
                jobId: row.connection_job_id ?? null,
                state:
                    job?.state ?? (row.connection_error ? 'failed' : row.state === 'applied' ? 'pending' : 'waiting'),
                message:
                    job?.message ??
                    row.connection_error ??
                    (row.state === 'applied'
                        ? 'Передаём подключение выбранному компьютеру.'
                        : 'Локальный индекс будет перестроен после подготовки серверного.'),
                percent: job?.percent ?? null,
            },
        };
    }
    private async enqueue(row: IReindexRow): Promise<void> {
        if (!row.data.connection || row.connection_job_id || row.connection_error) return;
        try {
            await requireFeaturesEnabled(['rag_sync']);
            const current = await this.coordinator.context(row.project_id);
            if (current.generation !== row.id)
                throw new ConflictException('Выбор проекта изменился до подключения компьютера.');
            const job = await this.jobs.create(
                { email: row.actor, activeRole: row.active_role },
                {
                    ...row.data.connection,
                    kind: 'connect-rag-model',
                    reindex: true,
                    projectId: row.project_id,
                    requestKey: row.connection_request_key ?? row.id,
                    expectedEmbeddingRevision: current.revision,
                    expectedEmbeddingPin: row.data.modelPin,
                },
            );
            await this.models.pool.query(
                'UPDATE project_reindex_plans SET connection_job_id=$2,connection_error=NULL WHERE id=$1',
                [row.id, job.id],
            );
        } catch (error) {
            if (error instanceof HttpException && [400, 403, 404, 409].includes(error.getStatus()))
                await this.models.pool.query(
                    'UPDATE project_reindex_plans SET connection_error=$2 WHERE id=$1 AND connection_job_id IS NULL',
                    [row.id, 'Компьютер или установка изменились. Проверьте подключение и повторите локальный шаг.'],
                );
        }
    }
    async retryLocal(request: Request, projectId: string, id: string): Promise<IProjectReindexPlan> {
        const row = await this.owned(request, projectId, id, 3);
        if (row.state !== 'applied' || !row.data.connection)
            throw new ConflictException('Локальное подключение ещё не готово к повтору.');
        const plan = await this.format(row);
        if (plan.local && !['failed', 'cancelled'].includes(plan.local.state))
            throw new ConflictException('Дождитесь текущего подключения.');
        const changed = await this.models.pool.query(
            `UPDATE project_reindex_plans SET connection_job_id=NULL,connection_error=NULL,connection_request_key=$2
            WHERE id=$1 AND connection_request_key IS NOT DISTINCT FROM $3::uuid AND connection_job_id IS NOT DISTINCT FROM $4::uuid`,
            [id, randomUUID(), row.connection_request_key, row.connection_job_id],
        );
        if (!changed.rowCount) return this.get(request, projectId, id);
        const saved = (
            await this.models.pool.query<IReindexRow>('SELECT * FROM project_reindex_plans WHERE id=$1', [id])
        ).rows[0];
        await this.enqueue(saved);
        return this.get(request, projectId, id);
    }
    async start(request: Request, projectId: string, id: string, input: unknown): Promise<IProjectReindexPlan> {
        const row = await this.owned(request, projectId, id, 3),
            body = input as { digest?: unknown };
        if (
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            Object.keys(body).join(',') !== 'digest' ||
            body.digest !== row.digest
        )
            throw new ConflictException('План изменился. Проверьте новое описание последствий.');
        await requireFeaturesEnabled(['rag_sync']);
        if (row.state === 'needs_input') {
            await this.models.pool.query(
                "UPDATE project_reindex_plans SET state='building',approved=true,message='Собираем новое поколение.',updated_at=now() WHERE id=$1 AND state='needs_input'",
                [id],
            );
        } else if (!['building', 'ready', 'applied'].includes(row.state))
            throw new ConflictException('Этот план уже завершён или устарел. Подготовьте новый.');
        this.launch();
        return this.get(request, projectId, id);
    }
    private async advance(row: IReindexRow): Promise<void> {
        if (this.running.has(row.id)) return;
        this.running.add(row.id);
        try {
            await this.models.resolveProject(this.request(row), row.project_id, 3);
            await requireFeaturesEnabled(['rag_sync']);
            let receipt: IGenerationReceipt;
            try {
                receipt = await this.coordinator.client.call<IGenerationReceipt>(
                    `generations/${row.id}?projectId=${encodeURIComponent(row.project_id)}`,
                );
            } catch (error) {
                if (
                    !(error instanceof NotFoundException) &&
                    !(
                        error &&
                        typeof error === 'object' &&
                        'getStatus' in error &&
                        typeof error.getStatus === 'function' &&
                        error.getStatus() === 404
                    )
                )
                    throw error;
                receipt = await this.coordinator.client.call<IGenerationReceipt>('generations', {
                    projectId: row.project_id,
                    id: row.id,
                    sourceGeneration: row.data.context.generation,
                    profile: row.data.profile,
                    sourceSnapshot: row.data.sourceSnapshot,
                });
            }
            this.assertReceipt(row, receipt);
            if (receipt.state === 'building') {
                await this.coordinator.client.call(`generations/${row.id}/build`, { projectId: row.project_id });
                await this.models.pool.query(
                    "UPDATE project_reindex_plans SET progress=$2,message=$3,updated_at=now() WHERE id=$1 AND state='building'",
                    [
                        row.id,
                        receipt.rowCount ? Math.floor((100 * receipt.processedRows) / receipt.rowCount) : 0,
                        `Перестроено ${receipt.processedRows} из ${receipt.rowCount} фрагментов.`,
                    ],
                );
            } else if (receipt.state === 'ready') {
                await this.models.pool.query(
                    "UPDATE project_reindex_plans SET state='ready',progress=100,message='Новое поколение проверено.',updated_at=now() WHERE id=$1 AND state='building'",
                    [row.id],
                );
                if (row.approved) {
                    await this.promote(row, receipt);
                    await this.enqueue(row);
                }
            } else if (receipt.state === 'failed' || receipt.state === 'cancelled') {
                // Background build failure is retryable; cancellation keeps its durable tombstone.
                const message =
                    receipt.state === 'failed'
                        ? 'Переиндексация прервана. Действующий индекс сохранён. Проверьте модель и доступное место, затем повторите.'
                        : 'Переиндексация отменена. Действующий индекс сохранён.';
                await this.models.pool.query(
                    "UPDATE project_reindex_plans SET state=$2,message=$3,updated_at=now() WHERE id=$1 AND state IN ('building','ready')",
                    [row.id, receipt.state, message],
                );
            } else throw new ConflictException('Построение остановлено. Действующий индекс сохранён.');
        } catch (error) {
            await this.fail(row.id, error);
        } finally {
            this.running.delete(row.id);
        }
    }
    private assertReceipt(row: IReindexRow, value: IGenerationReceipt): void {
        if (
            value.id !== row.id ||
            value.projectId !== row.project_id ||
            value.sourceGeneration !== row.data.context.generation ||
            value.sourceSnapshot !== row.data.sourceSnapshot ||
            value.rowCount !== row.data.rowCount ||
            ragRequestHash(value.profile) !== ragRequestHash(row.data.profile) ||
            (value.state === 'ready' &&
                (!sha(value.receiptHash) || !sha(value.snapshotHash) || value.processedRows !== value.rowCount))
        )
            throw new ConflictException('Поколение не совпало с подтверждённым планом.');
    }
    private async promote(row: IReindexRow, receipt: IGenerationReceipt): Promise<void> {
        const db = await this.models.pool.connect();
        try {
            await db.query('BEGIN');
            await db.query("SELECT pg_advisory_xact_lock(hashtextextended('asset-management:model:'||$1,0))", [
                row.data.modelId,
            ]);
            await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [row.project_id]);
            const saved = await db.query<IReindexRow>('SELECT * FROM project_reindex_plans WHERE id=$1 FOR UPDATE', [
                row.id,
            ]);
            if (saved.rows[0].state === 'applied') {
                await db.query('COMMIT');
                return;
            }
            if (saved.rows[0].state !== 'ready' || !saved.rows[0].approved)
                throw new ConflictException('Переключение поколения отменено.');
            await this.models.resolveProject(this.request(row), row.project_id, 3);
            await this.coordinator.requireIdle(db, row.project_id);
            const current = await this.coordinator.context(row.project_id, db);
            if (ragRequestHash(current) !== ragRequestHash(row.data.context))
                throw new ConflictException('Исходный индекс или выбор модели изменились во время сборки.');
            await this.target(db, row.project_id, row.data.modelId, row.data.modelPin);
            const source = await this.coordinator.client.call<{ hash: string }>('source', {
                projectId: row.project_id,
                generation: current.generation,
            });
            if (source.hash !== row.data.sourceSnapshot)
                throw new ConflictException('Исходные знания изменились во время сборки. Подготовьте новый план.');
            const verified = await this.coordinator.client.call<IGenerationReceipt>(
                `generations/${row.id}?projectId=${encodeURIComponent(row.project_id)}`,
            );
            this.assertReceipt(row, verified);
            if (verified.state !== 'ready' || verified.receiptHash !== receipt.receiptHash)
                throw new ConflictException('Готовое поколение изменилось.');
            const revision = current.revision + 1,
                dataRevision = current.dataRevision + 1;
            if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(dataRevision))
                throw new ConflictException('Ревизия индекса превышает допустимый диапазон.');
            await db.query(
                `INSERT INTO project_embedding_settings(project_id,revision,model_id,model_pin,dimension,updated_by,active_generation,active_snapshot,data_revision)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(project_id) DO UPDATE SET revision=EXCLUDED.revision,model_id=EXCLUDED.model_id,
                model_pin=EXCLUDED.model_pin,dimension=EXCLUDED.dimension,updated_by=EXCLUDED.updated_by,active_generation=EXCLUDED.active_generation,
                active_snapshot=EXCLUDED.active_snapshot,data_revision=EXCLUDED.data_revision,updated_at=now()`,
                [
                    row.project_id,
                    revision,
                    row.data.modelId,
                    row.data.modelPin,
                    row.data.profile.dimension,
                    row.actor,
                    row.id,
                    receipt.snapshotHash,
                    dataRevision,
                ],
            );
            await securityEvent(db, {
                actor: row.actor,
                action: 'project.embedding.reindex',
                resourceId: row.project_id,
                before: current,
                after: {
                    revision,
                    generation: row.id,
                    modelId: row.data.modelId,
                    modelPin: row.data.modelPin,
                    dimension: row.data.profile.dimension,
                    snapshot: receipt.snapshotHash,
                },
            });
            await db.query(
                "UPDATE project_reindex_plans SET state='applied',message='Модель и индекс проекта переключены.',updated_at=now() WHERE id=$1",
                [row.id],
            );
            await db.query('COMMIT');
        } catch (error) {
            await db.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            db.release();
        }
    }
    async cancel(request: Request, projectId: string, id: string): Promise<IProjectReindexPlan> {
        const row = await this.owned(request, projectId, id, 3),
            db = await this.models.pool.connect();
        try {
            await db.query('BEGIN');
            await db.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [row.project_id]);
            const saved = await db.query<{ state: string }>(
                'SELECT state FROM project_reindex_plans WHERE id=$1 FOR UPDATE',
                [id],
            );
            if (saved.rows[0]?.state === 'applied')
                throw new ConflictException('Применённый план переиндексации нельзя отменить.');
            const current = await this.coordinator.context(row.project_id, db);
            if (current.generation === row.id)
                throw new ConflictException('Активное поколение нельзя удалить отменой плана.');
            await db.query(
                "UPDATE project_reindex_plans SET state='cancelling',message='Останавливаем переиндексацию. Действующий индекс сохранён.',updated_at=now() WHERE id=$1 AND state NOT IN ('applied','cancelled')",
                [id],
            );
            await db.query('COMMIT');
        } catch (error) {
            await db.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            db.release();
        }
        await this.cleanup(row).catch(() => undefined);
        return this.get(request, projectId, id);
    }
    private async cleanup(row: IReindexRow): Promise<void> {
        await this.coordinator.client.call(`generations/${row.id}/cancel`, {
            projectId: row.project_id,
            profile: row.data.profile,
            sourceGeneration: row.data.context.generation,
            sourceSnapshot: row.data.sourceSnapshot,
        });
        await this.models.pool.query(
            "UPDATE project_reindex_plans SET state='cancelled',message='Переиндексация отменена. Действующий индекс сохранён.',updated_at=now() WHERE id=$1 AND state='cancelling'",
            [row.id],
        );
    }
    async retry(request: Request, projectId: string, id: string): Promise<IProjectReindexPlan> {
        const row = await this.owned(request, projectId, id, 3);
        if (row.state !== 'failed') throw new ConflictException('Повтор доступен только для прерванного плана.');
        await requireFeaturesEnabled(['rag_sync']);
        if (row.data.sourceSnapshot) {
            await this.coordinator.client
                .call(`generations/${id}/retry`, { projectId: row.project_id })
                .catch((error) => {
                    if (error?.getStatus?.() !== 404) throw error;
                });
        }
        await this.models.pool.query(
            "UPDATE project_reindex_plans SET state=$2,message='Повторяем незавершённую операцию.',updated_at=now() WHERE id=$1 AND state='failed'",
            [id, row.data.sourceSnapshot ? 'building' : 'preparing'],
        );
        this.launch();
        return this.get(request, projectId, id);
    }
    async embed(value: {
        projectId: string;
        planId: string;
        profile: unknown;
        input: string[];
    }): Promise<{ embeddings: unknown }> {
        const found = await this.models.pool.query<IReindexRow>(
                'SELECT * FROM project_reindex_plans WHERE id=$1 AND project_id=$2',
                [value.planId, value.projectId],
            ),
            row = found.rows[0];
        if (
            !row ||
            row.state !== 'building' ||
            !row.approved ||
            ragRequestHash(row.data.profile) !== ragRequestHash(value.profile)
        )
            throw new ForbiddenException('План не разрешает embedding-запрос.');
        if (
            !Array.isArray(value.input) ||
            !value.input.length ||
            value.input.length > 32 ||
            value.input.some((text) => typeof text !== 'string' || !text.trim()) ||
            Buffer.byteLength(JSON.stringify(value.input)) > 256 * 1024
        )
            throw new BadRequestException('Некорректный батч переиндексации.');
        await this.models.resolveProject(this.request(row), row.project_id, 3);
        if (!(await this.models.isAssigned(row.project_id, row.data.modelId)))
            throw new ConflictException('Модель больше не назначена этому проекту.');
        await requireFeaturesEnabled(['rag_sync', 'model_hosting']);
        const model = await readPinnedModel(this.models.pool, row.data.modelId, row.data.modelPin);
        if (!model) throw new ConflictException('Закреплённая модель недоступна.');
        const signal = AbortSignal.timeout(105000),
            beforeInference = async () => {
                signal.throwIfAborted();
                const current = (
                    await this.models.pool.query<IReindexRow>(
                        'SELECT * FROM project_reindex_plans WHERE id=$1 AND project_id=$2',
                        [row.id, row.project_id],
                    )
                ).rows[0];
                if (
                    !current ||
                    current.state !== 'building' ||
                    !current.approved ||
                    ragRequestHash(current.data.profile) !== ragRequestHash(value.profile) ||
                    current.data.modelId !== row.data.modelId ||
                    current.data.modelPin !== row.data.modelPin
                )
                    throw new ConflictException('Переиндексация отменена или её профиль изменился.');
                await this.models.resolveProject(this.request(current), current.project_id, 3);
                if (
                    !(await this.models.isAssigned(current.project_id, current.data.modelId)) ||
                    !(await readPinnedModel(this.models.pool, current.data.modelId, current.data.modelPin))
                )
                    throw new ConflictException('Закреплённая модель недоступна.');
                signal.throwIfAborted();
            };
        const result = await withModelUsage(
            {
                purpose: 'reindex',
                actorEmail: row.actor,
                actorRole: row.active_role,
                projectId: row.project_id,
                operationId: row.id,
                requiredFeatures: ['rag_sync'],
                beforeInference,
            },
            () => this.runtime.infer(model, 'embed', { input: value.input, truncate: false }, signal),
        );
        const current = await this.models.pool.query('SELECT state FROM project_reindex_plans WHERE id=$1', [row.id]);
        if (current.rows[0]?.state !== 'building') throw new ConflictException('Переиндексация отменена.');
        await this.models.resolveProject(this.request(row), row.project_id, 3);
        return { embeddings: result.embeddings };
    }
    private async fail(id: string, error: unknown): Promise<void> {
        const stale = error instanceof HttpException && error.getStatus() === 409;
        const message =
            error instanceof HttpException && error.getStatus() === 413
                ? 'Недостаточно места в лимите базы знаний. Увеличьте лимит и повторите; действующий индекс сохранён.'
                : stale
                  ? 'План устарел или исходный индекс изменился. Действующий индекс сохранён.'
                  : 'Переиндексация прервана. Действующий индекс сохранён.';
        await this.models.pool.query(
            "UPDATE project_reindex_plans SET state=$2,message=$3,updated_at=now() WHERE id=$1 AND state IN ('preparing','building','ready')",
            [id, stale ? 'stale' : 'failed', message],
        );
    }
    private async recover(): Promise<void> {
        const pending = await this.models.pool.query<IReindexRow>(
            "SELECT * FROM project_reindex_plans WHERE state IN ('preparing','building','ready','cancelling') OR state='applied' AND data ? 'connection' AND connection_job_id IS NULL AND connection_error IS NULL ORDER BY created_at LIMIT 10",
        );
        for (const row of pending.rows) {
            if (row.state === 'preparing') await this.prepare(row);
            else if (row.state === 'cancelling') await this.cleanup(row).catch(() => undefined);
            else if (row.state === 'applied') await this.enqueue(row);
            else await this.advance(row);
        }
    }
}
