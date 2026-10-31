import { hash, hub, readState, type Credentials } from '../../bridge/state.js';
import { verify, type Package } from '../../bridge/package.js';
import { packageDependencies, packageRef, verifyInstallSet, type InstallSet } from '../../bridge/install-set.js';
import { projectFolder, projectBindingId, projectInstanceId } from '../../bridge/workspace.js';
import { inspectInstallation } from '../../bridge/installation-inspection.js';
import { assertInspectionIdentity } from '../../bridge/inspection-identity.js';
import { localConfigurationDigest, parseLocalConfiguration } from './schema.js';

export interface ConfigurationTuple {
    schemaVersion: 1;
    projectId: string;
    bindingId: string;
    instanceId: string;
    assetId: string;
    assetKind: 'mcp';
    version: number;
    manifest: string;
    schemaDigest: string;
}
/** Секреты привязаны к физическому экземпляру, а не к переносимому marker или имени папки. */
export async function configurationContext(
    projectId: string,
    source: Package,
    set: InstallSet | undefined,
    authorize: () => Promise<void>,
    options: { allowNotInstalled?: boolean } = {},
) {
    const pkg = structuredClone(source);
    verify(pkg);
    const schema = parseLocalConfiguration(pkg);
    if (!schema) {
        throw new Error('У MCP нет схемы локальной настройки.');
    }
    if (set) {
        if (set.packages.length === 1) {
            if (
                set.schemaVersion !== 1 ||
                set.manifest !== pkg.manifest.sha256 ||
                packageDependencies(pkg).length ||
                JSON.stringify(set.root) !== JSON.stringify(packageRef(pkg)) ||
                JSON.stringify(packageRef(set.packages[0]!)) !== JSON.stringify(packageRef(pkg))
            ) {
                throw new Error('Некорректный одобренный комплект.');
            }
        } else {
            verifyInstallSet(structuredClone(set));
        }
        if (!set.packages.some((member) => JSON.stringify(packageRef(member)) === JSON.stringify(packageRef(pkg)))) {
            throw new Error('MCP отсутствует в одобренном комплекте.');
        }
    }
    await authorize();
    const root = await projectFolder(projectId);
    const bindingId = await projectBindingId(projectId);
    const instanceId = await projectInstanceId(projectId);
    const credentials = await readState<Credentials>('credentials');
    if (!credentials?.deviceId) {
        throw new Error('Компьютер не подключён.');
    }
    const tuple: ConfigurationTuple = {
        schemaVersion: 1,
        projectId,
        bindingId,
        instanceId,
        assetId: pkg.plugin.id,
        assetKind: 'mcp',
        version: pkg.plugin.version,
        manifest: pkg.manifest.sha256,
        schemaDigest: localConfigurationDigest(schema),
    };
    const scope = {
        server: hub(),
        deviceId: credentials.deviceId,
        projectId,
        instanceId,
        assetId: pkg.plugin.id,
        schemaDigest: tuple.schemaDigest,
    };
    const assertIdentity = async () => {
        if (
            (await projectFolder(projectId)) !== root ||
            (await projectBindingId(projectId)) !== bindingId ||
            (await projectInstanceId(projectId)) !== instanceId ||
            (await readState<Credentials>('credentials'))?.deviceId !== credentials.deviceId
        ) {
            throw new Error('Привязка настройки изменилась.');
        }
    };
    const assertCurrent = async () => {
        await assertIdentity();
        const inspection = await inspectInstallation(projectId, pkg);
        assertInspectionIdentity(inspection, projectId, bindingId, pkg);
        if (inspection.status !== 'synced') {
            throw new Error('Проверьте файлы текущей установки перед настройкой.');
        }
    };
    await (options.allowNotInstalled ? assertIdentity() : assertCurrent());
    return { pkg, schema, tuple, scope, key: hash(JSON.stringify(scope)), root, assertCurrent, assertIdentity };
}
export type ConfigurationContext = Awaited<ReturnType<typeof configurationContext>>;
