import { loadConfig, type EnvReportEntry, type EnvSpec } from '../../../shared/config.cjs';

/** AD-9: config-модуль skills-service — единый владелец чтения окружения и валидации его значений. */
export interface ISkillsConfig {
    port: number;
    bindHost: string;
    internalToken?: string;
}

export interface ISkillsLoadedConfig {
    values: ISkillsConfig;
    report: EnvReportEntry[];
}

const scheme: EnvSpec[] = [
    { name: 'PORT', type: 'positiveInteger', default: 4200, description: 'Порт HTTP skills-service' },
    { name: 'BIND_HOST', type: 'string', default: '127.0.0.1', description: 'Адрес привязки HTTP' },
    { name: 'NEUROCENTER_INTERNAL_TOKEN', type: 'secret', description: 'Внутренний токен сервисных каналов' },
];

export function loadSkillsConfig(env: NodeJS.ProcessEnv = process.env): ISkillsLoadedConfig {
    const { values, report } = loadConfig(scheme, env);
    return {
        values: {
            port: values.PORT as number,
            bindHost: (values.BIND_HOST as string) || '127.0.0.1',
            ...(values.NEUROCENTER_INTERNAL_TOKEN !== undefined
                ? { internalToken: values.NEUROCENTER_INTERNAL_TOKEN as string }
                : {}),
        },
        report,
    };
}
