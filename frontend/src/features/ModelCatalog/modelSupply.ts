import type { ICatalogModel } from './types';

/** Переносятся публичные параметры карточки, без назначений, адресов сервера и данных пользователей. */
export function modelSupplyRecipe(model: ICatalogModel) {
    return { schemaVersion: 1, id: model.id, name: model.name, descriptor: {
        description: model.description, capability: model.capability, runtime: model.runtime, model: model.model,
        manifestSha256: model.manifestSha256, dimension: model.dimension, source: model.source,
    } };
}

export const modelSupplyFilename = (model: ICatalogModel): string => `${model.id}.supply.json`;

/** Команда передаёт данные файлом; название модели не становится shell-кодом. */
export function modelSupplyCommand(model: ICatalogModel, date: Date): string {
    const release = `models-${date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').toLowerCase()}`;
    const filename = modelSupplyFilename(model).replace(/'/g, "'\\''");
    return `npm run models:publish -- --recipe '${filename}' --release ${release} --publish`;
}

/** Загрузка JSON не публикует модель и не меняет хостинг; публикация остаётся явным действием оператора. */
export function downloadModelSupplyRecipe(model: ICatalogModel): void {
    const blob = new Blob([JSON.stringify(modelSupplyRecipe(model), null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    try {
        link.href = url; link.download = modelSupplyFilename(model); document.body.append(link); link.click();
    } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); }
}
