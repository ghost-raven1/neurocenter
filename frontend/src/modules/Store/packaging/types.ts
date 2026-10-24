export type PackagingKind = 'mcp' | 'plugin' | 'skill';
export interface PackagingFile { path: string; content: string; encoding?:'base64' }
export type PackagingSource = { type: 'npm'; specifier: string; entrypoint?: string }
    | { type: 'files'; files: PackagingFile[]; entrypoint: string; args?: string[] }
    | { type: 'repository'; url: string; ref: string; subdirectory?: string; entrypoint: string; release?: RepositoryRelease }
    | UploadedSource;
export interface ToolBuildPublication { catalogId: string; expectedVersion: number; expectedSourceHash: string }
export interface BuildPublicationTargetPreview extends ToolBuildPublication {
    name: string; description: string; kind: PackagingKind;
    sourceSummaries: Array<{repository:string;externalId:string;assetVersion:string}>;
    updateSupported: boolean; unsupportedReason?: string;
}
export type ToolPackagingStart = {source:'files'} | {publication:{catalogId:string;kind:PackagingKind}};
export interface ToolBuildAgent { modelId: string; expectedModelPin: string; maxAttempts: number }
export interface ToolBuildRuntimeVerification {
    schemaVersion: 1; status: 'passed' | 'failed' | 'cancelled';
    candidate: {identity: string | null; sourceDigest: string | null; assetId: string | null; version: string | number | null; manifestSha256: string | null};
    hostTarget: string; testedTarget: string | null; untestedTargets: string[];
    isolation: {kind: string; osEnforced: boolean; network: 'denied'};
    checks: {integrity: boolean; initialize: boolean; toolsList: boolean; pluginFactory: boolean; hooks: boolean};
    counts: {tools: number; pluginHooks: number}; diagnostics: Array<{code: string; message: string}>;
    startedAt: string; finishedAt: string; durationMs: number;
}
export interface ToolBuildAgentStep { attempt: number; stage: 'propose' | 'review'; state: 'STARTED' | 'SUCCEEDED' | 'FAILED'; recipe?: unknown; diagnostics?: unknown }
export interface ToolBuildRequest {
    requestKey: string; kind: PackagingKind; name: string; description: string; source: PackagingSource; targets?: string[]; publication?: ToolBuildPublication; agent?: ToolBuildAgent;
}
export interface ToolBuild {
    id: string; operationId: string; requestKey: string; publicationStartedAt: string | null;
    name?: string; state: 'QUEUED' | 'RUNNING' | 'CANCELLING' | 'CANCELLED' | 'SUCCEEDED' | 'FAILED';
    percent: number; message: string; error?: string;
    runtimeVerification?: ToolBuildRuntimeVerification | null; runtimeVerificationAttempt?: number | null; agentSteps?: ToolBuildAgentStep[];
    result?: { catalogId: string; name: string; version: number; kind?: PackagingKind; assetId?: string; sourceVersion?: string; sourceSha256?: string };
}
export interface ToolBuildRequestCancellation { requestKey: string; state: ToolBuild['state']; build: ToolBuild | null }
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
