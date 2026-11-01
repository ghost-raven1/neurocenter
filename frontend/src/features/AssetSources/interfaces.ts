export type TSourceAssetKind = 'mcp' | 'plugin' | 'skill' | 'model' | 'bridge' | 'agent';

export interface ISourceAsset {
    id: string;
    kind: TSourceAssetKind;
    name: string;
    description?: string;
    version: string;
    sha256: string;
    license: string;
    dependencies: Array<{ id: string; version: string }>;
    supply?: { ready: boolean; missingFiles: number; missingBytes: number };
    imported?: {
        id: string;
        name?: string;
        version: number;
        originVersion: string;
        updateAvailable: boolean;
        archived?: boolean;
        unavailable?: boolean;
    };
}

export interface IBundledSourcePlan {
    id: string;
    kind: 'mcp' | 'plugin' | 'model' | 'bridge';
    name: string;
    description: string;
    sourceRevision: string;
    revision: string;
    delivery: string;
    catalogReady?: boolean;
    imported?: ISourceAsset['imported'];
}

export interface ICatalogRebuildItem {
    id: string;
    name: string;
    state: 'ready' | 'pending' | 'attention' | 'archive-required';
    message: string;
    operationId?: string;
    importId?: string;
    catalogId?: string;
}

export interface ICatalogRebuild {
    requestId: string;
    sourceRevision: string;
    requestedAt: string;
    updatedAt: string;
    state: 'preparing' | 'ready' | 'attention';
    items: ICatalogRebuildItem[];
    message?: string;
}

export interface ISourceList {
    source: {
        repository: string;
        mode?: 'online' | 'offline' | 'bundled';
        archiveSha256?: string;
        commit?: string;
        checkedAt?: string;
        verified: boolean;
        error?: string;
        lastAttemptAt?: string;
    };
    assets: ISourceAsset[];
    localAssets?: ISourceAsset[];
    sourcePlans?: IBundledSourcePlan[];
    rebuild?: ICatalogRebuild;
}

/** rejected подтверждает отказ свежего POST до создания job; отсутствие признака сохраняет неизвестный исход. */
export interface IImportIntent {
    requestKey: string;
    commit: string;
    ids: string[];
    jobId?: string;
    rejected?: true;
}

export interface IAssetImport {
    id: string;
    planDigest: string;
    state: string;
    message: string;
    cancelRequested?: boolean;
    items: Array<{
        id: string;
        kind: TSourceAssetKind;
        name: string;
        catalogName?: string;
        version: string;
        current: boolean;
        action: string;
        state: string;
        reason?: string;
        message?: string;
        replacement?: { id: string; version: number; hash: string };
    }>;
}
