import { missingLaunchFields } from './launch-fields.js';
import { randomUUID } from 'node:crypto';
import { hash } from '../../bridge/state.js';
import type { Package } from '../../bridge/package.js';
import type { InstallSet } from '../../bridge/install-set.js';
import { openVerificationPage } from '../../bridge/open-browser.js';
import { configurationContext, type ConfigurationTuple } from './context.js';
import { configurationStatus, readConfiguration } from './state.js';
import { configurationTargets } from './schema.js';
import { readPrivateConfiguration, writePrivateConfiguration } from './private-store.js';
import { startConfigurationSession } from './server.js';
import { saveLauncherDescriptor } from './launcher-descriptor.js';
export { parseLocalConfiguration, localConfigurationDigest } from './schema.js';
export type { LocalConfigurationSchema, LocalConfigurationField } from './schema.js';
export interface ConfigurationPreparation extends ConfigurationTuple {
    preparationId: string;
    expiresAt: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** После файловой транзакции сохраняет только одобренный launcher-дескриптор, без параметров. */
export async function ensureMcpConfigurationLauncher(
    projectId: string,
    pkg: Package,
    set: InstallSet | undefined,
    authorize: () => Promise<void>,
): Promise<void> {
    await saveLauncherDescriptor(await configurationContext(projectId, pkg, set, authorize));
}
/** Инертный дескриптор готовится до транзакции: запуск потребует актуальную квитанцию всех файлов. */
export async function prepareMcpConfigurationLauncher(
    projectId: string,
    pkg: Package,
    set: InstallSet | undefined,
    authorize: () => Promise<void>,
): Promise<void> {
    const context = await configurationContext(projectId, pkg, set, authorize, { allowNotInstalled: true });
    await context.assertIdentity();
    await saveLauncherDescriptor(context);
}

/** Подготовка не открывает браузер и не читает значения в публичный результат. */
export async function prepareMcpConfiguration(
    projectId: string,
    pkg: Package,
    set: InstallSet | undefined,
    authorize: () => Promise<void>,
): Promise<ConfigurationPreparation> {
    const context = await configurationContext(projectId, pkg, set, authorize);
    const result = {
        ...context.tuple,
        preparationId: randomUUID(),
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    await writePrivateConfiguration(hash('configuration-preparation:' + result.preparationId), result, undefined);
    return result;
}
/** Открытие возвращается немедленно; свежая проверка прав перед сохранением передаётся отдельно от lease задания. */
export async function openMcpConfiguration(
    projectId: string,
    pkg: Package,
    set: InstallSet | undefined,
    options: {
        preparationId: string;
        schemaDigest: string;
        authorizeSave?: () => Promise<void>;
        open?: (url: string) => Promise<boolean>;
    },
    authorize: () => Promise<void>,
) {
    if (!uuid.test(options.preparationId)) {
        throw new Error('Подготовьте настройку заново.');
    }
    const context = await configurationContext(projectId, pkg, set, authorize);
    const prepared = await readPrivateConfiguration<ConfigurationPreparation>(
        hash('configuration-preparation:' + options.preparationId),
    );
    if (
        !prepared ||
        prepared.schemaDigest !== options.schemaDigest ||
        !Number.isFinite(Date.parse(prepared.expiresAt)) ||
        Date.parse(prepared.expiresAt) <= Date.now() ||
        Date.parse(prepared.expiresAt) > Date.now() + 15 * 60_000 ||
        JSON.stringify({ ...context.tuple, preparationId: prepared.preparationId, expiresAt: prepared.expiresAt }) !==
            JSON.stringify(prepared)
    ) {
        throw new Error('Подготовка настройки устарела.');
    }
    await saveLauncherDescriptor(context);
    await startConfigurationSession(
        context,
        prepared.preparationId,
        prepared.expiresAt,
        options.authorizeSave ?? authorize,
        options.open ?? openVerificationPage,
    );
    return {
        ...context.tuple,
        preparationId: prepared.preparationId,
        opened: true as const,
        expiresAt: prepared.expiresAt,
    };
}
export async function getMcpConfigurationStatus(
    projectId: string,
    pkg: Package,
    set: InstallSet | undefined,
    authorize: () => Promise<void>,
) {
    return configurationStatus(await configurationContext(projectId, pkg, set, authorize));
}
/** Этот результат остаётся внутри MCP-процесса и никогда не включается в completion задания. */
export async function readMcpConfiguration(
    projectId: string,
    pkg: Package,
    set: InstallSet | undefined,
    authorize: () => Promise<void>,
) {
    const context = await configurationContext(projectId, pkg, set, authorize);
    const stored = await readConfiguration(context);
    if (missingLaunchFields(context.pkg, context.schema, stored?.values ?? {}).length) {
        throw new Error('configuration-required');
    }
    return { revision: stored?.revision ?? null, ...configurationTargets(context.schema, stored?.values ?? {}) };
}
