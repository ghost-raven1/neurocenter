import type { IPackage } from './package.js';
import type { IInstallationInspection } from './installation-inspection.model.js';

/** После чтения папка могла смениться; completion всегда относится к исходному заданию сервера. */
export function assertInspectionIdentity(
    result: IInstallationInspection,
    projectId: string,
    bindingId: string | undefined,
    pkg: IPackage,
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
