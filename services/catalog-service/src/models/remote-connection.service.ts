import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { visionFixture } from '../../../shared/vision-fixture.cjs';
import type { IModel } from './model.types';
import type { IModelHosting } from './hosting.types';
import { ModelsService } from './models.service';
import { RemoteConnectionRepository } from './remote-connection.repository';
import { RemoteModelClient, RemoteModelError } from './remote-model-client';
import { remoteConnectionInput, remoteVerificationDigest } from './remote-model-validation';
import { isRemoteModel } from './remote-model.types';
import { notifyModelCatalogChange } from './model-events';
import { ModelUsageService } from '../model-usage/model-usage.service';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { withModelUsage, currentModelUsage } from '../model-usage/model-usage.context';
import { ModelApiAdmission } from '../model-api-admission/model-api-admission';

/** Все запросы провайдеру выполняются сервером; bridge получает только Gateway API и project pin. */
@Injectable()
export class RemoteConnectionService {
    readonly repository: RemoteConnectionRepository;
    private readonly client: RemoteModelClient;
    constructor(private readonly models: ModelsService, private readonly usage?: ModelUsageService, admission?: ModelApiAdmission) {
        this.repository = new RemoteConnectionRepository(models.pool); this.client = new RemoteModelClient({ admission });
    }
    private async remote(id: string): Promise<IModel> {
        const model = await this.models.get(id);
        if (!isRemoteModel(model)) throw new BadRequestException('Выберите модель удалённого API.');
        return model;
    }
    async read(id: string) { const model = await this.remote(id); return this.repository.view(id, await this.repository.head(id), model.revision); }
    async save(id: string, value: unknown, actor: string, authorize: () => Promise<unknown>) {
        await this.remote(id);
        const saved = await this.repository.save(id, remoteConnectionInput(value), actor, authorize);
        await notifyModelCatalogChange(); return saved;
    }
    async revoke(id: string, value: unknown, actor: string, authorize: () => Promise<unknown>): Promise<{ ok: true }> {
        await this.remote(id);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Передайте ревизии подключения и модели.');
        const body = value as Record<string, unknown>;
        if (Object.keys(body).some(key => !['expectedRevision', 'expectedModelRevision'].includes(key))
            || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1
            || !Number.isSafeInteger(body.expectedModelRevision) || Number(body.expectedModelRevision) < 1) throw new BadRequestException('Передайте актуальные ревизии подключения и модели.');
        await this.repository.revoke(id, Number(body.expectedModelRevision), Number(body.expectedRevision), actor, authorize);
        await notifyModelCatalogChange(); return { ok: true };
    }
    async status(model: IModel): Promise<IModelHosting> {
        const row = await this.repository.head(model.id);
        if (!row || row.revoked_at) return { state: 'unavailable', message: 'Настройте подключение удалённого API.', checkedAt: null };
        const view = this.repository.view(model.id, row, model.revision);
        try { this.repository.connection(row); }
        catch (cause) { return { state: 'unavailable', message: cause instanceof ServiceUnavailableException ? cause.message : 'Ключ подключения недоступен.', checkedAt: null }; }
        if (row.credential_kind !== 'none' && !view.hasKey) return { state: 'unavailable', message: 'Нужен API-ключ подключения. Обратитесь к главному администратору.', checkedAt: null };
        if (row.failure_message) return { state: 'error', message: row.failure_message, checkedAt: view.checkedAt };
        if (!row.semantic_sha || row.semantic_sha !== model.verificationSha256) return { state: 'stopped', message: 'Подключение сохранено. Выполните проверку модели перед использованием.', checkedAt: null };
        return { state: 'ready', message: 'Подключение проверено. Текущая доступность подтверждается каждым запросом.', checkedAt: view.checkedAt };
    }
    /** Probe закрепляет фактическую размерность и конфигурацию только после повторной проверки прав и CAS. */
    async check(model: IModel, actor: string, authorize: () => Promise<unknown>, signal?: AbortSignal): Promise<void> {
        const row = await this.repository.head(model.id);
        if (!row || row.revoked_at) throw new ConflictException('Сначала настройте подключение удалённого API.');
        const connection = this.repository.connection(row);
        try {
            const infer = async (signal?: AbortSignal) => {
                // The usage reservation can wait; admit this new paid probe after that wait.
                signal?.throwIfAborted(); await authorize(); signal?.throwIfAborted();
                await requireFeaturesEnabled(['model_hosting'], process.env, globalThis.fetch, signal); signal?.throwIfAborted();
                return model.capability === 'embedding'
                    ? await this.client.infer(model, connection, 'embed', { input: ['Проверка поиска по проекту.', 'Project knowledge search.'] }, signal)
                    : await this.client.infer(model, connection, 'chat', { messages: [{ role: 'user', content: model.capability === 'vision'
                        ? 'Read the digits at the top and the color of the square. Return only JSON with string fields number and color in lowercase English.' : 'Reply with the word OK.',
                        ...(model.capability === 'vision' ? { images: [visionFixture().toString('base64')] } : {}) }],
                        options: { num_predict: connection.options?.apiFormat === 'responses' || connection.options?.tokenLimitParameter === 'max_completion_tokens'
                            ? connection.options.maxOutputTokens ?? 64 : Math.min(connection.options?.maxOutputTokens ?? 64, 64) } }, signal);
            };
            await requireFeaturesEnabled(['model_hosting']); signal?.throwIfAborted();
            const beforeInference = async () => {
                signal?.throwIfAborted(); await authorize();
                const current = await this.repository.head(model.id);
                if (!current || current.revoked_at || Number(current.revision) !== Number(row.revision)) throw new ConflictException('Подключение модели изменилось. Повторите проверку.');
                signal?.throwIfAborted();
            };
            const result = await withModelUsage({ purpose: 'verification', actorEmail: actor, beforeInference }, () => this.usage ? this.usage.observe(model, model.capability === 'embedding' ? 'embed' : 'chat', infer, signal) : infer(signal));
            if (model.capability === 'vision') {
                let observed: Record<string, unknown>;
                try { observed = JSON.parse((result.message as { content: string }).content); } catch { throw new RemoteModelError('response', 'Модель не распознала тестовое изображение.'); }
                if (!observed || observed.number !== '42' || observed.color !== 'red') throw new RemoteModelError('response', 'Модель неверно распознала тестовое изображение.');
            }
            signal?.throwIfAborted();
            if (model.capability !== 'embedding' && result.done_reason !== 'stop') throw new RemoteModelError('response', 'Модель не завершила проверочный ответ.');
            const dimension = model.capability === 'embedding' ? (result.embeddings as number[][])[0].length : null;
            const digest = remoteVerificationDigest(model, connection, dimension);
            await this.repository.verify(model, connection.revision, digest, dimension, actor, async () => { signal?.throwIfAborted(); await authorize(); signal?.throwIfAborted(); });
            await notifyModelCatalogChange();
        } catch (cause) {
            if (cause instanceof RemoteModelError) await this.repository.failure(row, cause.message).catch(() => undefined);
            throw cause;
        }
    }
    async infer(model: IModel, endpoint: 'embed' | 'chat', body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
        const row = await this.repository.pinned(model);
        try {
            const context = currentModelUsage(), inherited = context.beforeInference;
            const beforeInference = async () => {
                await inherited?.(); signal?.throwIfAborted();
                const fresh = await this.repository.pinned(model);
                if (Number(fresh.revision) !== Number(row.revision)) throw new ConflictException('Подключение модели изменилось. Повторите действие.');
                signal?.throwIfAborted();
            };
            const result = await withModelUsage({ purpose: context.purpose, beforeInference }, () => this.client.infer(model, this.repository.connection(row), endpoint, body, signal));
            signal?.throwIfAborted();
            const current = await this.repository.pinned(model);
            if (Number(current.revision) !== Number(row.revision)) throw new ConflictException('Подключение модели изменилось во время запроса. Повторите действие.');
            await this.repository.failure(row, null).catch(() => undefined);
            return result;
        } catch (cause) {
            signal?.throwIfAborted();
            if (cause instanceof RemoteModelError) {
                await this.repository.failure(row, cause.message).catch(() => undefined);
                throw new ServiceUnavailableException(cause.message);
            }
            throw cause;
        }
    }
}
