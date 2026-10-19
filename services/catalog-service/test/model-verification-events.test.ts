import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ModelsService} from '../src/models/models.service';
import {notifyModelCatalogChange} from '../src/models/model-events';
import type {IModel} from '../src/models/model.types';

const card = {id: 'model-fixture', revision: 1} as IModel;
const verified = {manifestSha256: 'a'.repeat(64), dimension: 2560};

describe('Перечитывание каталога после первого pin', () => {
    const fetch = vi.fn();
    beforeEach(() => {
        vi.stubGlobal('fetch', fetch); fetch.mockReset();
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'synthetic-internal-token');
        vi.stubEnv('API_GATEWAY_URL', 'http://gateway.fixture');
    });
    afterEach(() => {vi.unstubAllGlobals(); vi.unstubAllEnvs();});

    function service(pinVerified: (...args: unknown[]) => Promise<IModel>) {
        const value = Object.create(ModelsService.prototype) as ModelsService;
        Object.defineProperty(value, 'repository', {value: {pinVerified}});
        return value;
    }

    it('Публикует catalog/projects только после успешного commit метаданных', async () => {
        let committed = false;
        fetch.mockImplementation(async (_url, input) => {
            expect(committed).toBe(true);
            expect(JSON.parse(input.body).sections).toEqual(['catalog', 'projects', 'audit', 'operations']);
            return Response.json({ok: true});
        });
        const models = service(async () => {committed = true; return {...card, revision: 2};});
        expect(await models.pinVerified(card, verified, 'fixture@example.test', async () => undefined)).toMatchObject({revision: 2});
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0][0]).toBe('http://gateway.fixture/internal/events');
    });
    it('Повторная проверка pinned-карточки не публикует лишних событий', async () => {
        await service(async () => card).pinVerified(card, verified, 'fixture@example.test', async () => undefined);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('Rollback не публикует неподтверждённый pin', async () => {
        await expect(service(async () => {throw new Error('Аудит недоступен');}).pinVerified(card, verified, 'fixture@example.test', async () => undefined)).rejects.toThrow('Аудит недоступен');
        expect(fetch).not.toHaveBeenCalled();
    });
    it('Отказ онлайн-канала не отменяет уже закреплённую модель', async () => {
        fetch.mockRejectedValue(new Error('Offline'));
        expect(await service(async () => ({...card, revision: 2})).pinVerified(card, verified, 'fixture@example.test', async () => undefined)).toMatchObject({revision: 2});
    });
    it('Без internal token не отправляет неавторизованный запрос', async () => {
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', '');
        await notifyModelCatalogChange();
        expect(fetch).not.toHaveBeenCalled();
    });
});
