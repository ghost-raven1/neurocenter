import {requireFeaturesEnabled} from '../features/require-feature-enabled';
import { BadRequestException, ConflictException, Injectable, Logger, Optional, type OnModuleInit, type BeforeApplicationShutdown } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AccessDb } from '../access/access-db';
import { ModelsService } from './models.service';
import { OllamaClient } from './ollama-client';
import { ModelHostingRepository } from './hosting.repository';
import { hostingOperation, type HostingAction, type IHostingJobRow, type IHostingProgress, type IModelHosting } from './hosting.types';
import type { IModel } from './model.types';
import { RemoteConnectionService } from './remote-connection.service';
import { isRemoteModel } from './remote-model.types';
import { ModelBundleRuntime } from './model-bundle-runtime';
import { withModelUsage } from '../model-usage/model-usage.context';
import { projectEmbeddingPin } from './project-embedding.validation';

const lock = "hashtextextended('neurocenter:model-hosting',0)";
const actions: readonly string[] = ['start', 'stop', 'check'];

/** Один исполнитель на общий runtime; процесс HTTP не держит открытый запрос до конца загрузки. */
@Injectable()
export class ModelHostingService implements OnModuleInit, BeforeApplicationShutdown {
    private readonly logger = new Logger(ModelHostingService.name);
    private readonly repository: ModelHostingRepository;
    private active?: { abort: AbortController; work: Promise<void> };
    private readonly starting = new Set<Promise<void>>();
    private stopping = false;

    constructor(private readonly models: ModelsService, private readonly access: AccessDb, private readonly runtime: OllamaClient,
        @Optional() private readonly remote?: RemoteConnectionService, @Optional() private readonly bundles?: ModelBundleRuntime) {
        this.repository = new ModelHostingRepository(models.pool);
    }

    async onModuleInit(): Promise<void> {
        await this.models.ready();
        const client = await this.models.pool.connect();
        let discard = false;
        const disconnected = () => { discard = true; };
        client.on('error', disconnected);
        try {
            if ((await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${lock}) AS locked`)).rows[0].locked) {
                try {
                    if (discard) { throw new Error('Потеряна управляющая блокировка хостинга.'); }
                    await this.repository.interruptStale(client);
                    if (discard) { throw new Error('Потеряна управляющая блокировка хостинга.'); }
                }
                finally { await client.query(`SELECT pg_advisory_unlock(${lock})`); }
            }
        } catch (error) { discard = true; throw error; }
        finally { client.removeListener('error', disconnected); client.release(discard); }
    }

    async beforeApplicationShutdown(): Promise<void> {
        this.stopping = true;
        this.active?.abort.abort(new Error('Сервис перезапускается. Повторите управление моделью после запуска.'));
        await Promise.allSettled([...this.starting]);
        this.active?.abort.abort(new Error('Сервис перезапускается. Повторите управление моделью после запуска.'));
        await this.active?.work;
    }

    async status(model: IModel): Promise<IModelHosting> {
        const latest = await this.currentJob(model.id);
        if (latest?.state === 'running') {
            return { state: 'busy', message: latest.message, checkedAt: await this.repository.checkedAt(model.id), operation: hostingOperation(latest) };
        }
        if (isRemoteModel(model)) {
            if (!this.remote) throw new Error('Сервис удалённых подключений не зарегистрирован.');
            const current = await this.remote.status(model);
            return { ...current, ...(latest ? { operation: hostingOperation(latest) } : {}) };
        }
        const current = await this.runtime.status(model).catch(() => ({ state: 'unavailable' as const, message: 'Хостинг моделей недоступен или отключён администратором сервера.', checkedAt: null }));
        return { ...current, checkedAt: current.state === 'ready' || current.state === 'stopped' ? await this.repository.checkedAt(model.id) : null,
            ...(latest ? { operation: hostingOperation(latest) } : {}) };
    }

    /** Свободная общая lock доказывает отсутствие исполнителя; восстановление не запускает модель повторно. */
    private async currentJob(modelId: string): Promise<IHostingJobRow | undefined> {
        let latest = await this.repository.latest(modelId);
        if (latest?.state !== 'running') { return latest; }
        const lease = await this.models.pool.connect();
        let locked = false, discard = false;
        const disconnected = () => { discard = true; };
        const assertConnected = () => { if (discard) { throw new Error('Потеряно соединение проверки хостинга. Повторите проверку состояния.'); } };
        lease.on('error', disconnected);
        try {
            try { locked = (await lease.query<{locked: boolean}>(`SELECT pg_try_advisory_lock(${lock}) AS locked`)).rows[0].locked; }
            catch (error) { discard = true; throw error; }
            assertConnected();
            if (locked) {
                await this.repository.interruptStale(lease);
                assertConnected();
                latest = await this.repository.latest(modelId);
                assertConnected();
            }
            return latest;
        } finally {
            try { if (locked && !discard) { await lease.query(`SELECT pg_advisory_unlock(${lock})`); } }
            catch (error) { discard = true; throw error; }
            finally { lease.removeListener('error', disconnected); lease.release(discard); }
        }
    }

    async control(id: string, input: unknown, actor: string): Promise<IModelHosting> {
        let finished!: () => void;
        const pending = new Promise<void>(resolve => { finished = resolve; });
        this.starting.add(pending);
        try { return await this.begin(id, input, actor); }
        finally { finished(); this.starting.delete(pending); }
    }

    private async begin(id: string, input: unknown, actor: string): Promise<IModelHosting> {
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || !('action' in input) || typeof input.action !== 'string' || !actions.includes(input.action)
            || !('expectedRevision' in input) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) {
            throw new BadRequestException('Укажите действие и актуальную ревизию модели.');
        }
        if (this.stopping) { throw new ConflictException('Сервис перезапускается. Повторите действие после запуска.'); }
        const action = input.action as HostingAction;
        const model = await this.models.get(id);
        if (model.revision !== input.expectedRevision) { throw new ConflictException('Карточка модели изменилась. Обновите каталог.'); }
        if (model.archivedAt) throw new ConflictException('Модель убрана из общего каталога. Существующие подключения сохранены.');
        if (isRemoteModel(model) && action !== 'check') throw new BadRequestException('Для удалённого API доступна проверка подключения. Управление процессом выполняется у провайдера.');
        const lease = await this.models.pool.connect();
        let transferred = false, locked = false, released = false, discard = false;
        const disconnected = () => { discard = true; };
        const assertConnected = () => { if (discard) { throw new Error('Потеряна управляющая блокировка хостинга. Повторите действие.'); } };
        lease.on('error', disconnected);
        try {
            try { locked = (await lease.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${lock}) AS locked`)).rows[0].locked; }
            catch (error) { discard = true; throw error; }
            assertConnected();
            if (!locked) {
                lease.removeListener('error', disconnected); lease.release(false); released = true;
                const running = await this.repository.latest(id);
                if (running?.state === 'running' && running.action === action) {
                    return {state: 'busy', message: running.message, checkedAt: await this.repository.checkedAt(id), operation: hostingOperation(running)};
                }
                throw new ConflictException('Управление другой моделью уже выполняется. Дождитесь завершения операции.');
            }
            await this.repository.interruptStale(lease);
            assertConnected();
            const current = await this.models.get(id);
            if (current.revision !== input.expectedRevision) { throw new ConflictException('Карточка модели изменилась. Обновите каталог.'); }
            if (this.stopping) { throw new ConflictException('Сервис перезапускается. Повторите действие после запуска.'); }
            if(action!=='stop')await requireFeaturesEnabled(['model_hosting']);
            const row = await this.repository.create(lease, id, action, actor);
            const abort = new AbortController();
            if (this.stopping) { abort.abort(new Error('Сервис перезапускается. Повторите действие после запуска.')); }
            const work = this.execute(lease, current, row, abort).catch(() => { this.logger.error('Исполнитель хостинга завершился. Повторите действие после проверки состояния.'); });
            this.active = { abort, work };
            transferred = true;
            void work.finally(() => { if (this.active?.work === work) { this.active = undefined; } });
            return { state: 'busy', message: row.message, checkedAt: await this.repository.checkedAt(id), operation: hostingOperation(row) };
        } finally {
            if (!transferred && !released) {
                try { if (locked && !discard) { await lease.query(`SELECT pg_advisory_unlock(${lock})`); } }
                catch (error) { discard = true; throw error; }
                finally { lease.removeListener('error', disconnected); lease.release(discard); }
            } else { lease.removeListener('error', disconnected); }
        }
    }

    private async execute(lease: PoolClient, model: IModel, row: IHostingJobRow, abort: AbortController): Promise<void> {
        let connectionLost = false, checkingAccess = false;
        const disconnected = () => { connectionLost = true; abort.abort(new Error('Потеряна управляющая блокировка. Повторите действие.')); };
        lease.on('error', disconnected);
        const deadline = setTimeout(() => abort.abort(new Error('Подготовка превысила 30 минут. Повторите действие; сохранённые веса используются повторно.')), 30 * 60 * 1000);
        const watchdog = setInterval(() => {
            if (checkingAccess || abort.signal.aborted) { return; }
            checkingAccess = true;
            void this.access.claims(row.actor).then(claims => {
                if (!claims.userRoles.includes('Главный админ')) { abort.abort(new Error('Права управления хостингом отозваны. Операция остановлена.')); }
            }).catch(() => abort.abort(new Error('Не удалось подтвердить права управления. Операция остановлена.')))
                .finally(() => { checkingAccess = false; });
        }, 5000);
        let last = 0, lastStage = '';
        const progress = async (value: IHostingProgress): Promise<void> => {
            abort.signal.throwIfAborted();
            if (Date.now() - last < 2000 && value.stage === lastStage && value.progress !== 100) { return; }
            last = Date.now(); lastStage = value.stage;
            await this.repository.update(row, { ...value, progress: value.progress === null ? null : Math.max(0, Math.min(100, Math.floor(value.progress))) });
        };
        try {
            abort.signal.throwIfAborted();
            const claims = await this.access.claims(row.actor);
            if (!claims.userRoles.includes('Главный админ')) { throw new Error('Права управления хостингом отозваны.'); }
            abort.signal.throwIfAborted();
            if(row.action!=='stop')await requireFeaturesEnabled(['model_hosting']);
            if (isRemoteModel(model)) {
                if (!this.remote) throw new Error('Сервис удалённых подключений не зарегистрирован.');
                await withModelUsage({ purpose: 'verification', actorEmail: row.actor, operationId: row.id }, () => this.remote!.check(model, row.actor, async () => {
                    abort.signal.throwIfAborted();
                    const current = await this.access.claims(row.actor);
                    if (!current.userRoles.includes('Главный админ')) throw new Error('Права управления подключением отозваны.');
                    const job = await this.repository.latest(model.id), live = await this.models.get(model.id);
                    if (job?.id !== row.id || job.state !== 'running' || projectEmbeddingPin(live) !== projectEmbeddingPin(model)) throw new ConflictException('Операция или версия модели изменились. Повторите проверку.');
                    abort.signal.throwIfAborted();
                }, abort.signal));
            } else if (row.action === 'stop') { await this.runtime.stop(model, abort.signal); }
            else {
                if (row.action === 'start') {
                    if (!this.bundles) throw new Error('Исполнитель проверенных поставок моделей не зарегистрирован.');
                    await this.bundles.prepare(model, progress, abort.signal);
                }
                const beforeInference = async () => {
                    abort.signal.throwIfAborted(); const current = await this.access.claims(row.actor);
                    if (!current.userRoles.includes('Главный админ')) throw new Error('Права управления хостингом отозваны.');
                    const job = await this.repository.latest(model.id), live = await this.models.get(model.id);
                    if (job?.id !== row.id || job.state !== 'running' || projectEmbeddingPin(live) !== projectEmbeddingPin(model)) throw new ConflictException('Операция или версия модели изменились. Повторите проверку.');
                    abort.signal.throwIfAborted();
                };
                const verified = await withModelUsage({ purpose: 'verification', actorEmail: row.actor, operationId: row.id, beforeInference }, () => row.action === 'start' ? this.runtime.start(model, progress, abort.signal) : this.runtime.check(model, abort.signal));
                abort.signal.throwIfAborted();
                await this.models.pinVerified(model, verified, row.actor, async () => {
                    abort.signal.throwIfAborted();
                    const current = await this.access.claims(row.actor);
                    if (!current.userRoles.includes('Главный админ')) { throw new Error('Права управления хостингом отозваны.'); }
                    abort.signal.throwIfAborted();
                });
            }
            abort.signal.throwIfAborted();
            await this.repository.update(row, { stage: 'completed', message: row.action === 'stop' ? 'Модель выгружена из памяти. Веса сохранены.' : 'Проверка модели пройдена.', progress: 100 }, 'completed');
        } catch (error) {
            const reason = abort.signal.aborted ? abort.signal.reason : error;
            const message = reason instanceof Error && !('code' in reason) ? reason.message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000) : 'Управление хостингом не выполнено. Проверьте доступ к хранилищу и повторите действие.';
            try { await this.repository.update(row, { stage: 'failed', message, progress: null }, 'failed'); }
            catch { this.logger.error('Не удалось сохранить отказ хостинга; незавершённая операция будет закрыта после восстановления связи.'); }
        } finally {
            clearTimeout(deadline); clearInterval(watchdog); lease.removeListener('error', disconnected);
            try { if (!connectionLost) { await lease.query(`SELECT pg_advisory_unlock(${lock})`); } }
            catch { connectionLost = true; }
            finally { lease.release(connectionLost); }
        }
    }
}
