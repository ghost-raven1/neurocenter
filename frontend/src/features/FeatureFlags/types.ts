import registry from '../../../../services/shared/feature-flag-catalog.json';
import type { FeatureFlagKey, IFeatureFlagDefinition } from '../../../../services/shared/feature-flags.cjs';

export const featureDefinitions = registry as readonly IFeatureFlagDefinition[];
export const featureFlagKeys = featureDefinitions.map(flag => flag.key);
export type TFeatureFlagKey = FeatureFlagKey;
export type TFeatureFlagGroup = IFeatureFlagDefinition['group'];
export const featureGroups: ReadonlyArray<{ key: TFeatureFlagGroup; name: string }> = [
    { key: 'platform', name: 'Проекты и компьютеры' }, { key: 'catalog', name: 'Каталог и ассеты' },
    { key: 'models', name: 'Модели' }, { key: 'agents', name: 'Чаты и агенты' },
    { key: 'knowledge', name: 'Знания и поиск' }, { key: 'operations', name: 'Снимки, копии и отчёты' },
];

export interface IFeatureFlag {
    key: TFeatureFlagKey;
    name: string;
    description: string;
    group: TFeatureFlagGroup;
    dependsOn: readonly TFeatureFlagKey[];
    enabled: boolean;
    revision: number;
    updatedAt: string | null;
    updatedBy: string | null;
}

export interface IFeatureFlagList { items: IFeatureFlag[]; }
export interface IEvaluatedFeatureFlags {
    flags: Record<TFeatureFlagKey, boolean>;
    configured: Record<TFeatureFlagKey, boolean>;
    blockedBy: Record<TFeatureFlagKey, TFeatureFlagKey[]>;
}

/** Browser and services share definitions; server effective values remain authoritative. */
export function featureDefinition(key: TFeatureFlagKey): IFeatureFlagDefinition {
    return featureDefinitions.find(flag => flag.key === key)!;
}

export function assetCatalogFeature(kind: 'mcp' | 'plugin' | 'skill' | 'model' | 'agent' | 'bridge'): TFeatureFlagKey {
    return kind === 'model' ? 'model_catalog' : kind === 'agent' ? 'agents' : kind === 'bridge' ? 'computer_connections' : 'tool_catalog';
}

/** Неполный ответ не подменяет неизвестное состояние значением по умолчанию. */
export function requireFeatureFlag(value: unknown): IFeatureFlag {
    const flag = value as Partial<IFeatureFlag> | null;
    const definition = featureDefinitions.find(item => item.key === flag?.key);
    if (!flag || !featureFlagKeys.includes(flag.key as TFeatureFlagKey) || typeof flag.name !== 'string'
        || typeof flag.description !== 'string' || typeof flag.enabled !== 'boolean'
        || flag.group !== definition?.group || !Array.isArray(flag.dependsOn)
        || flag.dependsOn.join(',') !== definition?.dependsOn.join(',')
        || !Number.isSafeInteger(flag.revision) || Number(flag.revision) < 1
        || flag.updatedAt !== null && (typeof flag.updatedAt !== 'string' || !Number.isFinite(Date.parse(flag.updatedAt)))
        || flag.updatedBy !== null && typeof flag.updatedBy !== 'string') {
        throw new Error('Сервер не подтвердил состояние функции. Обновите настройки.');
    }
    return flag as IFeatureFlag;
}

/** Missing keys or malformed dependency states never turn an unknown function on. */
export function requireEvaluatedFeatureFlags(value: unknown): IEvaluatedFeatureFlags {
    const data = value as Partial<IEvaluatedFeatureFlags> | null;
    if (!data || !data.flags || !data.configured || !data.blockedBy || featureFlagKeys.some(key =>
        typeof data.flags?.[key] !== 'boolean' || typeof data.configured?.[key] !== 'boolean'
        || !Array.isArray(data.blockedBy?.[key]) || data.blockedBy[key].some(item => !featureFlagKeys.includes(item))
        || data.flags[key] && (!data.configured[key] || data.blockedBy[key].length > 0))) {
        throw new Error('Сервер не подтвердил полный список функций. Повторите загрузку.');
    }
    return data as IEvaluatedFeatureFlags;
}

/** Dependencies explain an enabled switch that is currently blocked by another setting. */
export function configuredBlockers(key: TFeatureFlagKey, items: readonly IFeatureFlag[]): TFeatureFlagKey[] {
    const visited = new Set<TFeatureFlagKey>(), blocked: TFeatureFlagKey[] = [];
    const visit = (current: TFeatureFlagKey): void => {
        for (const dependency of featureDefinition(current).dependsOn) {
            if (visited.has(dependency)) continue;
            visited.add(dependency);
            if (items.find(flag => flag.key === dependency)?.enabled === false) blocked.push(dependency);
            visit(dependency);
        }
    };
    visit(key);
    return blocked;
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
