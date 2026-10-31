import { fileURLToPath } from 'node:url';
import { canonicalV4, type Package } from '../../bridge/package.js';
import { assetKey } from '../../bridge/installation-receipt.js';
import { hash, hub, readState, type Credentials } from '../../bridge/state.js';
import { projectInstanceId } from '../../bridge/workspace.js';
import { parseLocalConfiguration } from './schema.js';
import type { ConfigurationContext } from './context.js';
import { readPrivateConfiguration, writePrivateConfiguration } from './private-store.js';
export interface LauncherDescriptor {
    schemaVersion: 1;
    projectId: string;
    pkg: Package;
}

/** В конфиге проекта остаётся только команда launcher, без значений параметров и ссылок на secret-файл. */
export function configurationConnection(
    root: string,
    pkg: Package,
): { type: 'local'; enabled: true; command: string[] } | undefined {
    if (!parseLocalConfiguration(pkg)) {
        return undefined;
    }
    const launcher = fileURLToPath(
        new URL(
            import.meta.url.endsWith('.ts')
                ? '../../../dist/features/local-configuration/launcher-cli.js'
                : './launcher-cli.js',
            import.meta.url,
        ),
    );
    return {
        type: 'local',
        enabled: true,
        command: [process.execPath, launcher, root, assetKey(pkg), pkg.manifest.sha256],
    };
}
export async function launcherDescriptorKey(projectId: string, key: string, manifest: string): Promise<string> {
    const deviceId = (await readState<Credentials>('credentials'))?.deviceId;
    if (!deviceId) {
        throw new Error('configuration-required');
    }
    return hash(
        JSON.stringify([
            'configuration-launcher',
            hub(),
            deviceId,
            projectId,
            await projectInstanceId(projectId),
            key,
            manifest,
        ]),
    );
}
export async function saveLauncherDescriptor(context: ConfigurationContext): Promise<void> {
    const key = await launcherDescriptorKey(
        context.tuple.projectId,
        assetKey(context.pkg),
        context.pkg.manifest.sha256,
    );
    const before = await readPrivateConfiguration(key);
    const pkg = structuredClone(context.pkg);
    pkg.files.sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
    const value: LauncherDescriptor = { schemaVersion: 1, projectId: context.tuple.projectId, pkg };
    if (before !== undefined) {
        if (JSON.stringify(canonicalV4(before)) !== JSON.stringify(canonicalV4(value))) {
            throw new Error('Закреплённый launcher-дескриптор повреждён.');
        }
        return;
    }
    await writePrivateConfiguration(key, value, undefined);
}
