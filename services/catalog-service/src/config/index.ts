import { loadConfig, type EnvReportEntry, type EnvSpec } from '../../../shared/config.cjs';

/** AD-9: config-модуль catalog-service — единый владелец чтения окружения и валидации его значений. */
export interface ICatalogConfig {
    port: number;
    bindHost: string;
    backupMaxTotalBytes: number;
    backupMaxFileBytes: number;
    backupMinFreeBytes: number;
    contextWindowTokens: number | null;
    ggufImportPolicyJson?: string;
    catalogPgUrl?: string;
    internalToken?: string;
}

export interface ICatalogLoadedConfig {
    values: ICatalogConfig;
    report: EnvReportEntry[];
}

const GiB = 1024 ** 3;

const scheme: EnvSpec[] = [
    { name: 'PORT', type: 'positiveInteger', default: 4100, description: 'Порт HTTP catalog-service' },
    { name: 'BIND_HOST', type: 'string', default: '127.0.0.1', description: 'Адрес привязки HTTP' },
    {
        name: 'BACKUP_MAX_TOTAL_BYTES',
        type: 'positiveInteger',
        default: 64 * GiB,
        description: 'Суммарный лимит резервных копий (байты)',
    },
    {
        name: 'BACKUP_MAX_FILE_BYTES',
        type: 'positiveInteger',
        default: 16 * GiB,
        description: 'Лимит одного файла резервной копии (байты)',
    },
    {
        name: 'BACKUP_MIN_FREE_BYTES',
        type: 'positiveInteger',
        default: GiB,
        description: 'Минимальный свободный диск для копий (байты)',
    },
    {
        name: 'MODEL_CHAT_CONTEXT_WINDOW_TOKENS',
        type: 'positiveInteger',
        min: 128,
        max: 2097152,
        description: 'Окно контекста модели чата (токены; 128..2097152)',
    },
    {
        name: 'GGUF_IMPORT_POLICY_JSON',
        type: 'string',
        description: 'JSON-политика импорта GGUF (валидируется configuredGgufImportPolicy)',
    },
    { name: 'CATALOG_PG_URL', type: 'secret', description: 'Строка подключения PostgreSQL (catalog)' },
    { name: 'NEUROCENTER_INTERNAL_TOKEN', type: 'secret', description: 'Внутренний токен сервисных каналов' },
];

const crossValidate = (values: Record<string, unknown>): string[] => {
    const issues: string[] = [];
    const maxFile = values.BACKUP_MAX_FILE_BYTES as number;
    const maxTotal = values.BACKUP_MAX_TOTAL_BYTES as number;
    if (maxFile > maxTotal) {
        issues.push('BACKUP_MAX_FILE_BYTES превышает BACKUP_MAX_TOTAL_BYTES');
    }
    return issues;
};

export function loadCatalogConfig(env: NodeJS.ProcessEnv = process.env): ICatalogLoadedConfig {
    const { values, report } = loadConfig(scheme, env, crossValidate);
    return {
        values: {
            port: values.PORT as number,
            bindHost: (values.BIND_HOST as string) || '127.0.0.1',
            backupMaxTotalBytes: values.BACKUP_MAX_TOTAL_BYTES as number,
            backupMaxFileBytes: values.BACKUP_MAX_FILE_BYTES as number,
            backupMinFreeBytes: values.BACKUP_MIN_FREE_BYTES as number,
            contextWindowTokens:
                values.MODEL_CHAT_CONTEXT_WINDOW_TOKENS === undefined
                    ? null
                    : (values.MODEL_CHAT_CONTEXT_WINDOW_TOKENS as number),
            ...(values.GGUF_IMPORT_POLICY_JSON !== undefined
                ? { ggufImportPolicyJson: values.GGUF_IMPORT_POLICY_JSON as string }
                : {}),
            ...(values.CATALOG_PG_URL !== undefined ? { catalogPgUrl: values.CATALOG_PG_URL as string } : {}),
            ...(values.NEUROCENTER_INTERNAL_TOKEN !== undefined
                ? { internalToken: values.NEUROCENTER_INTERNAL_TOKEN as string }
                : {}),
        },
        report,
    };
}

let cachedGgufEnv: NodeJS.ProcessEnv | undefined;
/** AD-9: env-снимок для configuredGgufImportPolicy (инжекция — shared-модуль не читает process.env сам). */
export function ggufPolicyEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    if (cachedGgufEnv) return cachedGgufEnv;
    const { values } = loadCatalogConfig(env);
    cachedGgufEnv =
        values.ggufImportPolicyJson !== undefined ? { GGUF_IMPORT_POLICY_JSON: values.ggufImportPolicyJson } : {};
    return cachedGgufEnv;
}
