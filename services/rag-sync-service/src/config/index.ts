import { loadConfig, type EnvReportEntry, type EnvSpec } from '../../../shared/config.cjs';

/** AD-9: config-модуль rag-sync-service — единый владелец чтения окружения и валидации его значений. */
export interface IRagSyncConfig {
    port: number;
    bindHost: string;
    ragDefaultQuotaBytes: number;
    ragMaxQuotaBytes: number;
    ragPqUrl?: string;
    internalToken?: string;
}

export interface IRagSyncLoadedConfig {
    values: IRagSyncConfig;
    report: EnvReportEntry[];
}

const GiB = 1024 ** 3;

const scheme: EnvSpec[] = [
    { name: 'PORT', type: 'positiveInteger', default: 4300, description: 'Порт HTTP rag-sync-service' },
    { name: 'BIND_HOST', type: 'string', default: '127.0.0.1', description: 'Адрес привязки HTTP' },
    {
        name: 'RAG_DEFAULT_QUOTA_BYTES',
        type: 'positiveInteger',
        default: GiB,
        description: 'Квота по умолчанию базы знаний (байты)',
    },
    {
        name: 'RAG_MAX_QUOTA_BYTES',
        type: 'positiveInteger',
        default: 16 * GiB,
        description: 'Максимальная квота базы знаний (байты)',
    },
    { name: 'RAG_PG_URL', type: 'secret', description: 'Строка подключения PostgreSQL (rag)' },
    { name: 'NEUROCENTER_INTERNAL_TOKEN', type: 'secret', description: 'Внутренний токен сервисных каналов' },
];

const crossValidate = (values: Record<string, unknown>): string[] => {
    const defaultBytes = values.RAG_DEFAULT_QUOTA_BYTES as number;
    const maxBytes = values.RAG_MAX_QUOTA_BYTES as number;
    return defaultBytes > maxBytes ? ['RAG_DEFAULT_QUOTA_BYTES превышает RAG_MAX_QUOTA_BYTES'] : [];
};

export function loadRagSyncConfig(env: NodeJS.ProcessEnv = process.env): IRagSyncLoadedConfig {
    const { values, report } = loadConfig(scheme, env, crossValidate);
    return {
        values: {
            port: values.PORT as number,
            bindHost: (values.BIND_HOST as string) || '127.0.0.1',
            ragDefaultQuotaBytes: values.RAG_DEFAULT_QUOTA_BYTES as number,
            ragMaxQuotaBytes: values.RAG_MAX_QUOTA_BYTES as number,
            ...(values.RAG_PG_URL !== undefined ? { ragPqUrl: values.RAG_PG_URL as string } : {}),
            ...(values.NEUROCENTER_INTERNAL_TOKEN !== undefined
                ? { internalToken: values.NEUROCENTER_INTERNAL_TOKEN as string }
                : {}),
        },
        report,
    };
}
