import {requireFeaturesEnabled} from '../src/features/require-feature-enabled';
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined)}));
import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelHostingController } from '../src/models/hosting.controller';
import { ModelHostingService } from '../src/models/hosting.service';
import { ModelHostingRepository } from '../src/models/hosting.repository';
import { ModelsRepository } from '../src/models/models.repository';
import type { Pool, PoolClient } from 'pg';
import type { AccessDb } from '../src/access/access-db';
import type { ModelsService } from '../src/models/models.service';
import type { OllamaClient } from '../src/models/ollama-client';
import type { ModelBundleRuntime } from '../src/models/model-bundle-runtime';
import type { IModel } from '../src/models/model.types';
import type { IHostingJobRow, IHostingProgress } from '../src/models/hosting.types';

const card: IModel = { id: 'model-one', name: 'Модель', description: '', capability: 'embedding', runtime: 'ollama', model: 'qwen3:4b', manifestSha256: null, dimension: 3, source: 'custom', revision: 4, createdAt: '2026-10-19', updatedAt: '2026-10-19' };
const hostingActor = 'admin@example.test';
const job = (action: IHostingJobRow['action'] = 'start'): IHostingJobRow => ({ id: 'job-one', model_id: card.id, action, actor: 'admin@example.test', state: 'running', stage: 'starting', message: 'Подготовка', progress: 0, started_at: '2026-10-19', finished_at: null, operation_id: 'op-model-one' });
const flush = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function harness(locked = true) {
    const lease = Object.assign(new EventEmitter(), { query: vi.fn(async () => ({ rows: [{ locked }] })), release: vi.fn() });
    const pool = { connect: vi.fn(async () => lease) };
    const models = { pool, ready: vi.fn(async () => undefined), get: vi.fn(async () => card), requireMain: vi.fn(async () => 'admin@example.test'), getAccessible: vi.fn(async () => card),
        pinVerified: vi.fn(async (_model, _verified, _actor, authorize) => {await authorize(); return card;}) };
    const access = { claims: vi.fn(async () => ({ userRoles: ['Главный админ'] })) };
    const runtime = { start: vi.fn(async () => ({manifestSha256: 'a'.repeat(64), dimension: 3})), check: vi.fn(async () => ({manifestSha256: 'a'.repeat(64), dimension: 3})), stop: vi.fn(async () => undefined), status: vi.fn(async () => ({ state: 'ready', message: 'Готова', checkedAt: null })) };
    const repository = { setup: vi.fn(async () => undefined), latest: vi.fn(async () => undefined as IHostingJobRow | undefined), checkedAt: vi.fn(async () => null), interruptStale: vi.fn(async () => undefined), create: vi.fn(async (_lease, _id, action) => job(action)), update: vi.fn(async () => undefined) };
    const service = new ModelHostingService(models as unknown as ModelsService, access as unknown as AccessDb, runtime as unknown as OllamaClient, undefined, {prepare:vi.fn(async()=>undefined)} as unknown as ModelBundleRuntime);
    Object.defineProperty(service, 'repository', { value: repository });
    return { service, lease, pool, models, access, runtime, repository };
}
function waitForAbort(_model: IModel, _progress: (value: IHostingProgress) => Promise<void>, signal: AbortSignal): Promise<void> {
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}
beforeEach(()=>{vi.mocked(requireFeaturesEnabled).mockReset().mockResolvedValue(undefined);});
afterEach(() => vi.useRealTimers());

describe('Проверка и взаимное исключение управления моделью', () => {
    it.each([null, [], { action: 'unknown', expectedRevision: 4 }, { action: 'start', expectedRevision: 0 }, { action: 'start', expectedRevision: '4' }, { action: ['start'], expectedRevision: 4 }])('Отклоняет некорректное действие и ревизию %# до соединения с runtime', async input => {
        const { service, pool, runtime } = harness();
        await expect(service.control(card.id, input, 'admin@example.test')).rejects.toBeInstanceOf(BadRequestException);
        expect(pool.connect).not.toHaveBeenCalled(); expect(runtime.start).not.toHaveBeenCalled();
    });
    it('Проверяет ревизию до блокировки и повторно под блокировкой', async () => {
        const first = harness();
        await expect(first.service.control(card.id, { action: 'start', expectedRevision: 3 }, 'admin@example.test')).rejects.toBeInstanceOf(ConflictException);
        expect(first.pool.connect).not.toHaveBeenCalled();
        const second = harness(); second.models.get.mockResolvedValueOnce(card).mockResolvedValueOnce({ ...card, revision: 5 });
        await expect(second.service.control(card.id, { action: 'start', expectedRevision: 4 }, 'admin@example.test')).rejects.toBeInstanceOf(ConflictException);
        expect(second.repository.create).not.toHaveBeenCalled(); expect(second.lease.release).toHaveBeenCalledOnce();
    });
    it('Повтор того же выполняющегося действия возвращает операцию без второй загрузки', async () => {
        const { service, repository, runtime, lease } = harness(false);
        repository.latest.mockImplementation(async () => { expect(lease.release).toHaveBeenCalledOnce(); return job(); });
        const result = await service.control(card.id, { action: 'start', expectedRevision: 4 }, 'admin@example.test');
        expect(result).toMatchObject({ state: 'busy', operation: { id: 'job-one', action: 'start' } });
        expect(repository.create).not.toHaveBeenCalled(); expect(runtime.start).not.toHaveBeenCalled(); expect(lease.release).toHaveBeenCalledOnce();
    });
    it('Другое действие во время общей операции не запускается', async () => {
        const { service, repository, runtime, lease } = harness(false); repository.latest.mockResolvedValue(job('check'));
        await expect(service.control(card.id, { action: 'stop', expectedRevision: 4 }, 'admin@example.test')).rejects.toBeInstanceOf(ConflictException);
        expect(runtime.stop).not.toHaveBeenCalled(); expect(repository.interruptStale).not.toHaveBeenCalled(); expect(lease.release).toHaveBeenCalledOnce();
    });
    it('Отказ в правах контроллера не достигает исполнителя', async () => {
        const { models, service } = harness(); models.requireMain.mockRejectedValue(new ForbiddenException('Нет права'));
        const control = vi.spyOn(service, 'control');
        const controller = new ModelHostingController(models as unknown as ModelsService, service);
        await expect(controller.control(card.id, {} as Request, { action: 'start', expectedRevision: 4 })).rejects.toBeInstanceOf(ForbiddenException);
        expect(control).not.toHaveBeenCalled();
    });
});

describe('Завершение, отзыв прав и прогресс хостинга', () => {
    it.each(['start', 'check'] as const)('Явное %s закрепляет подтверждение runtime до успешного завершения задания', async action => {
        const {service, models, repository} = harness();
        await service.control(card.id, {action, expectedRevision: card.revision}, hostingActor);
        await vi.waitFor(() => expect(repository.update).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({stage: 'completed'}), 'completed'));
        expect(models.pinVerified).toHaveBeenCalledWith(card, {manifestSha256: 'a'.repeat(64), dimension: 3}, hostingActor, expect.any(Function));
        expect(models.pinVerified.mock.invocationCallOrder[0]).toBeLessThan(repository.update.mock.invocationCallOrder.at(-1)!);
    });
    it('Отзыв роли после probe не позволяет закрепить модель и завершить задание успешно', async () => {
        const {service, access, runtime, repository} = harness();
        runtime.check.mockImplementation(async () => {access.claims.mockResolvedValue({userRoles: []}); return {manifestSha256: 'a'.repeat(64), dimension: 3};});
        await service.control(card.id, {action: 'check', expectedRevision: card.revision}, hostingActor);
        await vi.waitFor(() => expect(repository.update).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({stage: 'failed', message: expect.stringContaining('отозваны')}), 'failed'));
        expect(repository.update.mock.calls.some(call => call[2] === 'completed')).toBe(false);
    });
    it('Отсутствующее подтверждение custom-модели завершает задание отказом', async () => {
        const {service, models, runtime, repository} = harness();
        const pins = new ModelsRepository({} as Pool);
        models.pinVerified.mockImplementation((model, verified, email, authorize) => pins.pinVerified(model, verified, email, authorize));
        runtime.check.mockResolvedValue(undefined as never);
        await service.control(card.id, {action: 'check', expectedRevision: card.revision}, hostingActor);
        await vi.waitFor(() => expect(repository.update).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({stage: 'failed', message: expect.stringContaining('не подтвердил')}), 'failed'));
        expect(repository.update.mock.calls.some(call => call[2] === 'completed')).toBe(false);
    });
    it('Выгрузка модели не изменяет её закреплённые метаданные', async () => {
        const {service, models, repository} = harness();
        await service.control(card.id, {action: 'stop', expectedRevision: card.revision}, hostingActor);
        await vi.waitFor(() => expect(repository.update).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({stage: 'completed'}), 'completed'));
        expect(models.pinVerified).not.toHaveBeenCalled();
    });
    it('Отозванные до выполнения права завершают операцию отказом без runtime', async () => {
        const { service, access, runtime, repository, lease } = harness(); access.claims.mockResolvedValue({ userRoles: [] });
        await service.control(card.id, { action: 'start', expectedRevision: 4 }, 'admin@example.test'); await flush();
        expect(runtime.start).not.toHaveBeenCalled();
        expect(repository.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stage: 'failed', message: expect.stringContaining('отозваны') }), 'failed');
        expect(lease.release).toHaveBeenCalledOnce();
    });
    it('Watchdog прерывает загрузку после отзыва прав без повторного входа', async () => {
        vi.useFakeTimers(); const { service, access, runtime, repository } = harness();
        runtime.start.mockImplementation(waitForAbort as never);
        await service.control(card.id, { action: 'start', expectedRevision: 4 }, 'admin@example.test'); await flush();
        access.claims.mockResolvedValue({ userRoles: [] }); await vi.advanceTimersByTimeAsync(5000); await flush();
        expect(repository.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stage: 'failed', message: expect.stringContaining('отозваны') }), 'failed');
        await service.beforeApplicationShutdown();
    });
    it('Shutdown ждёт отмены активной работы и не принимает следующую операцию', async () => {
        const { service, runtime, repository, lease } = harness(); runtime.start.mockImplementation(waitForAbort as never);
        await service.control(card.id, { action: 'start', expectedRevision: 4 }, 'admin@example.test'); await flush();
        await service.beforeApplicationShutdown();
        expect(repository.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stage: 'failed', message: expect.stringContaining('перезапускается') }), 'failed');
        expect(lease.release).toHaveBeenCalledOnce();
        await expect(service.control(card.id, { action: 'check', expectedRevision: 4 }, 'admin@example.test')).rejects.toBeInstanceOf(ConflictException);
    });
    it('Shutdown между чтением модели и выдачей блокировки не запускает новую работу', async () => {
        const { service, models, runtime, repository } = harness(); const waiting = deferred<IModel>(); models.get.mockReturnValueOnce(waiting.promise);
        const pending = service.control(card.id, { action: 'start', expectedRevision: 4 }, 'admin@example.test');
        const rejected = expect(pending).rejects.toBeInstanceOf(ConflictException);
        let stopped = false; const shutdown = service.beforeApplicationShutdown().then(() => { stopped = true; });
        await flush(); expect(stopped).toBe(false); waiting.resolve(card);
        await rejected; await shutdown;
        expect(repository.create).not.toHaveBeenCalled(); expect(runtime.start).not.toHaveBeenCalled();
    });
    it('Shutdown во время сохранения задания отменяет новое задание до runtime и ждёт его финала', async () => {
        const { service, runtime, repository, lease } = harness(); const waiting = deferred<IHostingJobRow>(); repository.create.mockReturnValueOnce(waiting.promise);
        const pending = service.control(card.id, { action: 'start', expectedRevision: 4 }, 'admin@example.test');
        await flush(); expect(repository.create).toHaveBeenCalledOnce();
        let stopped = false; const shutdown = service.beforeApplicationShutdown().then(() => { stopped = true; });
        await flush(); expect(stopped).toBe(false); waiting.resolve(job());
        await pending; await shutdown;
        expect(runtime.start).not.toHaveBeenCalled();
        expect(repository.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stage: 'failed', message: expect.stringContaining('перезапускается') }), 'failed');
        expect(lease.release).toHaveBeenCalledOnce();
    });
    it('Записывает смену стадии и финал, ограничивает частоту и диапазон прогресса', async () => {
        const { service, runtime, repository } = harness();
        runtime.start.mockImplementation(async (_model, progress: (value: IHostingProgress) => Promise<void>) => {
            await progress({ stage: 'downloading', message: 'Первая часть', progress: -5 });
            await progress({ stage: 'downloading', message: 'Частый повтор', progress: 10 });
            await progress({ stage: 'checking', message: 'Проверяем', progress: 90.9 });
            await progress({ stage: 'ready', message: 'Готово', progress: 200 });
            return {manifestSha256: 'a'.repeat(64), dimension: 3};
        });
        await service.control(card.id, { action: 'start', expectedRevision: 4 }, 'admin@example.test'); await flush();
        const values = repository.update.mock.calls.map(call => call[1]);
        expect(values).toContainEqual({ stage: 'downloading', message: 'Первая часть', progress: 0 });
        expect(values.some(value => value.message === 'Частый повтор')).toBe(false);
        expect(values).toContainEqual({ stage: 'checking', message: 'Проверяем', progress: 90 });
        expect(values).toContainEqual({ stage: 'ready', message: 'Готово', progress: 100 });
        expect(repository.update).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ stage: 'completed', progress: 100 }), 'completed');
    });
    it('Потеря управляющего соединения отменяет runtime и удаляет повреждённый lease', async () => {
        const { service, runtime, repository, lease } = harness(); runtime.start.mockImplementation(waitForAbort as never);
        await service.control(card.id, { action: 'start', expectedRevision: 4 }, 'admin@example.test'); await flush();
        lease.emit('error', new Error('Соединение потеряно')); await flush();
        expect(repository.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stage: 'failed', message: expect.stringContaining('блокировка') }), 'failed');
        expect(lease.release).toHaveBeenCalledWith(true); expect(lease.listenerCount('error')).toBe(0);
        await service.beforeApplicationShutdown();
    });
    it('Технический отказ БД не раскрывает параметры подключения пользователю', async () => {
        const { service, access, repository } = harness();
        access.claims.mockRejectedValue(Object.assign(new Error('password=secret connection failed'), { code: '28P01' }));
        await service.control(card.id, { action: 'start', expectedRevision: 4 }, 'admin@example.test'); await flush();
        const failure = repository.update.mock.calls.find(call => call[2] === 'failed')?.[1];
        expect(failure?.message).toContain('Управление хостингом не выполнено');
        expect(failure?.message).not.toContain('password');
        await service.beforeApplicationShutdown();
    });
});

describe('Проверка состояния восстанавливает задания без управляющего исполнителя', () => {
    it('Занятая advisory lock сохраняет активную операцию и не запускает восстановление', async () => {
        const h = harness(false); h.repository.latest.mockResolvedValue(job());
        expect(await h.service.status(card)).toMatchObject({state: 'busy', operation: {id: 'job-one', state: 'running'}});
        expect(h.lease.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("pg_try_advisory_lock(hashtextextended('neurocenter:model-hosting',0))"));
        expect(h.repository.interruptStale).not.toHaveBeenCalled(); expect(h.runtime.status).not.toHaveBeenCalled();
        expect(h.lease.release).toHaveBeenCalledExactlyOnceWith(false); expect(h.lease.listenerCount('error')).toBe(0);
    });

    it('После двух отказов финальной записи и восстановления БД статус снимает вечную занятость без повторного выполнения', async () => {
        const h = harness(); let stored: IHostingJobRow | undefined;
        h.repository.latest.mockImplementation(async () => stored);
        h.repository.create.mockImplementation(async () => stored = job());
        h.repository.interruptStale.mockImplementation(async () => { if (stored) stored = {...stored, state: 'failed', stage: 'interrupted'}; });
        h.repository.update.mockRejectedValue(new Error('Временный отказ БД'));
        await h.service.control(card.id, {action: 'start', expectedRevision: card.revision}, 'admin@example.test'); await flush();
        expect(h.repository.update).toHaveBeenCalledTimes(2); expect(h.lease.release).toHaveBeenCalledOnce();
        expect(stored?.state).toBe('running'); h.repository.update.mockResolvedValue(undefined);
        expect(await h.service.status(card)).toMatchObject({state: 'ready', operation: {id: 'job-one', state: 'failed', stage: 'interrupted'}});
        expect(h.repository.interruptStale).toHaveBeenLastCalledWith(h.lease);
        expect(await h.service.status(card)).toMatchObject({state: 'ready'});
        expect(h.pool.connect).toHaveBeenCalledTimes(2); expect(h.runtime.start).toHaveBeenCalledOnce(); expect(h.repository.create).toHaveBeenCalledOnce();
    });

    it('Ошибка восстановления освобождает блокировку; следующая проверка повторяет только сверку', async () => {
        const h = harness(); let stored = job();
        h.repository.latest.mockImplementation(async () => stored);
        h.repository.interruptStale.mockRejectedValueOnce(new Error('Не удалось сохранить сверку')).mockImplementation(async () => { stored = {...stored, state: 'failed'}; });
        await expect(h.service.status(card)).rejects.toThrow('Не удалось сохранить сверку');
        expect(h.lease.query).toHaveBeenLastCalledWith(expect.stringContaining('pg_advisory_unlock'));
        expect(h.lease.release).toHaveBeenCalledExactlyOnceWith(false); expect(h.lease.listenerCount('error')).toBe(0);
        expect(await h.service.status(card)).toMatchObject({state: 'ready', operation: {state: 'failed'}});
        expect(h.repository.interruptStale).toHaveBeenCalledTimes(2); expect(h.runtime.start).not.toHaveBeenCalled(); expect(h.repository.create).not.toHaveBeenCalled();
    });

    it('Два процесса не восстанавливают одну операцию одновременно; следующий poll видит завершённую сверку', async () => {
        const first = harness(), second = harness(false), recovery = deferred<void>(); let stored = job();
        const latest = async () => stored; first.repository.latest.mockImplementation(latest); second.repository.latest.mockImplementation(latest);
        first.repository.interruptStale.mockImplementation(async () => { await recovery.promise; stored = {...stored, state: 'failed'}; });
        const reading = first.service.status(card);
        try {
            await flush(); expect(first.repository.interruptStale).toHaveBeenCalledOnce();
            expect(await second.service.status(card)).toMatchObject({state: 'busy'});
            expect(second.repository.interruptStale).not.toHaveBeenCalled();
        } finally { recovery.resolve(); }
        expect(await reading).toMatchObject({state: 'ready', operation: {state: 'failed'}});
        expect(await second.service.status(card)).toMatchObject({state: 'ready', operation: {state: 'failed'}});
        expect(first.repository.interruptStale).toHaveBeenCalledOnce(); expect(first.lease.release).toHaveBeenCalledOnce();
        expect(second.lease.release).toHaveBeenCalledOnce(); expect(first.runtime.start).not.toHaveBeenCalled(); expect(second.runtime.start).not.toHaveBeenCalled();
    });

    it('Ошибка unlock исключает управляющее соединение из пула', async () => {
        const h = harness(); let stored = job(); h.repository.latest.mockImplementation(async () => stored);
        h.repository.interruptStale.mockImplementation(async () => { stored = {...stored, state: 'failed'}; });
        h.lease.query.mockImplementation(async sql => {
            if (sql.includes('pg_advisory_unlock')) throw new Error('Не подтверждён unlock');
            return {rows: [{locked: true}]};
        });
        await expect(h.service.status(card)).rejects.toThrow('Не подтверждён unlock');
        expect(h.lease.release).toHaveBeenCalledExactlyOnceWith(true); expect(h.lease.listenerCount('error')).toBe(0);
        expect(await h.service.status(card)).toMatchObject({state: 'ready'}); expect(h.runtime.start).not.toHaveBeenCalled();
    });

    it('Неподтверждённый захват lock уничтожает неоднозначную сессию и допускает повтор', async () => {
        const h = harness(); h.repository.latest.mockResolvedValue(job());
        h.lease.query.mockRejectedValueOnce(new Error('Ответ БД потерян'));
        await expect(h.service.status(card)).rejects.toThrow('Ответ БД потерян');
        expect(h.lease.release).toHaveBeenCalledExactlyOnceWith(true); expect(h.repository.interruptStale).not.toHaveBeenCalled();
        expect(h.lease.listenerCount('error')).toBe(0);
    });

    it('Ошибка unlock на startup не возвращает session lock в пул', async () => {
        const h = harness(); h.lease.query.mockImplementation(async sql => {
            if (sql.includes('pg_advisory_unlock')) throw new Error('Не подтверждён startup unlock');
            return {rows: [{locked: true}]};
        });
        await expect(h.service.onModuleInit()).rejects.toThrow('Не подтверждён startup unlock');
        expect(h.repository.interruptStale).toHaveBeenCalledWith(h.lease);
        expect(h.lease.release).toHaveBeenCalledExactlyOnceWith(true); expect(h.lease.listenerCount('error')).toBe(0);
    });

    it('Ошибка unlock до передачи executor уничтожает сессию после отмены запуска', async () => {
        const h = harness(); h.models.get.mockResolvedValueOnce(card).mockResolvedValueOnce({...card, revision: card.revision + 1});
        h.lease.query.mockImplementation(async sql => {
            if (sql.includes('pg_advisory_unlock')) throw new Error('Не подтверждён control unlock');
            return {rows: [{locked: true}]};
        });
        await expect(h.service.control(card.id, {action: 'start', expectedRevision: card.revision}, 'admin@example.test')).rejects.toThrow('Не подтверждён control unlock');
        expect(h.lease.release).toHaveBeenCalledExactlyOnceWith(true); expect(h.lease.listenerCount('error')).toBe(0);
        expect(h.runtime.start).not.toHaveBeenCalled();
    });

    it('Потеря lock во время startup-сверки не допускает передачу новому executor', async () => {
        const h = harness(); h.repository.interruptStale.mockImplementation(async () => { h.lease.emit('error', new Error('Потеряна owner-сессия')); });
        await expect(h.service.control(card.id, {action: 'start', expectedRevision: card.revision}, 'admin@example.test')).rejects.toThrow();
        expect(h.repository.create).not.toHaveBeenCalled(); expect(h.runtime.start).not.toHaveBeenCalled();
        expect(h.lease.release).toHaveBeenCalledExactlyOnceWith(true); expect(h.lease.listenerCount('error')).toBe(0);
    });

    it('Потеря owner-сессии при сверке не пытается unlock на другом соединении', async () => {
        const h = harness(); h.repository.latest.mockResolvedValue(job());
        h.repository.interruptStale.mockImplementation(async () => { h.lease.emit('error', new Error('PG-сессия завершилась')); });
        await expect(h.service.status(card)).rejects.toThrow('Потеряно соединение проверки хостинга');
        expect(h.lease.query).toHaveBeenCalledOnce(); expect(h.lease.release).toHaveBeenCalledExactlyOnceWith(true);
        expect(h.lease.listenerCount('error')).toBe(0); expect(h.runtime.status).not.toHaveBeenCalled();
    });

    it('Восстановление пишет задания и журнал только через владельца advisory lock', async () => {
        const owner = {query: vi.fn(async (sql: string) => sql.startsWith('SELECT * FROM model_hosting_jobs')
            ? {rows: [job()], rowCount: 1} : {rows: [], rowCount: 1}), release: vi.fn()};
        const pool = {query: vi.fn(async () => { throw new Error('Восстановление ушло на другую PG-сессию'); }), connect: vi.fn()};
        const repository = new ModelHostingRepository(pool as unknown as Pool);
        await repository.interruptStale(owner as unknown as PoolClient);
        expect(pool.query).not.toHaveBeenCalled(); expect(pool.connect).not.toHaveBeenCalled(); expect(owner.release).not.toHaveBeenCalled();
        const queries = owner.query.mock.calls.map(([sql]) => sql);
        expect(queries).toContain('BEGIN'); expect(queries).toContain('COMMIT');
        expect(queries.some(sql => sql.startsWith('UPDATE model_hosting_jobs'))).toBe(true);
        expect(queries.some(sql => sql.startsWith('UPDATE operations'))).toBe(true);
        expect(queries.some(sql => sql.startsWith('INSERT INTO security_events'))).toBe(true);
    });

    it('Отказ журнала откатывает сверку на owner-сессии без её освобождения внутри репозитория', async () => {
        const owner = {query: vi.fn(async (sql: string) => {
            if (sql.startsWith('SELECT * FROM model_hosting_jobs')) return {rows: [job()], rowCount: 1};
            if (sql.startsWith('UPDATE operations')) throw new Error('Журнал временно недоступен');
            return {rows: [], rowCount: 1};
        }), release: vi.fn()};
        const pool = {query: vi.fn(), connect: vi.fn()};
        const repository = new ModelHostingRepository(pool as unknown as Pool);
        await expect(repository.interruptStale(owner as unknown as PoolClient)).rejects.toThrow('Журнал временно недоступен');
        expect(owner.query).toHaveBeenLastCalledWith('ROLLBACK'); expect(owner.release).not.toHaveBeenCalled();
        expect(pool.connect).not.toHaveBeenCalled(); expect(pool.query).not.toHaveBeenCalled();
        expect(owner.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    });
});


describe('Hosting worker respects a later feature disable',()=>{
 it('Disabled hosting refuses a new queued operation before worker creation',async()=>{const f=harness();vi.mocked(requireFeaturesEnabled).mockRejectedValueOnce(new ForbiddenException('Функция отключена'));await expect(f.service.control(card.id,{action:'start',expectedRevision:card.revision},hostingActor)).rejects.toHaveProperty('status',403);expect(f.repository.create).not.toHaveBeenCalled();expect(f.runtime.start).not.toHaveBeenCalled();});
 it('Disable after enqueue blocks heavyweight bundle preparation and runtime execution',async()=>{const f=harness();vi.mocked(requireFeaturesEnabled).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ForbiddenException('Функция отключена'));const prepare=vi.spyOn((f.service as unknown as {bundles:ModelBundleRuntime}).bundles,'prepare');await f.service.control(card.id,{action:'start',expectedRevision:card.revision},hostingActor);await vi.waitFor(()=>expect(f.repository.update).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({stage:'failed'}),'failed'));expect(prepare).not.toHaveBeenCalled();expect(f.runtime.start).not.toHaveBeenCalled();});
 it('Stop remains available when every admission lookup would fail',async()=>{const f=harness();vi.mocked(requireFeaturesEnabled).mockImplementation(async()=>{throw new ForbiddenException('Функция отключена');});await f.service.control(card.id,{action:'stop',expectedRevision:card.revision},hostingActor);await vi.waitFor(()=>expect(f.runtime.stop).toHaveBeenCalledOnce());expect(requireFeaturesEnabled).not.toHaveBeenCalled();});
});
