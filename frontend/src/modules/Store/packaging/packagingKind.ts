import type { PackagingKind, RepositoryAdapter } from './types';

/** Готовые поставки запускаются как MCP; для JS рекомендация уважает явный выбор. */
export function packagingKind(current: PackagingKind, metadata: { recommendedKind?: PackagingKind; adapter?: RepositoryAdapter } | undefined, explicit: boolean): PackagingKind {
    if (metadata?.adapter) return 'mcp';
    return !explicit && metadata?.recommendedKind ? metadata.recommendedKind : current;
}
