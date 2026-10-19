import type { IInstallPlanPackage } from '../../../features/McpBridge/installPlanTypes';
import { packageRuntimeArtifacts } from '../../../features/McpBridge/runtimeArtifacts';

/** Скрывает только готовые файлы, уже показанные отдельным блоком плана. Сам план не меняется. */
export function installPlanConfigPreview(config: IInstallPlanPackage['config']): IInstallPlanPackage['config'] {
    if (!config || !packageRuntimeArtifacts({config}).length) { return config; }
    const extra = {...config.extra as Record<string, unknown>};
    delete extra.runtimeArtifacts;
    const preview = {...config};
    if (Object.keys(extra).length) { preview.extra = extra; }
    else { delete preview.extra; }
    return preview;
}
