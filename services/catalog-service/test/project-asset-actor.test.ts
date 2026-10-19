import { describe, expect, it, vi } from 'vitest';
import type { AccessDb } from '../src/access/access-db';
import { CatalogController } from '../src/catalog/catalog.controller';
import type { CatalogService } from '../src/catalog/catalog.service';

describe('Исполнитель изменения состава проекта', () => {
    const actor = 'operator@example.test';
    const request = (activeRole = 'Главный админ') => ({ headers: { 'x-bridge-principal': 'other@example.test',
        'x-bridge-actor': encodeURIComponent(JSON.stringify({ email: actor, activeRole })) } });
    function setup() {
        const catalog = { getProject: vi.fn().mockResolvedValue({ id: 'prj-example' }), addProjectAsset: vi.fn(), removeProjectAsset: vi.fn().mockResolvedValue(true) };
        const access = { claims: vi.fn().mockResolvedValue({ userRoles: ['Главный админ'], projects: [] }) };
        return { catalog, controller: new CatalogController(catalog as unknown as CatalogService, access as unknown as AccessDb) };
    }
    it('Добавление и удаление берут исполнителя из одного доверенного контекста', async () => {
        const { controller, catalog } = setup();
        const input = { assetId: 'ai-plug-example', assetKind: 'mcp', actor: 'forged@example.test' };
        await controller.addProjectAsset('prj-example', input, request());
        await controller.removeProjectAsset('prj-example', input, request());
        expect(catalog.addProjectAsset).toHaveBeenCalledWith('prj-example', input.assetId, 'mcp', actor);
        expect(catalog.removeProjectAsset).toHaveBeenCalledWith('prj-example', input.assetId, 'mcp', actor);
    });
    it('Недостаточная роль запрещает обе записи до изменения каталога', async () => {
        const { controller, catalog } = setup();
        const input = { assetId: 'ai-plug-example', assetKind: 'mcp' };
        await expect(controller.addProjectAsset('prj-example', input, request('Наблюдатель'))).rejects.toMatchObject({ status: 403 });
        await expect(controller.removeProjectAsset('prj-example', input, request('Наблюдатель'))).rejects.toMatchObject({ status: 403 });
        expect(catalog.addProjectAsset).not.toHaveBeenCalled();
        expect(catalog.removeProjectAsset).not.toHaveBeenCalled();
    });
});
