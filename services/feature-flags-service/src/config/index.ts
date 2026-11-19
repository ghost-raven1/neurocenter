import { loadConfig, type EnvReportEntry, type EnvSpec } from '../../../shared/config.cjs';

/** AD-9: config-модуль feature-flags-service — единый владелец чтения окружения и валидации его значений. */
export interface IFeatureFlagsConfig {
    port: number;
    bindHost: string;
    catalogPgUrl?: string;
    internalToken?: string;
}

export interface IFeatureFlagsLoadedConfig {
    values: IFeatureFlagsConfig;
    report: EnvReportEntry[];
}

const scheme: EnvSpec[] = [
    { name: 'PORT', type: 'positiveInteger', default: 4400, description: 'Порт HTTP feature-flags-service' },
    { name: 'BIND_HOST', type: 'string', default: '127.0.0.1', description: 'Адрес привязки HTTP' },
    { name: 'CATALOG_PG_URL', type: 'secret', description: 'Строка подключения PostgreSQL (catalog)' },
    { name: 'NEUROCENTER_INTERNAL_TOKEN', type: 'secret', description: 'Внутренний токен сервисных каналов' },
];

export function loadFeatureFlagsConfig(env: NodeJS.ProcessEnv = process.env): IFeatureFlagsLoadedConfig {
    const { values, report } = loadConfig(scheme, env);
    return {
        values: {
            port: values.PORT as number,
            bindHost: (values.BIND_HOST as string) || '127.0.0.1',
            ...(values.CATALOG_PG_URL !== undefined ? { catalogPgUrl: values.CATALOG_PG_URL as string } : {}),
            ...(values.NEUROCENTER_INTERNAL_TOKEN !== undefined
                ? { internalToken: values.NEUROCENTER_INTERNAL_TOKEN as string }
                : {}),
        },
        report,
    };
}
