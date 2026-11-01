import { publicationHash } from '../publication/publication-validation';
import type { IImportJob } from './import-interfaces';

export const importPlanDigest = (job: IImportJob): string =>
    publicationHash({
        source: job.source,
        selected: job.selected_ids,
        items: job.items.map((item) => ({
            id: item.resolved.asset.id,
            version: item.resolved.asset.version,
            sha256: item.resolved.sha256,
            action: item.action,
            expected: item.expected,
            origins: item.originReceipts,
        })),
    });

/** Публичное состояние не содержит исходников, локальных путей или upstream URL доставки. */
export function importView(job: IImportJob) {
    return {
        id: job.id,
        state: job.state,
        message: job.message,
        source: { repository: job.source.repository, commit: job.source.commit },
        planDigest: importPlanDigest(job),
        selectedIds: job.selected_ids,
        cancelRequested: job.cancel_requested,
        updatedAt: new Date(job.updated_at).toISOString(),
        items: job.items.map((item) => ({
            id: item.resolved.asset.id,
            kind: item.resolved.asset.kind,
            version: item.resolved.asset.version,
            current: item.resolved.current,
            name: item.name,
            action: item.action,
            state: item.state,
            reason: item.reason,
            message: item.message,
            native: item.native,
            ...(item.publication && item.publication.name !== item.name ? { catalogName: item.publication.name } : {}),
            replacement:
                item.replaceable && item.expected
                    ? { id: item.expected.id, version: item.expected.version, hash: item.expected.hash }
                    : undefined,
            dependencies: (item.resolved.asset.dependencies ?? []).map(({ id, version }) => ({ id, version })),
            bytes:
                item.resolved.asset.kind === 'mcp' || item.resolved.asset.kind === 'plugin'
                    ? item.resolved.asset.delivery.artifacts.reduce(
                          (sum, file) => sum + file.descriptor.compressedBytes,
                          0,
                      )
                    : undefined,
        })),
    };
}
