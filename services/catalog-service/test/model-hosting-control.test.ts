import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelHostingController } from '../src/models/hosting.controller';
import { ModelHostingService } from '../src/models/hosting.service';
import type { AccessDb } from '../src/access/access-db';
import type { ModelsService } from '../src/models/models.service';
import type { OllamaClient } from '../src/models/ollama-client';
import type { IModel } from '../src/models/model.types';
import type { IHostingJobRow, IHostingProgress } from '../src/models/hosting.types';

const card: IModel = { id: 'model-one', name: 'Модель', description: '', capability: 'embedding', runtime: 'ollama', model: 'qwen3:4b', manifestSha256: null, dimension: 3, source: 'custom', revision: 4, createdAt: '2026-10-19', updatedAt: '2026-10-19' };
const job = (action: IHostingJobRow['action'] = 'start'): IHostingJobRow => ({ id: 'job-one', model_id: card.id, action, actor: 'admin@example.test', state: 'running', stage: 'starting', message: 'Подготовка', progress: 0, started_at: '2026-10-19', finished_at: null, operation_id: 'op-model-one' });
const flush = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function harness(locked = true) {
    const lease = Object.assign(new EventEmitter(), { query: vi.fn(async () => ({ rows: [{ locked }] })), release: vi.fn() });
    const pool = { connect: vi.fn(async () => lease) };
    const models = { pool, ready: vi.fn(async () => undefined), get: vi.fn(async () => card), requireMain: vi.fn(async () => 'admin@example.test'), getAccessible: vi.fn(async () => card) };
    const access = { claims: vi.fn(async () => ({ userRoles: ['Главный админ'] })) };
    const runtime = { start: vi.fn(async () => undefined), check: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), status: vi.fn(async () => ({ state: 'ready', message: 'Готова', checkedAt: null })) };
    const repository = { setup: vi.fn(async () => undefined), latest: vi.fn(async () => undefined as IHostingJobRow | undefined), checkedAt: vi.fn(async () => null), interruptStale: vi.fn(async () => undefined), create: vi.fn(async (_lease, _id, action) => job(action)), update: vi.fn(async () => undefined) };
    const service = new ModelHostingService(models as unknown as ModelsService, access as unknown as AccessDb, runtime as unknown as OllamaClient);
    Object.defineProperty(service, 'repository', { value: repository });
    return { service, lease, pool, models, access, runtime, repository };
}
function waitForAbort(_model: IModel, _progress: (value: IHostingProgress) => Promise<void>, signal: AbortSignal): Promise<void> {
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}
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
