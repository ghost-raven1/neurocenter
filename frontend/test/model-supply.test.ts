import { describe, expect, it } from 'vitest';
import { modelSupplyCommand, modelSupplyFilename, modelSupplyRecipe } from '../src/features/ModelCatalog/modelSupply';
import type { ICatalogModel } from '../src/features/ModelCatalog/types';

const model: ICatalogModel = { id: 'model-test', name: 'Локальная модель', description: 'Тест', capability: 'chat', runtime: 'ollama',
    model: 'library/test:1', manifestSha256: null, dimension: null, source: 'custom', revision: 3, createdAt: '2026-10-19', updatedAt: '2026-10-19' };

describe('Рецепт модели для версионируемой поставки', () => {
    it('Передаёт точные параметры карточки без служебных полей и назначений', () => {
        expect(modelSupplyRecipe(model)).toEqual({ schemaVersion: 1, id: model.id, name: model.name,
            descriptor: { description: 'Тест', capability: 'chat', runtime: 'ollama', model: 'library/test:1', manifestSha256: null, dimension: null, source: 'custom' } });
        expect(JSON.stringify(modelSupplyRecipe(model))).not.toContain('createdAt');
    });
    it('Команда читает рецепт из файла и требует явной публикации', () => {
        const command = modelSupplyCommand(model, new Date('2026-10-19T12:34:56.000Z'));
        expect(command).toBe("npm run models:publish -- --recipe 'model-test.supply.json' --release models-20261019t123456 --publish");
        expect(command).not.toContain(model.name); expect(command).not.toContain(model.model);
        expect(modelSupplyFilename(model)).toBe('model-test.supply.json');
    });
    it('Закреплённый SHA и размерность встроенной модели сохраняются в рецепте', () => {
        const pinned = { ...model, source: 'builtin' as const, capability: 'embedding' as const, dimension: 2560, manifestSha256: 'a'.repeat(64) };
        expect(modelSupplyRecipe(pinned).descriptor).toMatchObject({ source: 'builtin', dimension: 2560, manifestSha256: 'a'.repeat(64) });
    });
});
