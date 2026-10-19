import type { IModelDescriptor } from './model.types';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { validateModelCreate } from './model-validation';

interface ISupplyModel { id: string; name: string; descriptor: IModelDescriptor; lock: string }

/** Dev и контейнер читают тот же Git-реестр, по которому готовятся веса. Адрес runtime остаётся серверным. */
export function suppliedModels(filename: string): ReadonlyArray<{ id: string; name: string; descriptor: IModelDescriptor }> {
    const registry = JSON.parse(readFileSync(filename, 'utf8')) as { schemaVersion: number; models: ISupplyModel[] };
    if (registry.schemaVersion !== 1 || !Array.isArray(registry.models) || !registry.models.length) { throw new Error('Некорректный реестр поставки моделей.'); }
    const ids = new Set<string>(), names = new Set<string>(), models = new Set<string>();
    return registry.models.map(item => {
        if (!/^model-[a-z0-9][a-z0-9-]{0,120}$/.test(item.id) || ids.has(item.id)
            || !/^(?:\.\.\/(?:embedding|vision)\/model|\.\/locks\/model-[a-z0-9-]+)\.lock\.json$/.test(item.lock)) { throw new Error('Некорректная карточка поставки модели.'); }
        const { description, capability, model, dimension } = item.descriptor;
        const validated = validateModelCreate({ name: item.name, description, capability, model, dimension });
        if (names.has(validated.name.toLowerCase()) || models.has(model.toLowerCase())) { throw new Error('Повторяющаяся модель в поставке.'); }
        ids.add(item.id); names.add(validated.name.toLowerCase()); models.add(model.toLowerCase());
        const lock = JSON.parse(readFileSync(path.resolve(path.dirname(filename), item.lock), 'utf8')) as { model: string; manifestSha256: string };
        if (item.descriptor.runtime !== 'ollama' || item.descriptor.source !== 'builtin' || !/^[a-f0-9]{64}$/.test(item.descriptor.manifestSha256 || '')
            || item.descriptor.model !== lock.model || item.descriptor.manifestSha256 !== lock.manifestSha256) { throw new Error('Карточка поставки отличается от model.lock.json.'); }
        return { id: item.id, name: validated.name, descriptor: { description: validated.description, capability,
            runtime: 'ollama', model, dimension: validated.dimension, manifestSha256: lock.manifestSha256, source: 'builtin' } };
    });
}

const development = path.resolve(__dirname, '../../../../scripts/models/model-registry.json');
export const builtinModels = suppliedModels(existsSync(development) ? development : '/tools/scripts/models/model-registry.json');
