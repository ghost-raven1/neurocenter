export type PackagingKind = 'mcp' | 'plugin' | 'skill';
export interface PackagingFile { path: string; content: string; encoding?:'base64' }
export type PackagingSource = { type: 'npm'; specifier: string; entrypoint?: string }
    | { type: 'files'; files: PackagingFile[]; entrypoint: string; args?: string[] }
    | { type: 'repository'; url: string; ref: string; subdirectory?: string; entrypoint: string; release?: RepositoryRelease }
    | UploadedSource;
export interface ToolBuildRequest {
    requestKey: string; kind: PackagingKind; name: string; description: string; source: PackagingSource;
}
export interface ToolBuild {
    id: string; operationId: string; name?: string; state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    percent: number; message: string; error?: string;
    result?: { catalogId: string; name: string; version: number; kind?: PackagingKind; assetId?: string; sourceVersion?: string; sourceSha256?: string };
}
export interface RepositoryRelease { tag: string; asset?: string; id?: number; assetId?: number; sha256?: string }
export interface SourceDetection { requiresEntrypointChoice?: boolean; runnableKinds?: PackagingKind[]; warnings?: string[] }
export interface NpmPackageMetadata extends SourceDetection {
    package: string; version: string; specifier: string; entrypoint: string;
    candidates: string[]; description: string;
    recommendedKind?: PackagingKind; supportedTargets?: string[];
}
export interface RepositoryQuery { url: string; ref?: string; subdirectory?: string; entrypoint?: string; release?: RepositoryRelease }
export type RepositoryAdapter = 'python' | 'java' | 'dotnet' | 'go' | 'rust' | 'native';
export interface RepositoryMetadata extends SourceDetection {
    url: string; commit: string; ref: string; subdirectory?: string; entrypoint: string;
    candidates: string[]; name: string; description: string; recommendedKind?: PackagingKind;
    release?: RepositoryRelease; requiresReleaseChoice?: boolean;
    releaseChoices?: Array<{ id: number; name: string; bytes: number; format: 'tar.gz' | 'zip' | 'file' }>;
    adapter?: RepositoryAdapter; preparedAdapter?: 'opencode-rag-plugin'; preparedVersion?: string; supportedTargets?: string[];
}
import type {UploadedSource} from './uploadTypes';
