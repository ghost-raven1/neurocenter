export const featureFlagKeys = ['model_hosting', 'tool_builds', 'rag_sync'] as const;
export type TFeatureFlagKey = typeof featureFlagKeys[number];

export interface IFeatureFlag {
    key: TFeatureFlagKey;
    name: string;
    description: string;
    enabled: boolean;
    revision: number;
    updatedAt: string | null;
    updatedBy: string | null;
}

export interface IFeatureFlagList { items: IFeatureFlag[]; }
export interface IEvaluatedFeatureFlags { flags: Record<TFeatureFlagKey, boolean>; }

/** Неполный ответ не подменяет неизвестное состояние значением по умолчанию. */
export function requireFeatureFlag(value: unknown): IFeatureFlag {
    const flag = value as Partial<IFeatureFlag> | null;
    if (!flag || !featureFlagKeys.includes(flag.key as TFeatureFlagKey) || typeof flag.name !== 'string'
        || typeof flag.description !== 'string' || typeof flag.enabled !== 'boolean'
        || !Number.isSafeInteger(flag.revision) || Number(flag.revision) < 1
        || flag.updatedAt !== null && (typeof flag.updatedAt !== 'string' || !Number.isFinite(Date.parse(flag.updatedAt)))
        || flag.updatedBy !== null && typeof flag.updatedBy !== 'string') {
        throw new Error('Сервер не подтвердил состояние функции. Обновите настройки.');
    }
    return flag as IFeatureFlag;
}

export function requireFeatureFlagList(value: unknown): IFeatureFlag[] {
    const list = value as Partial<IFeatureFlagList> | null;
    if (!list || !Array.isArray(list.items) || list.items.length !== featureFlagKeys.length) {
        throw new Error('Сервер вернул неполный список функций. Повторите загрузку.');
    }
    const flags = list.items.map(requireFeatureFlag);
    if (new Set(flags.map(flag => flag.key)).size !== featureFlagKeys.length) {
        throw new Error('Сервер вернул повторяющиеся функции. Повторите загрузку.');
    }
    return featureFlagKeys.map(key => flags.find(flag => flag.key === key)!);
}
