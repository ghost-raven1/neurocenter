import type { TSourceSubsystem } from './interfaces';
/**
 * 12.1: маркеры обязательного системного набора (контракт поставки 1.3.0, all-or-nothing).
 * Системный ассет всегда поставляется в проект, а удаление из проекта недоступно —
 * API отвечает явной ошибкой с основанием; здесь только читаемые метки.
 */
export const subsystemLabels: Record<TSourceSubsystem, string> = {
    core: 'Ядро',
    rag: 'Поиск знаний (RAG)',
    'system-roles': 'Системные роли',
    'agent-team': 'Команда агентов',
};
export const SYSTEM_ASSET_TAG = 'Системный (обязательный)',
    SYSTEM_MODEL_TAG = 'Хостинг (опционально)';
/** Маркеры приходят парой; одиночное значение считается отсутствующим (контракт all-or-nothing). */
export const isSystemAsset = (asset: { system?: boolean; required?: boolean }): boolean =>
    asset.system === true && asset.required === true;
