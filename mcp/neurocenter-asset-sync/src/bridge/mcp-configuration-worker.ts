import type { Package } from './package.js';
import type { InstallSet } from './install-set.js';
import {
    prepareMcpConfiguration,
    openMcpConfiguration,
    getMcpConfigurationStatus,
    prepareMcpConfigurationLauncher,
    parseLocalConfiguration,
} from '../features/local-configuration/index.js';

export const CONFIGURATION_KINDS = [
    'prepare-mcp-configuration',
    'open-mcp-configuration',
    'get-mcp-configuration-status',
];
export interface ConfigurationPayload {
    package?: Package;
    installSet?: InstallSet;
    schemaDigest?: string;
    configurationPreparationId?: string;
}
/** Только инертные дескрипторы до commit: ошибка не может превратить успешную установку в ложный rollback. */
export async function prepareJobMcpLaunchers(
    projectId: string,
    pkg: Package,
    set: InstallSet | undefined,
    authorize: () => Promise<unknown>,
): Promise<void> {
    for (const member of set?.packages ?? [pkg])
        if (parseLocalConfiguration(member))
            await prepareMcpConfigurationLauncher(projectId, member, set, async () => {
                await authorize();
            });
}
/** Очередь передаёт только закреплённую версию; значения вводятся непосредственно на компьютере. */
export async function runMcpConfigurationJob(
    job: { kind: string; project_id?: string; payload: ConfigurationPayload },
    authorize: () => Promise<unknown>,
    authorizeSave: () => Promise<unknown>,
): Promise<unknown> {
    const pkg = job.payload.package;
    if (!pkg) throw new Error('В задании нет установленного MCP.');
    const check = async () => {
        await authorize();
    };
    const project = job.project_id ?? '';
    if (job.kind === 'prepare-mcp-configuration')
        return prepareMcpConfiguration(project, pkg, job.payload.installSet, check);
    if (job.kind === 'get-mcp-configuration-status')
        return getMcpConfigurationStatus(project, pkg, job.payload.installSet, check);
    if (job.kind === 'open-mcp-configuration')
        return openMcpConfiguration(
            project,
            pkg,
            job.payload.installSet,
            {
                preparationId: job.payload.configurationPreparationId ?? '',
                schemaDigest: job.payload.schemaDigest ?? '',
                authorizeSave: async () => {
                    await authorizeSave();
                },
            },
            check,
        );
    throw new Error('Неизвестное действие настройки MCP.');
}
