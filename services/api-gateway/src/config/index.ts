import { loadConfig, type EnvReportEntry, type EnvSpec } from '../../../shared/config.cjs';
import type { IMcpHostLimits } from '../features/mcp-host/host';

/** AD-9: config-модуль api-gateway — единый владелец чтения окружения и валидации его значений. */
export interface IApiGatewayConfig {
    port: number;
    bindHost: string;
    mcpHostMax: number;
    mcpHostMaxPerProject: number;
    mcpHostMaxPerDevice: number;
    mcpHostMaxChannels: number;
    mcpHostAuthzTtlMs: number;
    mcpHostSecret?: string;
    internalToken?: string;
}

export interface IApiGatewayLoadedConfig {
    values: IApiGatewayConfig;
    report: EnvReportEntry[];
}

const scheme: EnvSpec[] = [
    { name: 'PORT', type: 'positiveInteger', default: 4000, description: 'Порт HTTP api-gateway' },
    { name: 'BIND_HOST', type: 'string', default: '127.0.0.1', description: 'Адрес привязки HTTP' },
    {
        name: 'NEUROCENTER_MCP_HOST_MAX',
        type: 'positiveInteger',
        default: 4,
        min: 1,
        description: 'Глобальный пул child-MCP (AD-4, AD-9)',
    },
    {
        name: 'NEUROCENTER_MCP_HOST_MAX_PER_PROJECT',
        type: 'positiveInteger',
        default: 8,
        min: 1,
        description: 'Активные хосты одного проекта (AD-4)',
    },
    {
        name: 'NEUROCENTER_MCP_HOST_MAX_PER_DEVICE',
        type: 'positiveInteger',
        default: 2,
        min: 1,
        description: 'Активные хосты одного устройства (AD-4)',
    },
    {
        name: 'NEUROCENTER_MCP_HOST_MAX_CHANNELS',
        type: 'positiveInteger',
        default: 4,
        min: 1,
        description: 'Активные каналы на один hostKey (AD-4)',
    },
    {
        name: 'NEUROCENTER_MCP_HOST_AUTHZ_TTL_MS',
        type: 'positiveInteger',
        default: 60000,
        min: 1,
        max: 60000,
        description: 'TTL единого кэша device↔project re-check (AD-4)',
    },
    {
        name: 'NEUROCENTER_MCP_HOST_SECRET',
        type: 'secret',
        description: 'Секрет хоста MCP (AD-5, отдельный trust-domain)',
    },
    {
        name: 'NEUROCENTER_INTERNAL_TOKEN',
        type: 'secret',
        description: 'Внутренний токен сервисных каналов',
    },
];

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): IApiGatewayLoadedConfig {
    const { values, report } = loadConfig(scheme, env);
    return {
        values: {
            port: values.PORT as number,
            bindHost: (values.BIND_HOST as string) || '127.0.0.1',
            mcpHostMax: values.NEUROCENTER_MCP_HOST_MAX as number,
            mcpHostMaxPerProject: values.NEUROCENTER_MCP_HOST_MAX_PER_PROJECT as number,
            mcpHostMaxPerDevice: values.NEUROCENTER_MCP_HOST_MAX_PER_DEVICE as number,
            mcpHostMaxChannels: values.NEUROCENTER_MCP_HOST_MAX_CHANNELS as number,
            mcpHostAuthzTtlMs: values.NEUROCENTER_MCP_HOST_AUTHZ_TTL_MS as number,
            ...(values.NEUROCENTER_MCP_HOST_SECRET !== undefined
                ? { mcpHostSecret: values.NEUROCENTER_MCP_HOST_SECRET as string }
                : {}),
            ...(values.NEUROCENTER_INTERNAL_TOKEN !== undefined
                ? { internalToken: values.NEUROCENTER_INTERNAL_TOKEN as string }
                : {}),
        },
        report,
    };
}

/** AD-9: лимиты пула MCP-хостов берутся из config-модуля (не raw process.env в feature-коде). */
export function gatewayMcpHostLimits(env: NodeJS.ProcessEnv = process.env): IMcpHostLimits {
    const { values } = loadGatewayConfig(env);
    return {
        maxHosts: values.mcpHostMax,
        maxPerProject: values.mcpHostMaxPerProject,
        maxPerDevice: values.mcpHostMaxPerDevice,
        maxChannelsPerHost: values.mcpHostMaxChannels,
        authzCacheTtlMs: values.mcpHostAuthzTtlMs,
    };
}
