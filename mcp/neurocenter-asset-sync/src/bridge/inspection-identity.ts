import type { Package } from './package.js';
import type { InstallationInspection } from './installation-inspection.model.js';

/** После чтения папка могла смениться; completion всегда относится к исходному заданию сервера. */
export function assertInspectionIdentity(
    result: InstallationInspection,
    projectId: string,
    bindingId: string | undefined,
    pkg: Package,
): void {
    if (
        result.projectId !== projectId ||
        result.bindingId !== bindingId ||
        result.assetId !== pkg.plugin.id ||
        result.assetKind !== pkg.plugin.kind ||
        result.version !== pkg.plugin.version ||
        result.manifest !== pkg.manifest.sha256
    ) {
        throw new Error('Результат проверки не соответствует исходному заданию.');
    }
}
