import { publicationHash } from '../publication/publication-validation';
import type { AssetKind, ResolvedAsset } from '@neurocenter/asset-contract';
import type { IAiPluginCreate } from '../catalog/dto';
import type { IAssetBlob } from './asset-blob-store';
import type { IAssetSourcePin } from './source-client';

export type TImportState = 'QUEUED' | 'RUNNING' | 'NEEDS_INPUT' | 'PARTIAL' | 'FAILED' | 'SUCCEEDED' | 'CANCELLED';
export interface INativeAssetPin {
    kind: AssetKind;
    id: string;
    version: number;
    hash: string;
    manifest?: string;
}
export interface ISourceReceipt {
    repository: string;
    external_id: string;
    asset_kind: AssetKind;
    asset_version: string;
    descriptor_sha256: string;
    source_commit: string | null;
    origin?: 'repository' | 'local-archive';
    active?: boolean;
    revision?: number;
    native_id: string;
    native_version: number;
    native_hash: string;
    native_manifest?: string;
    descriptor: ResolvedAsset['asset'];
    blobs: IAssetBlob[];
}
export interface IImportItem {
    resolved: ResolvedAsset;
    requestKey: string;
    name: string;
    action: 'create' | 'update' | 'snapshot' | 'unchanged' | 'conflict';
    preserveHead?: boolean;
    replaceable?: boolean;
    replacesLocal?: boolean;
    originReceipts?: Array<{ repository: string; externalId: string; revision: number }>;
    reason?: string;
    native?: INativeAssetPin;
    expected?: INativeAssetPin;
    publication?: IAiPluginCreate;
    payload?: Record<string, unknown>;
    state: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    message?: string;
}
export interface IImportJob {
    id: string;
    actor: string;
    request_key: string;
    request_hash: string;
    source: IAssetSourcePin;
    selected_ids: string[];
    replacement_hashes: Record<string, string>;
    replacement_origins: Record<string, NonNullable<IImportItem['originReceipts']>>;
    state: TImportState;
    items: IImportItem[];
    message: string;
    cancel_requested: boolean;
    created_at: string | Date;
    updated_at: string | Date;
    bridge_source_revision?: number | null;
    cache_only?: boolean;
}

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
