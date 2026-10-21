vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:vi.fn(async()=>undefined),requireFeatureEnabled:vi.fn(async()=>undefined)}));
import {describe, expect, it, vi} from 'vitest';
import {ForbiddenException} from '@nestjs/common';
import type {Pool} from 'pg';
import {ModelsRepository} from '../src/models/models.repository';
import {OllamaClient} from '../src/models/ollama-client';
import {assertProjectEmbeddingModel} from '../src/models/project-embedding.validation';
import {localModelAlias} from '../src/models/local-model-alias';
import type {IModel} from '../src/models/model.types';

const digest = 'a'.repeat(64), otherDigest = 'b'.repeat(64);
const card: IModel = {id: 'model-fixture', name: 'Проверяемая модель', description: '', runtime: 'ollama',
    model: 'fixture:one', capability: 'embedding', dimension: null, manifestSha256: digest, source: 'custom',
    revision: 1, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z'};
const metadata = {manifestSha256: digest, dimension: 2560};
const actor = 'fixture@example.test';

function runtime(options: {afterDigest?: string; dimension?: number; initialDigest?: string} = {}) {
    let tags = 0;
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request) => {
        const route = new URL(String(url)).pathname; calls.push(route);
        if (route === '/api/tags') return Response.json({models: [{name: localModelAlias(card), digest: ++tags === 1 ? options.initialDigest ?? digest : options.afterDigest ?? digest}]});
        if (route === '/api/show') return Response.json({capabilities: ['embedding']});
        if (route === '/api/embed') {
            const vector = Array.from({length: options.dimension ?? 2560}, (_, index) => index === 0 ? 1 : 0);
            return Response.json({model: localModelAlias(card), embeddings: [vector, vector]});
        }
        throw new Error('Неожиданный синтетический маршрут');
    });
    return {client: new OllamaClient({fetch: fetch as typeof globalThis.fetch, env: {NODE_ENV: 'test'}}), calls};
}

function repository(initial = card) {
    const descriptor = ({id: _id, name: _name, revision: _revision, createdAt: _created, updatedAt: _updated, ...value}: IModel) => value;
    let current = {...initial}, saved = {...initial};
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
        if (sql === 'BEGIN') saved = {...current};
        if (sql === 'ROLLBACK') current = {...saved};
        if (sql.startsWith('SELECT * FROM model_catalog')) return {rows: [{id: current.id, name: current.name, descriptor: descriptor(current), revision: current.revision, created_at: current.createdAt, updated_at: current.updatedAt}]};
        if (sql.startsWith('UPDATE model_catalog')) {
            current = {...current, ...JSON.parse(String(values[1])), revision: current.revision + 1};
            return {rows: [{id: current.id, name: current.name, descriptor: descriptor(current), revision: current.revision, created_at: current.createdAt, updated_at: current.updatedAt}]};
        }
        return {rows: []};
    });
    const release = vi.fn(), pool = {connect: vi.fn(async () => ({query, release}))} as unknown as Pool;
    return {repository: new ModelsRepository(pool), query, release, pool, read: () => current,
        mutate: (value: Partial<IModel>) => {current = {...current, ...value};}};
}

describe('Подтверждённые метаданные runtime', () => {
    it.each([null, 2560])('Проверка возвращает digest и настоящую размерность при исходной dimension=%s', async dimension => {
        const context = runtime();
        expect(await context.client.check({...card, dimension})).toEqual(metadata);
        expect(context.calls).toEqual(['/api/tags', '/api/show', '/api/embed', '/api/tags']);
    });
    it('Явный start сохранённой модели возвращает результат той же проверки', async () => {
        const context = runtime();
        expect(await context.client.start(card)).toEqual(metadata);
        expect(context.calls).not.toContain('/api/pull');
    });
    it('Смена digest во время probe не закрепляет другую модель', async () => {
        await expect(runtime({afterDigest: otherDigest}).client.check(card)).rejects.toThrow(/SHA.*изменил/);
    });
    it('Отсутствующий корректный digest отклоняется до inference', async () => {
        const context = runtime({initialDigest: 'unverified'});
        await expect(context.client.check(card)).rejects.toThrow(/SHA/);
        expect(context.calls).toEqual(['/api/tags']);
    });
    it('Заданную неправильную размерность нельзя молча исправить', async () => {
        await expect(runtime({dimension: 3}).client.check({...card, dimension: 2560})).rejects.toThrow(/2560.*3/);
    });
    it('Закреплённая модель не принимает изменившийся digest до probe', async () => {
        const context = runtime({initialDigest: otherDigest});
        await expect(context.client.check({...card, manifestSha256: digest, dimension: 2560})).rejects.toThrow(/SHA/);
        expect(context.calls).toEqual(['/api/tags']);
    });
});

describe('Проверка импортированной модели и сохранение размерности', () => {
    it('Сохраняет подтверждённую размерность импортированного SHA с аудитом, после чего модель подходит для RAG', async () => {
        const context = repository(), authorize = vi.fn(async () => undefined);
        const verified = await runtime().client.check(card);
        const pinned = await context.repository.pinVerified(card, verified, actor, authorize);
        expect(pinned).toMatchObject({...metadata, revision: 2});
        expect(() => assertProjectEmbeddingModel(pinned, 2560)).not.toThrow();
        expect(context.query.mock.calls.findIndex(([sql]) => sql.endsWith('FOR UPDATE'))).toBeLessThan(context.query.mock.calls.findIndex(([sql]) => sql.startsWith('UPDATE model_catalog')));
        expect(authorize).toHaveBeenCalledOnce();
        expect(context.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO security_events'))).toHaveLength(1);
        expect(context.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
        expect(context.release).toHaveBeenCalledOnce();
    });
    it.each(['custom', 'builtin'] as const)('Повторная проверка pinned %s не меняет ревизию и не дублирует аудит', async source => {
        const pinned = {...card, ...metadata, source}, context = repository(pinned);
        expect(await context.repository.pinVerified(pinned, metadata, actor, async () => undefined)).toMatchObject({revision: 1});
        expect(context.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE') || sql.startsWith('INSERT INTO security_events'))).toBe(false);
    });
    it('Конкурентная правка карточки не затирается результатом старого probe', async () => {
        const context = repository(); context.mutate({name: 'Новое имя', revision: 2});
        await expect(context.repository.pinVerified(card, metadata, actor, async () => undefined)).rejects.toMatchObject({status: 409});
        expect(context.read()).toMatchObject({name: 'Новое имя', manifestSha256: digest});
        expect(context.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
    });
    it('Отзыв прав после получения блокировки откатывает закрепление', async () => {
        const context = repository();
        await expect(context.repository.pinVerified(card, metadata, actor, async () => {
            expect(context.query.mock.calls.at(-1)?.[0]).toContain('FOR UPDATE');
            throw new ForbiddenException('Права отозваны');
        })).rejects.toMatchObject({status: 403});
        expect(context.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
        expect(context.read().manifestSha256).toBe(digest);
    });
    it('Отказ аудита откатывает SHA, размерность и ревизию', async () => {
        const context = repository(), original = context.query.getMockImplementation()!;
        context.query.mockImplementation(async (sql, values) => {
            if (sql.startsWith('INSERT INTO security_events')) throw new Error('Аудит недоступен');
            return original(sql, values);
        });
        await expect(context.repository.pinVerified(card, metadata, actor, async () => undefined)).rejects.toThrow('Аудит недоступен');
        expect(context.read()).toMatchObject({manifestSha256: digest, dimension: null, revision: 1});
        expect(context.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    });
    it.each([undefined, {manifestSha256: 'invalid', dimension: 2560}, {...metadata, dimension: 0}])('Некорректное или отсутствующее подтверждение не принимается: %j', async value => {
        const context = repository();
        await expect(context.repository.pinVerified(card, value as never, actor, async () => undefined)).rejects.toThrow();
        expect(context.read().manifestSha256).toBe(digest);
    });
    it('Другой SHA уже закреплённой модели не заменяется', async () => {
        const pinned = {...card, ...metadata}, context = repository(pinned);
        await expect(context.repository.pinVerified(pinned, {...metadata, manifestSha256: otherDigest}, actor, async () => undefined)).rejects.toMatchObject({status: 409});
        expect(context.read().manifestSha256).toBe(digest);
    });
    it('Runtime не закрепляет модель без импортированного SHA', async () => {
        const unpinned = {...card, manifestSha256: null}, context = repository(unpinned);
        await expect(context.repository.pinVerified(unpinned, metadata, actor, async () => undefined)).rejects.toMatchObject({status: 409});
        expect(context.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
    });
    it('Повреждённый существующий pin не считается отсутствующим и не заменяется', async () => {
        const damaged = {...card, manifestSha256: ''}, context = repository(damaged);
        await expect(context.repository.pinVerified(damaged, metadata, actor, async () => undefined)).rejects.toMatchObject({status: 409});
        expect(context.read().manifestSha256).toBe('');
    });
    it('Удалённая во время probe карточка не создаётся заново', async () => {
        const context = repository(), original = context.query.getMockImplementation()!;
        context.query.mockImplementation(async (sql, values) => sql.startsWith('SELECT * FROM model_catalog') ? {rows: []} : original(sql, values));
        await expect(context.repository.pinVerified(card, metadata, actor, async () => undefined)).rejects.toMatchObject({status: 404});
        expect(context.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
    });
});
