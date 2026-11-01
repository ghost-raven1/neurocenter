import { validateBundledBuildSource } from '../../../shared/bundled-catalog.cjs';
import type { IBuildConfiguration } from './package-build.model';

/** Return only a validated bundled identity; legacy and unrelated sources have no recovery hint. */
export function bundledRecoverySource(source: unknown) {
    try {
        return validateBundledBuildSource(source);
    } catch {
        return undefined;
    }
}

/** Restoring input never restores publication consent or exposes raw sources and execution settings. */
export function buildRecovery(config: IBuildConfiguration) {
    const source = bundledRecoverySource(config?.source);
    if (!source) return undefined;
    return {
        source,
        targets: [...config.targets],
        kind: config.kind,
        name: config.name,
        description: config.description,
        tags: [...config.tags],
        ...(config.publication
            ? { publication: { mode: 'replace' as const, catalogId: config.publication.catalogId } }
            : {}),
    };
}
