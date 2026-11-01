export type TPackagingKind = 'mcp' | 'plugin' | 'skill';
export interface IPackagingFile {
    path: string;
    content: string;
    encoding?: 'base64';
}
export type TPackagingSource =
    | { type: 'npm'; specifier: string; entrypoint?: string }
    | { type: 'bundled'; id: string; revision: string }
    | { type: 'files'; files: IPackagingFile[]; entrypoint: string; args?: string[] }
    | {
          type: 'repository';
          url: string;
          ref: string;
          subdirectory?: string;
          entrypoint: string;
          release?: IRepositoryRelease;
      }
    | IUploadedSource;
export interface IToolBuildPublication {
    catalogId: string;
    expectedVersion: number;
    expectedSourceHash: string;
}
export interface IBuildPublicationTargetPreview extends IToolBuildPublication {
    name: string;
    description: string;
    kind: TPackagingKind;
    sourceSummaries: Array<{ repository: string; externalId: string; assetVersion: string }>;
    updateSupported: boolean;
    unsupportedReason?: string;
}
export type TToolPackagingStart = { source: 'files' } | { publication: { catalogId: string; kind: TPackagingKind } };
export interface IToolBuildAgent {
    modelId: string;
    expectedModelPin: string;
    maxAttempts: number;
}
export interface IToolBuildRuntimeVerification {
    schemaVersion: 1;
    status: 'passed' | 'failed' | 'cancelled';
    candidate: {
        identity: string | null;
        sourceDigest: string | null;
        assetId: string | null;
        version: string | number | null;
        manifestSha256: string | null;
    };
    hostTarget: string;
    testedTarget: string | null;
    untestedTargets: string[];
    isolation: { kind: string; osEnforced: boolean; network: 'denied' };
    checks: { integrity: boolean; initialize: boolean; toolsList: boolean; pluginFactory: boolean; hooks: boolean };
    counts: { tools: number; pluginHooks: number };
    diagnostics: Array<{ code: string; message: string }>;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
}
export interface IToolBuildAgentStep {
    attempt: number;
    stage: 'propose' | 'review';
    state: 'STARTED' | 'SUCCEEDED' | 'FAILED';
    recipe?: unknown;
    diagnostics?: unknown;
}
export interface IToolBuildRequest {
    requestKey: string;
    tags?: string[];
    kind: TPackagingKind;
    name: string;
    description: string;
    source: TPackagingSource;
    targets?: string[];
    publication?: IToolBuildPublication;
    agent?: IToolBuildAgent;
}
export interface IBundledBuildRecovery {
    source: { type: 'bundled'; id: string; revision: string };
    targets: string[];
    kind: TPackagingKind;
    name: string;
    description: string;
    tags: string[];
    publication?: { mode: 'replace'; catalogId: string };
}
export interface IToolBuild {
    recovery?: IBundledBuildRecovery;
    id: string;
    operationId: string;
    requestKey: string;
    publicationStartedAt: string | null;
    name?: string;
    state: 'QUEUED' | 'RUNNING' | 'CANCELLING' | 'CANCELLED' | 'SUCCEEDED' | 'FAILED';
    percent: number;
    message: string;
    error?: string;
    runtimeVerification?: IToolBuildRuntimeVerification | null;
    runtimeVerificationAttempt?: number | null;
    agentSteps?: IToolBuildAgentStep[];
    result?: {
        catalogId: string;
        name: string;
        version: number;
        kind?: TPackagingKind;
        assetId?: string;
        sourceVersion?: string;
        sourceSha256?: string;
    };
}
export interface IRepositoryRelease {
    tag: string;
    asset?: string;
    id?: number;
    assetId?: number;
    sha256?: string;
}
export interface ISourceDetection {
    requiresEntrypointChoice?: boolean;
    runnableKinds?: TPackagingKind[];
    warnings?: string[];
}
export interface INpmPackageMetadata extends ISourceDetection {
    package: string;
    version: string;
    specifier: string;
    entrypoint: string;
    candidates: string[];
    description: string;
    recommendedKind?: TPackagingKind;
    supportedTargets?: string[];
}
export interface IRepositoryQuery {
    url: string;
    ref?: string;
    subdirectory?: string;
    entrypoint?: string;
    release?: IRepositoryRelease;
}
export type TRepositoryAdapter = 'python' | 'java' | 'dotnet' | 'go' | 'rust' | 'native';
export interface IRepositoryMetadata extends ISourceDetection {
    url: string;
    commit: string;
    ref: string;
    subdirectory?: string;
    entrypoint: string;
    candidates: string[];
    name: string;
    description: string;
    recommendedKind?: TPackagingKind;
    release?: IRepositoryRelease;
    requiresReleaseChoice?: boolean;
    releaseChoices?: Array<{ id: number; name: string; bytes: number; format: 'tar.gz' | 'zip' | 'file' }>;
    adapter?: TRepositoryAdapter;
    preparedAdapter?: 'opencode-rag-plugin';
    preparedVersion?: string;
    supportedTargets?: string[];
}
import type { IUploadedSource } from './uploadInterfaces';
