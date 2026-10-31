import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    Inject,
    Injectable,
    NotFoundException,
    OnApplicationShutdown,
    OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { normalizeLearningAnalysisInput, type LearningAnalysisInput } from '../../../shared/project-learning.cjs';
import { ModelsService } from '../models/models.service';
import { ModelRuntime, type IModelInferenceRuntime } from '../models/model-runtime';
import { projectEmbeddingPin } from '../models/project-embedding.validation';
import { createPool } from '../database/pool';
import { LearningService } from './learning.service';
import { requireLearningHuman } from './learning-access';
import { analysisView, type AnalysisRow, type LearningAnalysis } from './learning-analysis.types';
import { analysisRequestHash, LearningAnalysisRepository } from './learning-analysis.repository';
import { learningAnalysisHypotheses, learningAnalysisMessages } from './learning-analysis-prompt';
import { withModelUsage } from '../model-usage/model-usage.context';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';

const uuid = (value: string): string => {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value))
        throw new BadRequestException('Некорректный идентификатор анализа.');
    return value;
};
/** A persistent job makes lost HTTP replies observable without starting inference again. */
@Injectable()
export class LearningAnalysisService implements OnModuleInit, OnApplicationShutdown {
    readonly pool = createPool(
        { connectionString: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog', max: 4 },
        'learning-analyses',
    );
    readonly repository = new LearningAnalysisRepository(this.pool);
    private readonly workerId = randomUUID();
    private stopped = false;
    private initialized = false;
    private timer: NodeJS.Timeout | undefined;
    private pending: Promise<void> | undefined;
    private abort: AbortController | undefined;
    constructor(
        private readonly learning: LearningService,
        private readonly models: ModelsService,
        @Inject(ModelRuntime) private readonly runtime: IModelInferenceRuntime,
    ) {}
    async onModuleInit(): Promise<void> {
        await this.models.ready();
        this.initialized = true;
        this.schedule(0);
    }
    async onApplicationShutdown(): Promise<void> {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
        this.abort?.abort();
        await this.pending?.catch(() => undefined);
        await this.pool.end();
    }
    private schedule(delay = 2000): void {
        if (!this.initialized || this.stopped || this.timer || this.pending) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.pending = this.work()
                .catch(() => undefined)
                .finally(() => {
                    this.pending = undefined;
                    this.schedule();
                });
        }, delay);
        this.timer.unref();
    }
    private async scope(req: Request, id: string, level = 1) {
        requireLearningHuman(req);
        const actor = await this.models.actor(req),
            project = await this.models.resolveProject(req, id, level, actor);
        return { actor, projectId: project.id };
    }
    async get(req: Request, id: string, analysisId: string): Promise<LearningAnalysis> {
        const scope = await this.scope(req, id);
        return analysisView(await this.repository.get(scope.projectId, uuid(analysisId)));
    }
    async byKey(req: Request, id: string, key: string): Promise<LearningAnalysis> {
        const scope = await this.scope(req, id),
            row = await this.repository.byKey(scope.projectId, scope.actor.email, uuid(key));
        if (!row) throw new NotFoundException('Запрос анализа ещё не зарегистрирован.');
        return analysisView(row);
    }
    async create(req: Request, id: string, raw: unknown): Promise<LearningAnalysis> {
        requireLearningHuman(req);
        let input: LearningAnalysisInput;
        try {
            input = normalizeLearningAnalysisInput(raw);
        } catch {
            throw new BadRequestException('Выберите модель, источники опыта и актуальную ревизию проекта.');
        }
        if (!input.modelId) throw new BadRequestException('Выберите назначенную проекту диалоговую модель.');
        const scope = await this.scope(req, id, 2),
            previous = await this.repository.byKey(scope.projectId, scope.actor.email, input.requestKey);
        if (previous) {
            if (previous.request_hash !== analysisRequestHash(scope.projectId, input))
                throw new ConflictException('Ключ запроса уже относится к другому анализу.');
            return analysisView(previous);
        }
        await requireFeaturesEnabled(['project_learning', 'model_hosting']);
        const snapshot = await this.learning.analysisInput(req, scope.projectId, input),
            model = await this.usableModel(req, scope.projectId, input.modelId);
        learningAnalysisMessages(snapshot.experiences);
        await requireFeaturesEnabled(['project_learning', 'model_hosting']);
        const row = await this.repository.enqueue(snapshot, input, projectEmbeddingPin(model));
        this.schedule(0);
        return analysisView(row);
    }
    private async usableModel(req: Request, id: string, modelId: string) {
        const model = await this.models.getUsable(modelId, req, id);
        if (model.archivedAt || !['chat', 'vision'].includes(model.capability))
            throw new BadRequestException('Нужна доступная диалоговая модель, назначенная этому проекту.');
        return model;
    }
    private workerRequest(row: AnalysisRow): Request {
        return {
            headers: {
                'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '',
                'x-bridge-actor': encodeURIComponent(
                    JSON.stringify({ email: row.actor_email, activeRole: row.actor_role }),
                ),
            },
        } as unknown as Request;
    }
    private async work(): Promise<void> {
        await this.repository.recoverExpired();
        if (this.stopped) return;
        const row = await this.repository.claim(this.workerId);
        if (!row) return;
        const abort = new AbortController();
        this.abort = abort;
        if (this.stopped) abort.abort();
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(95000)]),
            req = this.workerRequest(row);
        let committed: string[] | undefined,
            mutationAttempted = false;
        try {
            await this.repository.current(row);
            signal.throwIfAborted();
            const model = await this.usableModel(req, row.project_id, row.model_id);
            if (projectEmbeddingPin(model) !== row.model_pin)
                throw new ConflictException('Выбранная модель изменилась.');
            await requireFeaturesEnabled(['project_learning', 'model_hosting']);
            signal.throwIfAborted();
            const beforeInference = async () => {
                await this.repository.current(row);
                signal.throwIfAborted();
                const fresh = await this.usableModel(req, row.project_id, row.model_id);
                if (projectEmbeddingPin(fresh) !== row.model_pin)
                    throw new ConflictException('Выбранная модель изменилась.');
                signal.throwIfAborted();
            };
            const result = await withModelUsage(
                {
                    purpose: 'learning',
                    actorEmail: row.actor_email,
                    actorRole: row.actor_role,
                    projectId: row.project_id,
                    operationId: row.id,
                    beforeInference,
                },
                () =>
                    this.runtime.infer(
                        model,
                        'chat',
                        {
                            messages: learningAnalysisMessages(row.experiences),
                            think: false,
                            options:
                                model.runtime === 'ollama' ? { temperature: 0, num_predict: 2048, num_ctx: 8192 } : {},
                        },
                        signal,
                    ),
            );
            signal.throwIfAborted();
            const current = await this.usableModel(req, row.project_id, row.model_id);
            if (projectEmbeddingPin(current) !== row.model_pin)
                throw new ConflictException('Выбранная модель изменилась во время анализа.');
            const hypotheses = learningAnalysisHypotheses(result, row.input.experienceIds);
            mutationAttempted = true;
            const saved = await this.learning.recordAnalysis(
                req,
                row.project_id,
                {
                    requestKey: row.mutation_key,
                    expectedRevision: Number(row.source_revision),
                    hypotheses,
                    model: { modelId: row.model_id, modelPin: row.model_pin, analysisId: row.id },
                },
                (db) => this.repository.authorizeResult(db, row),
            );
            committed = saved.result.hypotheses.map((item) => item.id);
            await this.repository.complete(row, committed);
        } catch (cause) {
            if (committed) {
                await this.repository.complete(row, committed).catch(() => undefined);
                return;
            }
            if (mutationAttempted) {
                try {
                    if (await this.repository.reconcile(row)) return;
                } catch {
                    return;
                }
            }
            const interrupted = signal.aborted;
            const status = cause instanceof HttpException ? cause.getStatus() : 503;
            const denied = status === 403 || status === 404;
            const disabled = cause instanceof ForbiddenException && cause.message.startsWith('Функция «');
            const conflict = status === 409;
            await this.repository.fail(
                row,
                interrupted ? 'unknown' : 'failed',
                interrupted
                    ? 'ANALYSIS_INTERRUPTED'
                    : disabled
                      ? 'FEATURE_DISABLED'
                      : denied
                        ? 'ACCESS_CHANGED'
                        : conflict
                          ? 'SOURCE_CHANGED'
                          : 'MODEL_FAILED',
                interrupted
                    ? 'Анализ прерван. Неизвестный результат не запускает модель повторно.'
                    : disabled
                      ? cause.message
                      : denied
                        ? 'Доступ к проекту или модели изменился.'
                        : conflict
                          ? 'Модель или привязка анализа изменились. Создайте новый анализ.'
                          : 'Модель не вернула полный проверяемый результат. Проверьте подключение и доступность модели.',
            );
        } finally {
            if (this.abort === abort) this.abort = undefined;
        }
    }
}
