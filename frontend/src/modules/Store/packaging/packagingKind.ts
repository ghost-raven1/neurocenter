import type { TPackagingKind, TRepositoryAdapter } from './interfaces';

/** Готовые поставки запускаются как MCP; для JS рекомендация уважает явный выбор. */
export function packagingKind(
    current: TPackagingKind,
    metadata: { recommendedKind?: TPackagingKind; adapter?: TRepositoryAdapter } | undefined,
    explicit: boolean,
): TPackagingKind {
    if (metadata?.adapter) return 'mcp';
    return !explicit && metadata?.recommendedKind ? metadata.recommendedKind : current;
}
