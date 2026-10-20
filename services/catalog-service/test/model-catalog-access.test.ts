import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { AccessDb } from '../src/access/access-db';
import { allowRequest } from '../src/access/access-policy';
import type { IAccessClaims } from '../src/access/access.model';
import type { CatalogService } from '../src/catalog/catalog.service';
import { ModelsService } from '../src/models/models.service';
import { ModelsController } from '../src/models/models.controller';

const mocks = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), release: vi.fn() }));
vi.mock('../src/database/pool', () => ({ createPool: () => ({ query: mocks.query, connect: async () => ({ query: mocks.query, release: mocks.release }), end: mocks.end }) }));
const descriptor = { description: '', capability: 'embedding', runtime: 'ollama', model: 'example:1', dimension: 3, manifestSha256: null, source: 'custom' };
const cards = ['model-working', 'model-reading', 'model-global'].map(id => ({ id, name: id, descriptor, revision: 1, created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z' }));
const links = [{ project: 'prj-work', model: 'model-working' }, { project: 'prj-read', model: 'model-reading' }];
const email = 'member@example.invalid';
const allClaims: IAccessClaims = { email, userRoles: ['Главный админ', 'Админ проекта', 'Разработчик', 'Наблюдатель'], projects: [
    { projectId: 'prj-work', projectName: 'Работа', role: 'Админ проекта' },
    { projectId: 'prj-read', projectName: 'Чтение', role: 'Наблюдатель' },
], pluginIds: [], skillPaths: [] };
const request = (activeRole = 'Главный админ') => ({ headers: { 'x-neurocenter-internal': 'model-access-test',
    'x-bridge-principal': 'forged@example.invalid', 'x-bridge-actor': encodeURIComponent(JSON.stringify({ email, activeRole })) } }) as unknown as Request;
const previousToken = process.env.NEUROCENTER_INTERNAL_TOKEN;

describe('Права каталога моделей и проектных назначений', () => {
    let service: ModelsService;
    let controller: ModelsController;
    let claims: ReturnType<typeof vi.fn>;
    let catalog: { ensureSchema: ReturnType<typeof vi.fn>; getProject: ReturnType<typeof vi.fn> };
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEUROCENTER_INTERNAL_TOKEN = 'model-access-test';
        claims = vi.fn().mockResolvedValue(allClaims);
        catalog = { ensureSchema: vi.fn().mockResolvedValue(undefined), getProject: vi.fn(async (id: string) => ({ id: id === 'Работа' ? 'prj-work' : id })) };
        mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
            if (sql.startsWith('SELECT DISTINCT model_id')) { return { rows: links.filter(link => (params[0] as string[]).includes(link.project)).map(link => ({ model_id: link.model })) }; }
            if (sql.startsWith('SELECT * FROM model_catalog WHERE (archived_at') && params.length === 2) { return { rows: cards.filter(card => (params[1] as string[]).includes(card.id)) }; }
            if (sql.startsWith('SELECT * FROM model_catalog WHERE id=$1')) { return { rows: cards.filter(card => card.id === params[0]) }; }
            if (sql.startsWith('SELECT * FROM model_catalog')) { return { rows: cards }; }
            if (sql.startsWith('SELECT 1 FROM project_models')) { return { rows: links.filter(link => link.project === params[0] && link.model === params[1]) }; }
            if (sql.startsWith('SELECT id FROM projects') || sql.startsWith('SELECT id FROM model_catalog WHERE id=')) { return { rows: [{}] }; }
            if (sql.startsWith('INSERT INTO project_models')) { return { rows: [{ project_id: params[0], model_id: params[1], added_by: params[2], added_at: '2026-10-19T00:00:00Z' }] }; }
            if (sql.startsWith('DELETE FROM project_models')) { return { rows: [{ project_id: params[0], model_id: params[1], added_by: 'first@example.invalid', added_at: '2026-10-19T00:00:00Z' }] }; }
            return { rows: [] };
        });
        service = new ModelsService(catalog as unknown as CatalogService, { claims } as unknown as AccessDb);
        controller = new ModelsController(service);
    });
    afterEach(() => {
        if (previousToken === undefined) { delete process.env.NEUROCENTER_INTERNAL_TOKEN; }
        else { process.env.NEUROCENTER_INTERNAL_TOKEN = previousToken; }
    });

    it.each(['Главный админ', 'Админ проекта'])('Общий список видит %s, назначения выбранного проекта приходят отдельно', async role => {
        const global = await service.list(request(role));
        expect(global.items.map(item => item.id)).toEqual(cards.map(item => item.id));
        expect(global.assignedModelIds).toEqual([]);
        const selected = await service.list(request(role), 'prj-work');
        expect(selected.items).toHaveLength(3);
        expect(selected.assignedModelIds).toEqual(['model-working']);
    });

    it.each(['Разработчик', 'Наблюдатель'])('Участник %s видит только назначенные модели доступных проектов', async role => {
        expect((await service.list(request(role))).items.map(item => item.id)).toEqual(['model-working', 'model-reading']);
        const selected = await service.list(request(role), 'prj-read');
        expect(selected.items.map(item => item.id)).toEqual(['model-reading']);
        expect(selected.assignedModelIds).toEqual(['model-reading']);
        await expect(service.getAccessible('model-global', request(role))).rejects.toMatchObject({ status: 403 });
        expect(await service.getAccessible('model-reading', request(role))).toMatchObject({ id: 'model-reading' });
    });

    it('Чужой проект не раскрывает модели и даже не запрашивается у каталога', async () => {
        await expect(service.list(request('Админ проекта'), 'prj-other')).rejects.toMatchObject({ status: 403 });
        expect(catalog.getProject).not.toHaveBeenCalled();
        expect(mocks.query).not.toHaveBeenCalled();
    });

    it('Постоянный ID не подменяется совпадающим именем другого проекта', async () => {
        claims.mockResolvedValue({ ...allClaims, projects: [{ projectId: 'prj-own', projectName: 'prj-foreign', role: 'Админ проекта' }] });
        await expect(service.resolveProject(request('Админ проекта'), 'prj-foreign', 1)).rejects.toMatchObject({ status: 403 });
        expect(catalog.getProject).not.toHaveBeenCalled();
    });

    it('Новая выдача запроса сразу учитывает отозванную активную роль', async () => {
        await expect(service.getAccessible('model-working', request('Разработчик'))).resolves.toMatchObject({ id: 'model-working' });
        claims.mockResolvedValue({ ...allClaims, userRoles: ['Наблюдатель'] });
        await expect(service.getAccessible('model-working', request('Разработчик'))).rejects.toMatchObject({ status: 403 });
        expect(claims).toHaveBeenCalledTimes(2);
        expect(claims).toHaveBeenLastCalledWith(email);
    });

    it('Неверный служебный заголовок и повреждённый actor запрещены до записи', async () => {
        const direct = request(); direct.headers['x-neurocenter-internal'] = 'wrong';
        await expect(service.requireMain(direct)).rejects.toMatchObject({ status: 403 });
        const malformed = request(); malformed.headers['x-bridge-actor'] = '%malformed';
        await expect(service.requireMain(malformed)).rejects.toMatchObject({ status: 403 });
        expect(claims).not.toHaveBeenCalled();
    });

    it('Управление общим каталогом ограничено действующим главным администратором', async () => {
        for (const role of ['Админ проекта', 'Разработчик', 'Наблюдатель']) {
            await expect(controller.create({ name: 'Новая', capability: 'chat', model: 'example:1' }, request(role))).rejects.toMatchObject({ status: 403 });
        }
        expect(mocks.query).not.toHaveBeenCalled();
        expect(await service.requireMain(request())).toBe(email);
    });

    it('Публичное создание требует request key и не обходит проверенную локальную поставку', async () => {
        const body={name:'Новая',capability:'embedding',model:'fixture:one',runtime:'ollama',requestKey:'11111111-1111-4111-8111-111111111111'};
        await expect(controller.create({...body,requestKey:undefined},request())).rejects.toMatchObject({status:400});
        await expect(controller.create(body,request())).rejects.toMatchObject({status:400});
        expect(mocks.query).not.toHaveBeenCalled();
    });

    it('Проектные назначения разрешены только управляющей роли именно этого проекта', async () => {
        await expect(controller.assign('prj-work', { modelId: 'model-global' }, request('Админ проекта'))).resolves.toEqual({ ok: true });
        const event = mocks.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO security_events'))!;
        expect(event[1].slice(1, 4)).toEqual([email, 'project.model.add', 'prj-work · model-global']);
        for (const role of ['Разработчик', 'Наблюдатель']) {
            await expect(controller.assign('prj-work', { modelId: 'model-global' }, request(role))).rejects.toMatchObject({ status: 403 });
            await expect(controller.unassign('prj-work', 'model-global', request(role))).rejects.toMatchObject({ status: 403 });
        }
        await expect(controller.assign('prj-read', { modelId: 'model-global' }, request('Админ проекта'))).rejects.toMatchObject({ status: 403 });
    });

    it('Для inference недостаточно рабочей роли в другом проекте', async () => {
        expect(await service.getUsable('model-working', request('Разработчик'))).toMatchObject({ id: 'model-working' });
        await expect(service.getUsable('model-reading', request('Разработчик'))).rejects.toMatchObject({ status: 403 });
        await expect(service.getUsable('model-working', request('Наблюдатель'))).rejects.toMatchObject({ status: 403 });
        await expect(service.getUsable('model-global', request('Админ проекта'))).rejects.toMatchObject({ status: 403 });
        expect(await service.getUsable('model-global', request())).toMatchObject({ id: 'model-global' });
    });

    it('Явный проект требует рабочего доступа и назначения именно в его каталоге', async () => {
        expect(await service.getUsable('model-working', request('Разработчик'), 'Работа')).toMatchObject({ id: 'model-working' });
        await expect(service.getUsable('model-reading', request('Разработчик'), 'prj-read')).rejects.toMatchObject({ status: 403 });
        await expect(service.getUsable('model-reading', request('Разработчик'), 'prj-work')).rejects.toMatchObject({ status: 403 });
        await expect(service.getUsable('model-global', request(), 'prj-work')).rejects.toMatchObject({ status: 403 });
    });

    it('Пул моделей закрывается после остановки worker, а схема используется общая', async () => {
        await service.onModuleInit();
        expect(catalog.ensureSchema).toHaveBeenCalledOnce();
        expect(mocks.end).not.toHaveBeenCalled();
        await service.onApplicationShutdown();
        expect(mocks.end).toHaveBeenCalledOnce();
    });

    it('Gateway разрешает чтение и только реализованные inference-маршруты рабочим ролям', () => {
        for (const role of ['Главный админ', 'Админ проекта', 'Разработчик', 'Наблюдатель']) {
            expect(allowRequest(allClaims, role, { method: 'GET', path: '/api/models' })).toBe(true);
            expect(allowRequest(allClaims, role, { method: 'GET', path: '/api/models/model-working/hosting' })).toBe(true);
            expect(allowRequest(allClaims, role, { method: 'POST', path: '/api/models' })).toBe(role === 'Главный админ');
            for (const endpoint of ['api/embed', 'api/chat', 'v1/embeddings', 'v1/chat/completions']) {
                expect(allowRequest(allClaims, role, { method: 'POST', path: `/api/models/model-working/ollama/${endpoint}` })).toBe(role !== 'Наблюдатель');
            }
        }
        expect(allowRequest(allClaims, 'Разработчик', { method: 'POST', path: '/api/models/model-working/hosting/start' })).toBe(false);
        expect(allowRequest(allClaims, 'Разработчик', { method: 'POST', path: '/api/models/model-working/ollama/api/generate' })).toBe(false);
        expect(allowRequest({ ...allClaims, userRoles: ['Наблюдатель'] }, 'Главный админ', { method: 'GET', path: '/api/models' })).toBe(false);
    });
});
