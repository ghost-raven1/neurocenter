import type { TRepositoryAdapter } from './interfaces';

export interface ISourceUploadIntent {
    requestKey: string;
    name: string;
    sha256: string;
    bytes: number;
}

export interface IUploadedSource {
    type: 'upload';
    uploadId: string;
    sha256: string;
    bytes: number;
    entrypoint: string;
}

export interface ISourceUploadMetadata {
    candidates: string[];
    entrypoint: string;
    requiresEntrypointChoice: boolean;
    runnableKinds: ['mcp'];
    adapter?: TRepositoryAdapter;
    supportedTargets?: string[];
    name?: string;
    description?: string;
    choices: Array<{ entrypoint: string; adapter: TRepositoryAdapter; targets: string[]; runtimeEntrypoint?: string }>;
}

export interface ISourceUpload {
    id: string;
    requestKey: string;
    name: string;
    sha256: string;
    bytes: number;
    state: 'WAITING' | 'UPLOADING' | 'READY' | 'CANCELLED';
    expiresAt: string;
    metadata?: ISourceUploadMetadata;
}
