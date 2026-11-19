import { loadConfig, type EnvReportEntry, type EnvSpec } from '../../../shared/config.cjs';

/** AD-9: config-модуль oauth2-bridge — единый владелец чтения окружения и валидации его значений. */
export interface IOauth2BridgeConfig {
    port: number;
    bindHost: string;
    panelUrl?: string;
    ssoHost?: string;
    ssoClientId?: string;
    redirectUri?: string;
    ssoDisable?: boolean;
    ssoClientSecret?: string;
}

export interface IOauth2BridgeLoadedConfig {
    values: IOauth2BridgeConfig;
    report: EnvReportEntry[];
}

const scheme: EnvSpec[] = [
    { name: 'PORT', type: 'positiveInteger', default: 22222, description: 'Порт HTTP oauth2-bridge' },
    { name: 'BIND_HOST', type: 'string', default: '127.0.0.1', description: 'Адрес привязки HTTP' },
    { name: 'PANEL_URL', type: 'string', description: 'Публичный URL панели' },
    { name: 'SSO_HOST', type: 'string', description: 'Хост SSO-провайдера' },
    { name: 'SSO_CLIENT_ID', type: 'string', description: 'Идентификатор SSO-клиента' },
    { name: 'REDIRECT_URI', type: 'string', description: 'URI редиректа SSO' },
    { name: 'SSO_DISABLE', type: 'boolean', description: 'Отключение SSO (только dev)' },
    { name: 'SSO_CLIENT_SECRET', type: 'secret', description: 'Секрет SSO-клиента' },
];

export function loadOauth2BridgeConfig(env: NodeJS.ProcessEnv = process.env): IOauth2BridgeLoadedConfig {
    const { values, report } = loadConfig(scheme, env);
    return {
        values: {
            port: values.PORT as number,
            bindHost: (values.BIND_HOST as string) || '127.0.0.1',
            ...(values.PANEL_URL !== undefined ? { panelUrl: values.PANEL_URL as string } : {}),
            ...(values.SSO_HOST !== undefined ? { ssoHost: values.SSO_HOST as string } : {}),
            ...(values.SSO_CLIENT_ID !== undefined ? { ssoClientId: values.SSO_CLIENT_ID as string } : {}),
            ...(values.REDIRECT_URI !== undefined ? { redirectUri: values.REDIRECT_URI as string } : {}),
            ...(values.SSO_DISABLE !== undefined ? { ssoDisable: values.SSO_DISABLE as boolean } : {}),
            ...(values.SSO_CLIENT_SECRET !== undefined ? { ssoClientSecret: values.SSO_CLIENT_SECRET as string } : {}),
        },
        report,
    };
}
