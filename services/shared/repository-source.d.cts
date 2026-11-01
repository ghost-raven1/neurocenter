import type { IRepositoryRelease, TReleaseInspector } from './github-release-source.cjs';
import type { TRuntimeAdapter, IRuntimeSource, TRuntimeTarget } from './tool-runtime-source.cjs';
export interface IRepositoryInput {
    type: 'repository';
    url: string;
    ref?: string;
    subdirectory?: string;
    entrypoint?: string;
    release?: IRepositoryRelease;
}
export interface IRepositorySource {
    type: 'repository';
    url: string;
    commit: string;
    subdirectory?: string;
    entrypoint: string;
    runtimeSource?: IRuntimeSource;
    manifestSha256?: string;
    release?: IRepositoryRelease;
    snapshotSha256?: string;
}
export interface IRepositoryManifest {
    schemaVersion: 1;
    name?: string;
    description?: string;
    source: IRuntimeSource;
}
export interface IParsedRepository {
    url: string;
    owner: string;
    repository: string;
    ref?: string;
    subdirectory?: string;
    entrypoint?: string;
    release?: IRepositoryRelease;
}
export interface IResolvedRepository {
    url: string;
    commit: string;
    ref: string;
    subdirectory?: string;
    entrypoint: string;
    candidates: string[];
    name: string;
    description: string;
    recommendedKind?: 'mcp' | 'plugin' | 'skill';
    adapter?: TRuntimeAdapter;
    preparedAdapter?: 'opencode-rag-plugin';
    preparedVersion?: string;
    supportedTargets?: TRuntimeTarget[];
    runtimeSource?: IRuntimeSource;
    manifestSha256?: string;
    snapshotSha256?: string;
    release?: IRepositoryRelease;
    releaseChoices?: Array<{ id: number; name: string; bytes: number; format: 'tar.gz' | 'zip' | 'file' }>;
    requiresReleaseChoice?: boolean;
    requiresEntrypointChoice?: boolean;
    runnableKinds?: Array<'mcp' | 'plugin' | 'skill'>;
    warnings?: string[];
}
export function parseRepositoryUrl(
    url: unknown,
    options?: { ref?: string; subdirectory?: string; entrypoint?: string },
): IParsedRepository;
export function validateRepositorySource(value: unknown, options?: { pinned?: true }): IRepositorySource;
export function validateRepositorySource(value: unknown, options: { pinned: false }): IRepositoryInput;
export function validateRepositoryManifest(value: Buffer | string): IRepositoryManifest;
export const normalizeRepositorySource: typeof validateRepositorySource;
export function resolveRepositorySource(
    input: Omit<IRepositoryInput, 'type'> | IRepositoryInput,
    options?: {
        fetch?: typeof fetch;
        metadata?: boolean;
        inspectSkill?: (files: Array<{ path: string; content: string }>) => { name: string; description: string };
        inspectAsset?: TReleaseInspector;
        inspectRepository?: (
            source: Pick<IRepositorySource, 'type' | 'url' | 'commit' | 'subdirectory'>,
            entrypoint?: string,
        ) => Promise<Partial<IResolvedRepository>>;
    },
): Promise<IResolvedRepository>;
