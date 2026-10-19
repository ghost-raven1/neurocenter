import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import type { Pool } from 'pg';
import { FEATURE_FLAGS } from '../../shared/feature-flags.cjs';
import { FeatureAccess } from '../src/access/feature-access';
import { FlagsController } from '../src/flags/flags.controller';
import { FlagsRepository } from '../src/flags/flags.repository';
import { FlagsService } from '../src/flags/flags.service';
import { AppController } from '../src/app.controller';

type Row = { flag_key: string; overrides: { enabled?: boolean }; revision: number; updated_at: string; updated_by: string };
let rows: Row[], events: unknown[][], activeRoles: string[], failAudit: boolean, failDatabase: boolean;
const query = async (sql: string, values: unknown[] = []) => {
    if (failDatabase) { throw new Error('БД недоступна'); }
    if (sql.startsWith('SELECT * FROM feature_flags WHERE flag_key=ANY')) { return { rows: structuredClone(rows) }; }
    if (sql.startsWith('SELECT * FROM feature_flags WHERE flag_key=$1')) { return { rows: structuredClone(rows.filter(row => row.flag_key === values[0])) }; }
    if (sql.startsWith('UPDATE feature_flags')) {
        const current = rows.find(row => row.flag_key === values[0])!;
        Object.assign(current, { overrides: { enabled: values[1] }, revision: current.revision + 1, updated_by: values[2] });
        return { rows: [structuredClone(current)] };
    }
    if (sql.startsWith('INSERT INTO security_events')) { if (failAudit) { throw new Error('Аудит недоступен'); } events.push(values); }
    return { rows: [] };
};
const pool = { query, connect: async () => {
    let before: Row[];
    return { query: async (sql: string, values?: unknown[]) => {
        if (sql === 'BEGIN') { before = structuredClone(rows); }
        if (sql === 'ROLLBACK') { rows = before; }
        return query(sql, values);
    }, release() {} };
} } as unknown as Pool;
const repository = new FlagsRepository(pool);
const flags = { list: async () => ({ items: await repository.list() }), evaluated: async () => ({ flags: await repository.evaluated() }),
    patch: repository.patch.bind(repository), ready: async () => { await query('SELECT 1'); } };
const nativeFetch = globalThis.fetch;
const previousToken = process.env.NEUROCENTER_INTERNAL_TOKEN;
class HttpFixtureModule {}
Module({ controllers: [FlagsController, AppController], providers: [{ provide: FlagsService, useValue: flags }, FeatureAccess] })(HttpFixtureModule);

/** Реальный Nest HTTP проверяет маршруты, заголовки и CAS; тестовый PG сохраняет транзакционные снимки. */
describe('HTTP-контракт сервиса переключателей', () => {
    let app: INestApplication, base: string;
    beforeAll(async () => {
        process.env.NEUROCENTER_INTERNAL_TOKEN = 'flags-http-test';
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ email: 'admin@example.invalid', userRoles: activeRoles }))));
        // Vitest не генерирует constructor metadata, которую обычная сборка TypeScript добавляет автоматически.
        Reflect.defineMetadata('design:paramtypes', [FlagsService, FeatureAccess], FlagsController);
        Reflect.defineMetadata('design:paramtypes', [FlagsService], AppController);
        app = await NestFactory.create(HttpFixtureModule, { logger: false, bodyParser: false });
        app.use(express.json({ limit: '2kb' }));
        await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    });
    beforeEach(() => {
        rows = FEATURE_FLAGS.map(item => ({ flag_key: item.key, overrides: {}, revision: 1, updated_at: '2026-10-19T00:00:00Z', updated_by: 'system:defaults' }));
        events = []; activeRoles = ['Главный админ']; failAudit = false; failDatabase = false;
    });
    afterAll(async () => {
        await app?.close(); vi.unstubAllGlobals();
        if (previousToken === undefined) { delete process.env.NEUROCENTER_INTERNAL_TOKEN; } else { process.env.NEUROCENTER_INTERNAL_TOKEN = previousToken; }
    });
    const call = (path: string, method = 'GET', body?: unknown, role = 'Главный админ', token = 'flags-http-test') => nativeFetch(base + path, {
        method, headers: { 'content-type': 'application/json', 'x-neurocenter-internal': token,
            'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: 'admin@example.invalid', activeRole: role })) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    it('Главный администратор читает три флага и сохраняет изменение с аудитом', async () => {
        const list = await call('/api/feature-flags'); expect(list.status).toBe(200); expect((await list.json()).items).toHaveLength(3);
        const changed = await call('/api/feature-flags/model_hosting', 'PATCH', { enabled: false, expectedRevision: 1 });
        expect(changed.status).toBe(200); expect(await changed.json()).toMatchObject({ key: 'model_hosting', enabled: false, revision: 2, updatedBy: 'admin@example.invalid' });
        expect(events).toHaveLength(1);
        const evaluated = await call('/internal/feature-flags/evaluated');
        expect(await evaluated.json()).toEqual({ flags: { model_hosting: false, tool_builds: true, rag_sync: true } });
    });

    it('Старая вкладка получает 409, повтор того же состояния не создаёт аудит', async () => {
        expect((await call('/api/feature-flags/model_hosting', 'PATCH', { enabled: false, expectedRevision: 1 })).status).toBe(200);
        expect((await call('/api/feature-flags/model_hosting', 'PATCH', { enabled: true, expectedRevision: 1 })).status).toBe(409);
        expect((await call('/api/feature-flags/model_hosting', 'PATCH', { enabled: false, expectedRevision: 2 })).status).toBe(200);
        expect(rows[0].revision).toBe(2); expect(events).toHaveLength(1);
    });

    it('Назначенная роль участника получает только вычисленные значения', async () => {
        activeRoles = ['Разработчик'];
        expect((await call('/api/feature-flags/evaluated', 'GET', undefined, 'Разработчик')).status).toBe(200);
        expect((await call('/api/feature-flags', 'GET', undefined, 'Разработчик')).status).toBe(403);
        expect((await call('/api/feature-flags/model_hosting', 'PATCH', { enabled: false, expectedRevision: 1 }, 'Разработчик')).status).toBe(403);
        expect((await call('/api/feature-flags')).status).toBe(403);
    });

    it('Неизвестный ключ, неверная форма и подмена actor не изменяют состояние', async () => {
        expect((await call('/api/feature-flags/unknown', 'PATCH', { enabled: false, expectedRevision: 1 })).status).toBe(404);
        expect((await call('/api/feature-flags/rag_sync', 'PATCH', null)).status).toBe(400);
        expect((await call('/api/feature-flags/rag_sync', 'PATCH', { enabled: false, expectedRevision: 1, actor: 'forged@example.invalid' })).status).toBe(400);
        expect(events).toHaveLength(0); expect(rows[2].revision).toBe(1);
    });

    it('Внутреннее чтение требует только действующий служебный секрет', async () => {
        activeRoles = [];
        expect((await nativeFetch(base + '/internal/feature-flags/evaluated', { headers: { 'x-neurocenter-internal': 'flags-http-test' } })).status).toBe(200);
        expect((await call('/internal/feature-flags/evaluated', 'GET', undefined, 'Главный админ', 'wrong')).status).toBe(403);
        expect((await nativeFetch(base + '/api/feature-flags/evaluated')).status).toBe(403);
    });

    it('Readiness становится 503 при отказе БД, liveness остаётся 200', async () => {
        failDatabase = true;
        const ready = await nativeFetch(base + '/ready'); expect(ready.status).toBe(503);
        expect(await ready.json()).toEqual({ ok: false, checks: { postgres: 'unavailable' } });
        expect((await nativeFetch(base + '/health')).status).toBe(200);
    });
});
