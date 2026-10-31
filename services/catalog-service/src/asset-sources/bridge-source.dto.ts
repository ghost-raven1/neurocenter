export interface IBridgeSourceSave {
    url: string;
    expectedRevision: number;
}
export interface IBridgeSourceCheck {
    expectedRevision: number;
    force?: boolean;
}
export interface IBridgeSourceImport {
    expectedRevision: number;
    commit: string;
    assetId: string;
    requestKey: string;
}
export interface IBridgeSourceRelease {
    assetId: string;
    version: string;
    buildId: string;
    repositoryCommit: string;
    targets: string[];
    repositoryUrl?: string;
}
export interface IBridgeSourceView {
    sourceMode: 'online' | 'offline';
    url: string;
    revision: number;
    checkedAt?: string;
    error?: string;
    available?: IBridgeSourceRelease;
    imported?: IBridgeSourceRelease;
    importedError?: string;
    sourceReady?: boolean;
    archiveRequired?: boolean;
}
