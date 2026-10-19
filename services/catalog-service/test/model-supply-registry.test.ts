import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { suppliedModels } from '../src/models/builtin-models';
import { modelSupplySeeds } from '../src/models/model-supply-seed';

/** Набор моделей задаётся Git-реестром и не ограничен embedding/vision. */
function fixture(action: (filename: string, registry: { schemaVersion: number; models: object[] }) => void): void {
    const root = mkdtempSync(path.join(tmpdir(), 'nc-supply-models-'));
    try {
        mkdirSync(path.join(root, 'locks'));
        const registry = { schemaVersion: 1, models: ['embedding', 'vision', 'chat'].map((capability, index) => {
            const id = `model-fixture-${index}`, model = `team/fixture-${index}:v1`, manifestSha256 = String(index + 1).repeat(64);
            const lock = `./locks/${id}.lock.json`; writeFileSync(path.join(root, lock), JSON.stringify({ model, manifestSha256 }));
            return { id, name: `Модель ${index}`, lock, descriptor: { capability, model, manifestSha256,
                description: 'Закреплённая модель', runtime: 'ollama', dimension: capability === 'embedding' ? 256 : null, source: 'builtin' } };
        }) };
        const filename = path.join(root, 'model-registry.json'); writeFileSync(filename, JSON.stringify(registry));
        action(filename, registry);
    } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('Git-реестр поставки моделей', () => {
    it('Добавленная chat-модель появляется в каталоге со стабильным ID и закреплённым SHA', () => fixture(filename => {
        const models = suppliedModels(filename);
        expect(models).toHaveLength(3);
        expect(models[2]).toMatchObject({ id: 'model-fixture-2', descriptor: { model: 'team/fixture-2:v1', capability: 'chat', source: 'builtin', manifestSha256: '3'.repeat(64) } });
        expect(models.every(model => !Object.hasOwn(model, 'lock'))).toBe(true);
    }));

    it('Несовпадающий lock и подмена пути останавливают чтение поставки', () => fixture((filename, registry) => {
        const original = JSON.stringify(registry);
        const first = registry.models[0] as { lock: string; descriptor: { manifestSha256: string } };
        first.descriptor.manifestSha256 = 'f'.repeat(64); writeFileSync(filename, JSON.stringify(registry));
        expect(() => suppliedModels(filename)).toThrow('отличается');
        const changed = JSON.parse(original); changed.models[0].lock = '../../secret.json'; writeFileSync(filename, JSON.stringify(changed));
        expect(() => suppliedModels(filename)).toThrow('карточка');
    }));

    it('Дубликат ID не создаёт вторую неоднозначную карточку', () => fixture((filename, registry) => {
        registry.models.push(registry.models[0]); writeFileSync(filename, JSON.stringify(registry));
        expect(() => suppliedModels(filename)).toThrow('карточка');
    }));

    it('Одноимённая пользовательская модель сохраняется, а новая получает отличимое название до 128 символов', () => fixture(filename => {
        const supplied = suppliedModels(filename), custom = { ...supplied[0], id: 'model-custom' };
        const seeds = modelSupplySeeds(supplied, [custom]);
        expect(seeds[0]).toMatchObject({ id: supplied[0].id, name: `Модель 0 · ${supplied[0].id}` });
        expect(custom.name).toBe('Модель 0');
        const long = { ...supplied[0], id: 'model-' + 'x'.repeat(121), name: 'Название'.repeat(16) };
        const renamed = modelSupplySeeds([long], [{ ...long, id: 'model-unrelated' }])[0];
        expect(renamed.name.length).toBeLessThanOrEqual(128); expect(renamed.id).toBe(long.id);
        expect(modelSupplySeeds([long], [{ ...long, id: 'model-unrelated' }])[0].name).toBe(renamed.name);
    }));

    it('Существующая изменённая подпись и описание остаются у прежнего ID, чужие технические параметры отклоняются', () => fixture(filename => {
        const supplied = suppliedModels(filename), current = { ...supplied[0], name: 'Моя подпись' };
        expect(modelSupplySeeds(supplied, [current])[0].name).toBe('Моя подпись');
        const conflicting = { ...current, descriptor: { ...current.descriptor, model: 'other:1' } };
        expect(() => modelSupplySeeds(supplied, [conflicting])).toThrow('техническими параметрами');
        expect(conflicting.descriptor.model).toBe('other:1');
    }));
});
