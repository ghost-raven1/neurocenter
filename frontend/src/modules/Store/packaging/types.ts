export type PackagingKind = 'mcp' | 'plugin';
export interface PackagingFile { path: string; content: string }
export type PackagingSource = { type: 'npm'; specifier: string }
    | { type: 'files'; files: PackagingFile[]; entrypoint: string; args?: string[] }
    | { type: 'repository'; url: string; ref: string; subdirectory?: string; entrypoint: string };
export interface ToolBuildRequest {
    requestKey: string; kind: PackagingKind; name: string; description: string; source: PackagingSource;
}
export interface ToolBuild {
    id: string; operationId: string; name?: string; state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    percent: number; message: string; error?: string;
    result?: { catalogId: string; name: string; version: number };
}
export interface NpmPackageMetadata {
    package: string; version: string; specifier: string; entrypoint: string;
    candidates: string[]; description: string;
    recommendedKind?: PackagingKind; supportedTargets?: string[];
}
export interface RepositoryQuery { url: string; ref?: string; subdirectory?: string; entrypoint?: string }
export type RepositoryAdapter = 'python' | 'java' | 'dotnet' | 'go' | 'rust' | 'native';
export interface RepositoryMetadata {
    url: string; commit: string; ref: string; subdirectory?: string; entrypoint: string;
    candidates: string[]; name: string; description: string; recommendedKind?: PackagingKind;
    adapter?: RepositoryAdapter; preparedAdapter?: 'opencode-rag-plugin'; preparedVersion?: string; supportedTargets?: string[];
}
