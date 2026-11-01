import type { IPackage } from '../../bridge/package.js';
import { packageRef, referenceKey } from '../../bridge/install-set.js';
import { readMcpConfiguration } from '../local-configuration/index.js';
import { parseLocalConfiguration } from '../local-configuration/schema.js';
import { ProbeError, type IRuntimeProbeInput, type IConfigurationRevision } from './model.js';

/** Каждый MCP получает только собственные параметры; ревизии всего набора закреплены согласием. */
export async function probeConfigurations(
    input: IRuntimeProbeInput,
): Promise<{ revisions: IConfigurationRevision[]; packages: Map<string, IPackage> }> {
    const revisions: IConfigurationRevision[] = [];
    const packages = new Map<string, IPackage>();
    for (const pkg of input.frozenSet.packages) {
        if (!parseLocalConfiguration(pkg)) {
            continue;
        }
        let local;
        try {
            local = await readMcpConfiguration(input.projectId, pkg, input.frozenSet, async () => {});
        } catch {
            throw new ProbeError('needs_configuration', 'configuration-required');
        }
        revisions.push({ assetId: pkg.plugin.id, manifest: pkg.manifest.sha256, revision: local.revision });
        packages.set(referenceKey(packageRef(pkg)), {
            ...pkg,
            config: {
                ...pkg.config,
                env: { ...pkg.config?.env, ...local.env },
                headers: { ...pkg.config?.headers, ...local.headers },
            },
        });
    }
    revisions.sort((a, b) => (a.assetId === b.assetId ? 0 : a.assetId < b.assetId ? -1 : 1));
    if (revisions.length || input.configurationRevisions?.length) {
        if (JSON.stringify(revisions) !== JSON.stringify(input.configurationRevisions)) {
            throw new ProbeError('stale', 'configuration-changed');
        }
    }
    return { revisions, packages };
}
