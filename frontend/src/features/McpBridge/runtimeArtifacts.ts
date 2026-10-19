import type { IBridgeDevice } from './api';
import type { IInstallPlan, IInstallPlanPackage } from './installPlanTypes';
import { hasLocalConfiguration } from './runtimeConfiguration';

export const artifactTargets = ['darwin-arm64','darwin-x64','linux-arm64-glibc','linux-x64-glibc','linux-arm64-musl','linux-x64-musl','win32-arm64','win32-x64'] as const;
export interface IRuntimeArtifact {
    target: typeof artifactTargets[number]; sha256: string; compressedBytes: number; unpackedBytes: number;
    filesCount: number; entrypoint: string; executable?: boolean;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function declaredArtifacts(pkg: Pick<IInstallPlanPackage,'config'>): unknown {
    return record(pkg.config) && record(pkg.config.extra) ? pkg.config.extra.runtimeArtifacts : undefined;
}
function artifactMetadata(value: unknown): value is IRuntimeArtifact {
    return record(value) && artifactTargets.includes(value.target as typeof artifactTargets[number]) && typeof value.sha256 === 'string'
        && /^[a-f0-9]{64}$/.test(value.sha256) && typeof value.entrypoint === 'string' && !!value.entrypoint && value.entrypoint.length <= 240
        && typeof value.compressedBytes === 'number' && Number.isSafeInteger(value.compressedBytes) && value.compressedBytes > 0 && value.compressedBytes <= 256*1048576
        && typeof value.unpackedBytes === 'number' && Number.isSafeInteger(value.unpackedBytes) && value.unpackedBytes > 0 && value.unpackedBytes <= 1024*1048576
        && typeof value.filesCount === 'number' && Number.isSafeInteger(value.filesCount) && value.filesCount > 0 && value.filesCount <= 20000;
}
export function invalidArtifactMetadata(pkg: Pick<IInstallPlanPackage,'config'>): boolean {
    const values = declaredArtifacts(pkg);
    return values !== undefined && (!Array.isArray(values) || values.length < 1 || values.length > 8 || !values.every(artifactMetadata)
        || new Set(values.map(value=>value.target)).size !== values.length);
}
export function packageRuntimeArtifacts(pkg: Pick<IInstallPlanPackage,'config'>): IRuntimeArtifact[] {
    const values = declaredArtifacts(pkg);
    return Array.isArray(values) && !invalidArtifactMetadata(pkg) ? values : [];
}
export function packageNeedsV5(pkg: Pick<IInstallPlanPackage,'config'|'schemaVersion'>): boolean {
    const config = pkg.config;
    return pkg.schemaVersion === 5 || declaredArtifacts(pkg) !== undefined
        || !!(record(config) && record(config.extra) && config.extra.localConfiguration !== undefined);
}

/** Проверяется одобренный комплект, а не изменяемая карточка каталога. Linux libc не угадывается. */
export function runtimeArtifactBlocker(plan: IInstallPlan, device?: IBridgeDevice): string {
    const packages = plan.packages?.length ? plan.packages : [{config:plan.config,schemaVersion:plan.schemaVersion,name:plan.assetId}];
    if (packages.some(invalidArtifactMetadata)) { return 'Пакет содержит некорректное описание готовых зависимостей. Попросите администратора исправить и заново опубликовать комплект.'; }
    const needsV5 = packages.some(packageNeedsV5);
    if (!needsV5) { return ''; }
    if (!device?.report.capabilities?.includes('package-v5')) { return 'Обновите мост до версии 0.9 на странице «Начало работы» для этого комплекта.'; }
    if (packages.some(pkg => hasLocalConfiguration(pkg.config)) && !device.report.capabilities.includes('local-mcp-config-v1')) {
        return 'Обновите мост для локального мастера настройки этого комплекта.';
    }
    for (const pkg of packages) {
        const artifacts = packageRuntimeArtifacts(pkg);
        if (!artifacts.length) { continue; }
        if (!device.report.capabilities.includes('runtime-artifacts-v1')) { return 'Обновите мост для установки готовых зависимостей этого комплекта.'; }
        const target = device.report.runtimeArtifactTarget;
        if (!target || !artifactTargets.includes(target as typeof artifactTargets[number])) { return 'Платформа компьютера ещё не определена. Обновите мост и дождитесь нового подключения.'; }
        if (!artifacts.some(artifact => artifact.target === target)) { return `Для «${pkg.name}» нет готового комплекта под ${target}. Администратор должен опубликовать совместимый артефакт.`; }
    }
    return '';
}
