import type { IRuntimeSource, TRuntimeTarget } from './tool-runtime-source.cjs';
export interface IRepositoryRelease {
    tag: string;
    asset?: string;
    id?: number;
    assetId?: number;
    sha256?: string;
}
export interface IReleaseAsset {
    id: number;
    name: string;
    bytes: number;
    url: string;
    format: 'tar.gz' | 'zip' | 'file';
    sha256?: string;
}
export interface IReleaseInspection {
    sha256: string;
    entrypoint: string;
    candidates: string[];
    name?: string;
    runtimeSource?: IRuntimeSource;
    warnings?: string[];
    executableChoices?: Array<{
        entrypoint: string;
        runtimeEntrypoint?: string;
        adapter: string;
        targets: TRuntimeTarget[];
    }>;
}
export type TReleaseInspector = (asset: IReleaseAsset, entrypoint?: string) => Promise<IReleaseInspection>;
export function validateReleaseInput(value: unknown): IRepositoryRelease;
/** Разрешает тег релиза в подтверждённый commit, файлы и (по выбору) проверенную поставку. */
export function resolveGithubRelease(request: {
    source: { url: string; ref?: string; release: IRepositoryRelease; entrypoint?: string };
    parsed: { owner?: string; repository?: string };
    repository: { name?: string; description?: string };
    base: string;
    fetcher: (url: string) => Promise<unknown>;
    githubJson: (fetcher: (url: string) => Promise<unknown>, url: string) => Promise<unknown>;
    inspectAsset: TReleaseInspector;
}): Promise<{
    url: string;
    commit: string;
    ref: string;
    entrypoint: string;
    candidates: string[];
    name: string;
    description: string;
    release: { tag: string; id: number };
    releaseChoices: Array<Omit<IReleaseAsset, 'url' | 'sha256'>>;
    runnableKinds: string[];
    requiresReleaseChoice?: boolean;
    warnings?: string[];
    requiresEntrypointChoice?: boolean;
    recommendedKind?: string;
    runtimeSource?: IRuntimeSource;
    adapter?: string;
    supportedTargets?: string[];
}>;
