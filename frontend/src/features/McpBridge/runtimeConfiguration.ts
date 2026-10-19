import type { IBridgeInstallation } from './api';
import type { IInstallPlan } from './installPlanTypes';
import type { IMcpConfigurationRevision } from './mcpConfigurationTypes';
import { matchingConfigurationStatus } from './mcpConfiguration';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function hasLocalConfiguration(config: unknown): boolean {
    return record(config) && record(config.extra) && record(config.extra.localConfiguration);
}

/** Согласие охватывает настройки каждого MCP в закреплённом комплекте, включая зависимости скилла. */
export function runtimeConfiguration(plan: IInstallPlan, item: IBridgeInstallation, installations: IBridgeInstallation[]): {
    revisions: IMcpConfigurationRevision[]; blocker: string;
} {
    const packages = plan.packages?.length ? plan.packages : [{id:plan.assetId,kind:plan.assetKind,version:plan.version,manifest:plan.manifest,config:plan.config,name:item.name}];
    const revisions: IMcpConfigurationRevision[] = [];
    for (const pkg of packages) {
        if (pkg.kind !== 'mcp' || !hasLocalConfiguration(pkg.config)) { continue; }
        const installed = installations.find(row => row.deviceId === item.deviceId && row.projectId === item.projectId
            && row.bindingId === item.bindingId && row.isCurrentBinding !== false && !row.bindingChanged && !row.legacyBinding
            && row.assetKind === 'mcp' && row.assetId === pkg.id && row.manifest === pkg.manifest && row.version === pkg.version);
        const status = installed && matchingConfigurationStatus(installed.configuration,installed);
        if (!status?.ready) { return {revisions:[],blocker:`Сначала настройте MCP «${pkg.name}» в разделе «На этом компьютере» и проверьте готовность настройки.`}; }
        revisions.push({assetId:pkg.id,manifest:pkg.manifest,revision:status.revision});
    }
    return {revisions:revisions.sort((a,b) => a.assetId === b.assetId ? 0 : a.assetId < b.assetId ? -1 : 1),blocker:''};
}

/** Изменение или удаление настройки любого участника делает прежнюю диагностику неактуальной. */
export function runtimeConfigurationChanged(item: IBridgeInstallation, installations: IBridgeInstallation[]): boolean {
    const pinned = item.runtime?.configurationRevisions;
    if (!pinned?.length) { return !!item.configurationSchemaDigest; }
    return pinned.some(pin => {
        const row = installations.find(value => value.deviceId === item.deviceId && value.projectId === item.projectId
            && value.bindingId === item.bindingId && value.assetKind === 'mcp' && value.assetId === pin.assetId && value.manifest === pin.manifest
            && !value.bindingChanged && !value.legacyBinding && value.isCurrentBinding !== false);
        const status = row && matchingConfigurationStatus(row.configuration,row);
        return !status?.ready || status.revision !== pin.revision;
    });
}
