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
