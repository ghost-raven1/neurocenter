import registry from '../../../../services/shared/feature-flag-catalog.json';
import type { IFeatureFlagDefinition } from '../../../../services/shared/feature-flags.cjs';
import type { TFeatureFlagGroup } from './interfaces';

export const featureDefinitions = registry as readonly IFeatureFlagDefinition[];

export const featureFlagKeys = featureDefinitions.map((flag) => flag.key);

export const featureGroups: ReadonlyArray<{ key: TFeatureFlagGroup; name: string }> = [
    { key: 'platform', name: 'Проекты и компьютеры' },
    { key: 'catalog', name: 'Каталог и поставки' },
    { key: 'models', name: 'Модели' },
    { key: 'agents', name: 'Чаты и агенты' },
    { key: 'knowledge', name: 'Знания и поиск' },
    { key: 'operations', name: 'Снимки, копии и отчёты' },
];

/** Browser notification after a flag change. */
export const FEATURE_FLAGS_CHANGED = 'neurocenter:feature-flags-changed';
