import type { ICatalogModel, IModelCatalog, IModelHosting } from './types';

export const modelCapabilityLabels: Record<ICatalogModel['capability'], string> = {
    embedding: 'Эмбеддинги', vision: 'Изображения', chat: 'Чат',
};

/** Только API-подключение имеет серверный адрес и отдельный ключ. */
export function modelUsesApiConnection(model: ICatalogModel): boolean {
    return model.runtime === 'remote-openai' || model.runtime === 'remote-ollama';
}

export function modelLocationLabel(model: ICatalogModel): string {
    return model.runtime === 'device-codex' ? 'Codex на компьютере' : modelUsesApiConnection(model) ? 'Удалённый API' : 'На сервере';
}

export const modelHostingLabels: Record<IModelHosting['state'], string> = {
    unavailable: 'Сервис недоступен', missing: 'Веса не загружены', stopped: 'Выгружена из памяти',
    ready: 'Готова', busy: 'Выполняется операция', error: 'Ошибка хостинга',
};

/** Неполный ответ не превращает существующие назначения в пустой каталог. */
export function requireModelCatalog(value: IModelCatalog): IModelCatalog {
    if (!value || !Array.isArray(value.items) || !Array.isArray(value.assignedModelIds)
        || value.assignedModelIds.some(id => typeof id !== 'string')
        || value.items.some(model => !model || typeof model.id !== 'string' || typeof model.name !== 'string'
            || typeof model.description !== 'string' || typeof model.model !== 'string'
            || !Object.prototype.hasOwnProperty.call(modelCapabilityLabels, model.capability))
        || new Set(value.items.map(model => model.id)).size !== value.items.length) {
        throw new Error('Сервер вернул неполный каталог моделей. Повторите загрузку.');
    }
    return value;
}

export function filterCatalogModels(catalog: IModelCatalog, query: string, assignedOnly: boolean): ICatalogModel[] {
    const search = query.trim().toLocaleLowerCase('ru');
    const assigned = new Set(catalog.assignedModelIds);
    return catalog.items.filter(model => (!assignedOnly || assigned.has(model.id))
        && (!search || `${model.name} ${model.description} ${model.model} ${modelCapabilityLabels[model.capability]}`.toLocaleLowerCase('ru').includes(search)));
}

/** Текущую операцию перечитываем до подтверждённого терминального состояния. */
export function modelHostingBusy(hosting: IModelHosting | null): boolean {
    return hosting?.state === 'busy' || hosting?.operation?.state === 'running';
}
